import {
  apiErrorSchema,
  dealSchema,
  feeSignatureSchema,
  lenderSchema,
  pageSchema,
  quoteSchema,
  type ApiFailure,
  type ApiResult,
  type DealDto,
  type DealPageDto,
  type FeeSignatureDto,
  type FeeSignatureEditDto,
  type LenderDto,
  type QuoteCreateDto,
  type QuoteDto,
} from '@swyft/contracts';
import { z } from 'zod';
import {
  OfflineError,
  UnauthorizedError,
  type FetchLike,
} from '../auth/api-client';

/** A definite API answer that is not a success; `failure` is safe to show. */
export class ApiRequestError extends Error {
  constructor(readonly failure: ApiFailure) {
    super(failure.message);
    this.name = 'ApiRequestError';
  }
}

/** Runs a call with a fresh access token (refresh-once-on-401 lives in the session manager). */
export type WithAccessToken = <T>(
  call: (accessToken: string) => Promise<T>,
) => Promise<T>;

const requestTimeoutMs = 20_000;
const itemsSchema = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item) });
const deletedSchema = z.strictObject({ deleted: z.number().int().min(0) });

const serverProblem =
  'The Swyft service had a problem. Nothing was changed; try again in a moment.';

/** Logo limit enforced by the API (PNG, JPEG or WebP, at most 512 KB). */
export const maxLogoBytes = 512 * 1024;

/** Identifies an image by its signature bytes; the file name and claimed type are ignored. */
export function sniffLogoType(
  bytes: Uint8Array,
): 'image/png' | 'image/jpeg' | 'image/webp' | undefined {
  const starts = (...values: number[]) =>
    values.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return 'image/webp';
  return undefined;
}

function failureFor(status: number, body: unknown): ApiFailure {
  const parsed = apiErrorSchema.safeParse(body);
  const error = parsed.success ? parsed.data.error : undefined;
  if (status >= 500 || error === undefined)
    return {
      kind: 'server',
      message:
        status === 503
          ? 'The Swyft service is temporarily unavailable. Try again shortly.'
          : serverProblem,
    };
  switch (error.code) {
    case 'VALIDATION_FAILED':
      return {
        kind: 'validation',
        message: error.message,
        ...(error.fields && { fields: error.fields }),
      };
    case 'NOT_FOUND':
      return { kind: 'not-found', message: error.message };
    case 'CONFLICT':
      return { kind: 'conflict', message: error.message };
    case 'RATE_LIMITED':
      return {
        kind: 'rate-limited',
        message: 'Too many requests. Wait a moment and try again.',
      };
    default:
      return { kind: 'invalid-request', message: error.message };
  }
}

/**
 * Main-process client for the authenticated `/v1` business routes. The Renderer never
 * sees tokens or raw responses: every response is validated with the shared contracts
 * and failures become typed `ApiFailure`s.
 */
export class BusinessApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly withAccessToken: WithAccessToken,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  listDeals(cursor?: string): Promise<DealPageDto> {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor !== undefined) query.set('cursor', cursor);
    return this.request('GET', `/v1/deals?${query}`, pageSchema(dealSchema));
  }

  createDeal(name: string): Promise<DealDto> {
    return this.request('POST', '/v1/deals', dealSchema, { name });
  }

  renameDeal(dealId: string, name: string): Promise<DealDto> {
    return this.request('PATCH', `/v1/deals/${dealId}`, dealSchema, { name });
  }

  async deleteDeal(dealId: string): Promise<null> {
    await this.request('DELETE', `/v1/deals/${dealId}`, null);
    return null;
  }

  async listQuotes(dealId: string): Promise<readonly QuoteDto[]> {
    const page = await this.request(
      'GET',
      `/v1/deals/${dealId}/quotes`,
      itemsSchema(quoteSchema),
    );
    return page.items;
  }

  saveQuote(
    dealId: string,
    idempotencyKey: string,
    request: QuoteCreateDto,
  ): Promise<QuoteDto> {
    return this.request(
      'POST',
      `/v1/deals/${dealId}/quotes`,
      quoteSchema,
      request,
      { 'idempotency-key': idempotencyKey },
    );
  }

  updateQuoteNotes(quoteId: string, notes: string): Promise<QuoteDto> {
    return this.request('PATCH', `/v1/quotes/${quoteId}`, quoteSchema, {
      notes,
    });
  }

  async deleteQuote(quoteId: string): Promise<null> {
    await this.request('DELETE', `/v1/quotes/${quoteId}`, null);
    return null;
  }

  clearQuotes(dealId: string): Promise<{ deleted: number }> {
    return this.request('DELETE', `/v1/deals/${dealId}/quotes`, deletedSchema);
  }

  async listLenders(): Promise<readonly LenderDto[]> {
    return (await this.request('GET', '/v1/lenders', itemsSchema(lenderSchema)))
      .items;
  }

  createLender(input: {
    name: string;
    websiteUrl: string | null;
  }): Promise<LenderDto> {
    return this.request('POST', '/v1/lenders', lenderSchema, input);
  }

  updateLender(
    lenderId: string,
    patch: {
      name?: string | undefined;
      websiteUrl?: string | null | undefined;
    },
  ): Promise<LenderDto> {
    return this.request(
      'PATCH',
      `/v1/lenders/${lenderId}`,
      lenderSchema,
      patch,
    );
  }

  async deleteLender(lenderId: string): Promise<null> {
    await this.request('DELETE', `/v1/lenders/${lenderId}`, null);
    return null;
  }

  /** The logo as a data URL the Renderer can display (its CSP allows only `data:` images). */
  lenderLogo(lenderId: string): Promise<{ dataUrl: string }> {
    return this.send(
      'GET',
      `/v1/lenders/${lenderId}/logo`,
      { headers: { accept: 'image/png, image/jpeg, image/webp' } },
      async (response) => {
        const bytes = new Uint8Array(await response.arrayBuffer());
        const type = sniffLogoType(bytes);
        if (type === undefined || bytes.byteLength > maxLogoBytes)
          throw new ApiRequestError({ kind: 'server', message: serverProblem });
        return {
          dataUrl: `data:${type};base64,${Buffer.from(bytes).toString('base64')}`,
        };
      },
    );
  }

  putLenderLogo(lenderId: string, bytes: Uint8Array): Promise<LenderDto> {
    const type = sniffLogoType(bytes);
    if (type === undefined)
      return Promise.reject(
        new ApiRequestError({
          kind: 'validation',
          message: 'Choose a PNG, JPEG or WebP image.',
        }),
      );
    if (bytes.byteLength > maxLogoBytes)
      return Promise.reject(
        new ApiRequestError({
          kind: 'validation',
          message: 'The logo must be 512 KB or smaller.',
        }),
      );
    return this.send(
      'PUT',
      `/v1/lenders/${lenderId}/logo`,
      { headers: { 'content-type': type }, body: Uint8Array.from(bytes) },
      async (response) => {
        const parsed = lenderSchema.safeParse(
          await response.json().catch(() => undefined),
        );
        if (!parsed.success)
          throw new ApiRequestError({ kind: 'server', message: serverProblem });
        return parsed.data;
      },
    );
  }

  async deleteLenderLogo(lenderId: string): Promise<null> {
    await this.request('DELETE', `/v1/lenders/${lenderId}/logo`, null);
    return null;
  }

  async listFeeSignatures(): Promise<readonly FeeSignatureDto[]> {
    return (
      await this.request(
        'GET',
        '/v1/fee-signatures',
        itemsSchema(feeSignatureSchema),
      )
    ).items;
  }

  copyFeeSignature(sourceId: string, name?: string): Promise<FeeSignatureDto> {
    return this.request('POST', '/v1/fee-signatures', feeSignatureSchema, {
      copyFromId: sourceId,
      ...(name !== undefined && { name }),
    });
  }

  updateFeeSignature(
    signatureId: string,
    definition: FeeSignatureEditDto,
  ): Promise<FeeSignatureDto> {
    return this.request(
      'PUT',
      `/v1/fee-signatures/${signatureId}`,
      feeSignatureSchema,
      definition,
    );
  }

  async deleteFeeSignature(signatureId: string): Promise<null> {
    await this.request('DELETE', `/v1/fee-signatures/${signatureId}`, null);
    return null;
  }

  private request<T extends z.ZodType>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    schema: T,
    body?: unknown,
    headers?: Readonly<Record<string, string>>,
  ): Promise<z.output<T>>;
  private request(
    method: 'DELETE',
    path: string,
    schema: null,
  ): Promise<undefined>;
  private request(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    schema: z.ZodType | null,
    body?: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    return this.send(
      method,
      path,
      body === undefined
        ? { headers }
        : {
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(body),
          },
      async (response) => {
        if (schema === null) return undefined;
        const parsed = schema.safeParse(
          await response.json().catch(() => undefined),
        );
        if (!parsed.success)
          throw new ApiRequestError({ kind: 'server', message: serverProblem });
        return parsed.data;
      },
    );
  }

  /**
   * One authenticated round trip: bearer token, timeout, no redirects, 401 → refresh via
   * the session manager, other failures → `ApiRequestError`. `read` runs only on success.
   */
  private send<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    init: {
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string | Uint8Array<ArrayBuffer>;
    },
    read: (response: Response) => Promise<T>,
  ): Promise<T> {
    return this.withAccessToken(async (accessToken) => {
      let response: Response;
      try {
        response = await this.fetchImpl(new URL(path, this.baseUrl).href, {
          method,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${accessToken}`,
            ...init.headers,
          },
          ...(init.body === undefined ? {} : { body: init.body }),
          signal: AbortSignal.timeout(requestTimeoutMs),
          redirect: 'error',
        });
      } catch {
        throw new OfflineError();
      }
      // The session manager refreshes once and retries on this error.
      if (response.status === 401) throw new UnauthorizedError();
      if (!response.ok)
        throw new ApiRequestError(
          failureFor(
            response.status,
            await response.json().catch(() => undefined),
          ),
        );
      return read(response);
    });
  }
}

/** Converts any outcome into IPC-safe data; nothing thrown crosses the bridge. */
export async function toApiResult<T>(
  operation: () => Promise<T>,
): Promise<ApiResult<T>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    if (error instanceof ApiRequestError)
      return { ok: false, error: error.failure };
    if (error instanceof UnauthorizedError)
      return {
        ok: false,
        error: {
          kind: 'unauthenticated',
          message: 'Your session has ended. Sign in again.',
        },
      };
    if (error instanceof OfflineError)
      return {
        ok: false,
        error: {
          kind: 'offline',
          message:
            'You appear to be offline. Check your connection and try again.',
        },
      };
    return { ok: false, error: { kind: 'server', message: serverProblem } };
  }
}
