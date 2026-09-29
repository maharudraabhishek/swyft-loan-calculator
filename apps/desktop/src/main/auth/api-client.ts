import {
  tokenResponseSchema,
  userSchema,
  type TokenResponseDto,
  type UserDto,
} from '@swyft/contracts';
import type { z } from 'zod';

/** No response: network down, DNS failure or timeout. The stored session is kept. */
export class OfflineError extends Error {
  constructor() {
    super('The Swyft service could not be reached.');
    this.name = 'OfflineError';
  }
}

/** The server rejected the credential; the session is over. */
export class UnauthorizedError extends Error {
  constructor() {
    super('Your sign-in has expired.');
    this.name = 'UnauthorizedError';
  }
}

/** Any other failed or malformed response. */
export class ApiResponseError extends Error {
  constructor(readonly status: number) {
    super(`Unexpected API response (${status})`);
    this.name = 'ApiResponseError';
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const requestTimeoutMs = 15_000;

/**
 * Main-process HTTP client for the auth endpoints. Responses are untrusted and are
 * validated against the shared contracts before use.
 */
export class AuthApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  /** Browser URL that starts a sign-in attempt; only this API origin is ever opened. */
  loginUrl(input: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
  }): string {
    const url = new URL('/v1/auth/login', this.baseUrl);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.href;
  }

  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<TokenResponseDto> {
    return this.request('/v1/auth/token', tokenResponseSchema, {
      method: 'POST',
      body: { grantType: 'authorization_code', ...input },
    });
  }

  refresh(refreshToken: string): Promise<TokenResponseDto> {
    return this.request('/v1/auth/token', tokenResponseSchema, {
      method: 'POST',
      body: { grantType: 'refresh_token', refreshToken },
    });
  }

  async logout(refreshToken: string): Promise<void> {
    await this.send('/v1/auth/logout', {
      method: 'POST',
      body: { refreshToken },
    });
  }

  me(accessToken: string): Promise<UserDto> {
    return this.request('/v1/me', userSchema, { method: 'GET', accessToken });
  }

  private async request<T extends z.ZodType>(
    path: string,
    schema: T,
    options: { method: 'GET' | 'POST'; body?: unknown; accessToken?: string },
  ): Promise<z.output<T>> {
    const response = await this.send(path, options);
    const parsed = schema.safeParse(
      await response.json().catch(() => undefined),
    );
    if (!parsed.success) throw new ApiResponseError(response.status);
    return parsed.data;
  }

  private async send(
    path: string,
    options: { method: 'GET' | 'POST'; body?: unknown; accessToken?: string },
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl).href, {
        method: options.method,
        headers: {
          accept: 'application/json',
          ...(options.body === undefined
            ? {}
            : { 'content-type': 'application/json' }),
          ...(options.accessToken
            ? { authorization: `Bearer ${options.accessToken}` }
            : {}),
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(requestTimeoutMs),
        redirect: 'error',
      });
    } catch {
      throw new OfflineError();
    }
    if (response.status === 401) throw new UnauthorizedError();
    if (
      response.status === 502 ||
      response.status === 503 ||
      response.status === 504
    )
      throw new OfflineError();
    if (!response.ok) throw new ApiResponseError(response.status);
    return response;
  }
}
