import { describe, expect, it, vi } from 'vitest';
import { dealFixture, quoteFixture } from '../../test-support/fixtures';
import {
  OfflineError,
  UnauthorizedError,
  type FetchLike,
} from '../auth/api-client';
import {
  BusinessApiClient,
  maxLogoBytes,
  sniffLogoType,
  toApiResult,
} from './business-api';

const baseUrl = 'https://api.example.test';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Passes a fixed token; the real session manager adds refresh-on-401. */
const withToken = <T>(call: (token: string) => Promise<T>) => call('access-1');

describe('BusinessApiClient', () => {
  it('sends the bearer token and validates the response', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      json(200, { items: [dealFixture()], nextCursor: null }),
    );
    const api = new BusinessApiClient(baseUrl, withToken, fetchImpl);
    const page = await api.listDeals();
    expect(page.items[0]?.name).toBe(dealFixture().name);
    const [url, init] = fetchImpl.mock.calls[0] ?? ['', {}];
    expect(url).toBe(`${baseUrl}/v1/deals?limit=100`);
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer access-1',
    );
    expect(init.redirect).toBe('error');
  });

  it('sends the idempotency key with a quote save', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json(201, quoteFixture()));
    const api = new BusinessApiClient(baseUrl, withToken, fetchImpl);
    await api.saveQuote(quoteFixture().dealId, 'key-12345678', {
      feeSignatureId: quoteFixture().feeSignatureId ?? '',
      financeAmount: '30000',
      termMonths: 60,
      baseRate: '0.085',
    });
    const init = fetchImpl.mock.calls[0]?.[1] ?? {};
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe(
      'key-12345678',
    );
    expect(init.method).toBe('POST');
  });

  it('maps API validation errors to field messages', async () => {
    const api = new BusinessApiClient(baseUrl, withToken, async () =>
      json(400, {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Some fields are invalid.',
          requestId: 'r1',
          fields: { commissionRate: 'Commission cannot exceed 6%.' },
        },
      }),
    );
    const result = await toApiResult(() => api.createDeal('x'));
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'validation',
        message: 'Some fields are invalid.',
        fields: { commissionRate: 'Commission cannot exceed 6%.' },
      },
    });
  });

  it.each([
    [500, 'server'],
    [503, 'server'],
    [404, 'not-found'],
    [409, 'conflict'],
    [429, 'rate-limited'],
  ] as const)('maps HTTP %i to %s', async (status, kind) => {
    const api = new BusinessApiClient(baseUrl, withToken, async () =>
      json(status, {
        error: {
          code:
            status === 404
              ? 'NOT_FOUND'
              : status === 409
                ? 'CONFLICT'
                : status === 429
                  ? 'RATE_LIMITED'
                  : 'INTERNAL_ERROR',
          message: 'x',
          requestId: 'r',
        },
      }),
    );
    const result = await toApiResult(() => api.deleteQuote(quoteFixture().id));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe(kind);
      // 5xx text never echoes the server's message.
      if (status >= 500) expect(result.error.message).not.toBe('x');
    }
  });

  it('treats a network failure as offline without leaking details', async () => {
    const api = new BusinessApiClient(baseUrl, withToken, async () => {
      throw new TypeError('getaddrinfo ENOTFOUND api.example.test');
    });
    const result = await toApiResult(() => api.listQuotes(dealFixture().id));
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'offline',
        message: expect.stringContaining('offline') as unknown as string,
      },
    });
    expect(JSON.stringify(result)).not.toContain('ENOTFOUND');
  });

  it('rejects a malformed success response as a server problem', async () => {
    const api = new BusinessApiClient(baseUrl, withToken, async () =>
      json(200, { items: [{ id: 'not-a-deal' }], nextCursor: null }),
    );
    const result = await toApiResult(() => api.listDeals());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('server');
  });

  it('lets the session manager refresh on 401 and retry once', async () => {
    const tokens: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const token = (init.headers as Record<string, string>).authorization;
      tokens.push(token ?? '');
      return token === 'Bearer stale'
        ? json(401, {
            error: { code: 'UNAUTHENTICATED', message: 'x', requestId: 'r' },
          })
        : json(200, { deleted: 2 });
    });
    // Mirrors AuthSessionManager.withAccessToken: retry once with a new token on 401.
    const refreshing = async <T>(call: (token: string) => Promise<T>) => {
      try {
        return await call('stale');
      } catch (error) {
        if (!(error instanceof UnauthorizedError)) throw error;
        return call('fresh');
      }
    };
    const api = new BusinessApiClient(baseUrl, refreshing, fetchImpl);
    await expect(api.clearQuotes(dealFixture().id)).resolves.toEqual({
      deleted: 2,
    });
    expect(tokens).toEqual(['Bearer stale', 'Bearer fresh']);
  });

  it('reports an ended session as unauthenticated', async () => {
    const result = await toApiResult(async () => {
      throw new UnauthorizedError();
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'unauthenticated',
        message: 'Your session has ended. Sign in again.',
      },
    });
    const offline = await toApiResult(async () => {
      throw new OfflineError();
    });
    expect(offline.ok === false && offline.error.kind).toBe('offline');
  });
});

describe('lender logos', () => {
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2,
  ]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const webp = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
  ]);
  const lenderId = '40000000-0000-4000-8000-000000000001';

  it('identifies images by signature bytes, not by name', () => {
    expect(sniffLogoType(png)).toBe('image/png');
    expect(sniffLogoType(jpeg)).toBe('image/jpeg');
    expect(sniffLogoType(webp)).toBe('image/webp');
    expect(
      sniffLogoType(new TextEncoder().encode('<svg onload=alert(1)>')),
    ).toBe(undefined);
  });

  it('refuses non-images and oversized files before any request', async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const api = new BusinessApiClient(baseUrl, withToken, fetchImpl);
    const svg = await toApiResult(() =>
      api.putLenderLogo(lenderId, new TextEncoder().encode('<svg/>')),
    );
    expect(svg.ok === false && svg.error.kind).toBe('validation');
    const big = new Uint8Array(maxLogoBytes + 1);
    big.set(png);
    const oversized = await toApiResult(() => api.putLenderLogo(lenderId, big));
    expect(oversized.ok === false && oversized.error.message).toContain(
      '512 KB',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uploads with the sniffed content type and returns the lender', async () => {
    const lender = {
      id: lenderId,
      name: 'Local Credit Union',
      websiteUrl: null,
      isPreset: false,
      hasLogo: true,
      logoUpdatedAt: '2026-09-29T00:00:00.000Z',
      createdAt: '2026-09-29T00:00:00.000Z',
      updatedAt: '2026-09-29T00:00:00.000Z',
    };
    const fetchImpl = vi.fn<FetchLike>(async () => json(200, lender));
    const api = new BusinessApiClient(baseUrl, withToken, fetchImpl);
    await expect(api.putLenderLogo(lenderId, jpeg)).resolves.toEqual(lender);
    const [url, init] = fetchImpl.mock.calls[0] ?? ['', {}];
    expect(url).toBe(`${baseUrl}/v1/lenders/${lenderId}/logo`);
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['content-type']).toBe(
      'image/jpeg',
    );
  });

  it('returns a stored logo as a data URL and rejects non-image responses', async () => {
    const ok = new BusinessApiClient(
      baseUrl,
      withToken,
      async () =>
        new Response(png, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
    );
    await expect(ok.lenderLogo(lenderId)).resolves.toEqual({
      dataUrl: `data:image/png;base64,${Buffer.from(png).toString('base64')}`,
    });
    const html = new BusinessApiClient(
      baseUrl,
      withToken,
      async () => new Response('<html>', { status: 200 }),
    );
    const result = await toApiResult(() => html.lenderLogo(lenderId));
    expect(result.ok === false && result.error.kind).toBe('server');
  });
});
