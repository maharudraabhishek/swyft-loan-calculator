import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AuthStateDto, TokenResponseDto } from '@swyft/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveApiBaseUrl } from '../api-base-url';
import { authView } from '../../renderer/src/auth-gate';
import {
  ApiResponseError,
  AuthApiClient,
  OfflineError,
  UnauthorizedError,
  type FetchLike,
} from './api-client';
import { startLoopbackReceiver, type LoopbackReceiver } from './loopback';
import { AuthSessionManager } from './session-manager';
import { SecureSessionStore, type SecretCipher } from './session-store';

const apiBaseUrl = 'https://api.example.test';

/** Reversible stand-in for DPAPI that proves the file is not plaintext. */
const fakeCipher = (available = true): SecretCipher => ({
  isEncryptionAvailable: () => available,
  encryptString: (text) =>
    Buffer.from(
      Buffer.from(text).toString('base64').split('').reverse().join(''),
    ),
  decryptString: (data) =>
    Buffer.from(
      data.toString().split('').reverse().join(''),
      'base64',
    ).toString(),
});

const refreshToken = (n: number) => `swr_${'r'.repeat(40)}${n}`;

function tokens(n: number, expiresInMs = 15 * 60_000): TokenResponseDto {
  return {
    accessToken: `swa_${'a'.repeat(40)}${n}`,
    accessTokenExpiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    refreshToken: refreshToken(n),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    user: {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'broker@example.test',
      displayName: 'Broker',
    },
  };
}

let directory: string;
let filePath: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'swyft-session-'));
  filePath = path.join(directory, 'session.bin');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('SecureSessionStore', () => {
  it('round-trips an encrypted refresh token without writing plaintext', async () => {
    const store = new SecureSessionStore(filePath, fakeCipher());
    await store.save(apiBaseUrl, refreshToken(1));
    expect((await readFile(filePath)).toString()).not.toContain(
      refreshToken(1),
    );
    expect(await store.load(apiBaseUrl)).toBe(refreshToken(1));
  });

  it('deletes a corrupted file and reports no session', async () => {
    await writeFile(filePath, 'not encrypted json');
    const store = new SecureSessionStore(filePath, fakeCipher());
    expect(await store.load(apiBaseUrl)).toBeNull();
    await expect(readFile(filePath)).rejects.toThrow();
  });

  it('ignores a session saved for another backend', async () => {
    const store = new SecureSessionStore(filePath, fakeCipher());
    await store.save('https://other.example.test', refreshToken(1));
    expect(await store.load(apiBaseUrl)).toBeNull();
  });

  it('does not persist when OS encryption is unavailable', async () => {
    const store = new SecureSessionStore(filePath, fakeCipher(false));
    await store.save(apiBaseUrl, refreshToken(1));
    await expect(readFile(filePath)).rejects.toThrow();
    expect(store.canPersist).toBe(false);
  });

  it('clears the file on sign-out', async () => {
    const store = new SecureSessionStore(filePath, fakeCipher());
    await store.save(apiBaseUrl, refreshToken(1));
    await store.clear();
    expect(await store.load(apiBaseUrl)).toBeNull();
  });
});

describe('loopback receiver', () => {
  let receiver: LoopbackReceiver | undefined;
  afterEach(() => receiver?.close());

  it('binds to 127.0.0.1 and accepts a code only with the matching state', async () => {
    receiver = await startLoopbackReceiver('expected-state-value-123', 5_000);
    expect(receiver.redirectUri).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );
    const forged = await fetch(
      `${receiver.redirectUri}?code=swc_${'x'.repeat(30)}&state=attacker`,
    );
    expect(forged.status).toBe(400);
    const wrongPath = await fetch(
      receiver.redirectUri.replace('/callback', '/other'),
    );
    expect(wrongPath.status).toBe(404);
    const code = `swc_${'c'.repeat(30)}`;
    const ok = await fetch(
      `${receiver.redirectUri}?code=${code}&state=expected-state-value-123`,
    );
    expect(ok.status).toBe(200);
    expect(await receiver.result).toEqual({ kind: 'code', code });
  });

  it('reports a refusal and times out when nothing arrives', async () => {
    receiver = await startLoopbackReceiver('state-denied-000000000000', 5_000);
    await fetch(
      `${receiver.redirectUri}?error=access_denied&state=state-denied-000000000000`,
    );
    expect(await receiver.result).toEqual({ kind: 'denied' });
    const idle = await startLoopbackReceiver('state-timeout-00000000000', 20);
    expect(await idle.result).toEqual({ kind: 'timeout' });
  });
});

function fakeApi(
  overrides: Partial<
    Record<'refresh' | 'exchangeCode' | 'logout', ReturnType<typeof vi.fn>>
  > = {},
) {
  const api = new AuthApiClient(apiBaseUrl, () =>
    Promise.reject(new Error('unused')),
  );
  return Object.assign(api, {
    refresh: overrides.refresh ?? vi.fn(),
    exchangeCode: overrides.exchangeCode ?? vi.fn(),
    logout: overrides.logout ?? vi.fn().mockResolvedValue(undefined),
  });
}

function manager(
  api: AuthApiClient,
  store: SecureSessionStore,
  extra: Partial<ConstructorParameters<typeof AuthSessionManager>[0]> = {},
) {
  const states: AuthStateDto[] = [];
  const instance = new AuthSessionManager({
    api,
    store,
    openBrowser: vi.fn().mockResolvedValue(undefined),
    startLoopback: vi.fn(),
    onStateChanged: (state) => states.push(state),
    ...extra,
  });
  return { instance, states };
}

describe('AuthSessionManager', () => {
  it('restores a remembered session and persists the rotated token', async () => {
    const store = new SecureSessionStore(filePath, fakeCipher());
    await store.save(apiBaseUrl, refreshToken(1));
    const api = fakeApi({ refresh: vi.fn().mockResolvedValue(tokens(2)) });
    const { instance } = manager(api, store);
    await instance.restore();
    expect(api.refresh).toHaveBeenCalledWith(refreshToken(1));
    expect(instance.getState()).toMatchObject({
      status: 'signed-in',
      user: { email: 'broker@example.test' },
    });
    expect(JSON.stringify(instance.getState())).not.toContain('swa_');
    expect(await store.load(apiBaseUrl)).toBe(refreshToken(2));
  });

  it('confirms the session with one authenticated API call after restore', async () => {
    const store = new SecureSessionStore(filePath, fakeCipher());
    await store.save(apiBaseUrl, refreshToken(1));
    const api = fakeApi({ refresh: vi.fn().mockResolvedValue(tokens(2)) });
    const me = vi.fn().mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001',
      email: 'broker@example.test',
      displayName: 'Renamed Broker',
    });
    Object.assign(api, { me });
    const { instance } = manager(api, store);
    await instance.restore();
    await vi.waitFor(() =>
      expect(instance.getState().user?.displayName).toBe('Renamed Broker'),
    );
    expect(me).toHaveBeenCalledWith(tokens(2).accessToken);
  });

  it('clears an expired or revoked remembered session', async () => {
    const store = new SecureSessionStore(filePath, fakeCipher());
    await store.save(apiBaseUrl, refreshToken(1));
    const { instance } = manager(
      fakeApi({ refresh: vi.fn().mockRejectedValue(new UnauthorizedError()) }),
      store,
    );
    await instance.restore();
    expect(instance.getState().status).toBe('signed-out');
    expect(await store.load(apiBaseUrl)).toBeNull();
  });

  it('keeps the remembered session and shows offline when the API is unreachable', async () => {
    const store = new SecureSessionStore(filePath, fakeCipher());
    await store.save(apiBaseUrl, refreshToken(1));
    const { instance } = manager(
      fakeApi({ refresh: vi.fn().mockRejectedValue(new OfflineError()) }),
      store,
    );
    await instance.restore();
    expect(instance.getState().status).toBe('offline');
    expect(await store.load(apiBaseUrl)).toBe(refreshToken(1));
  });

  it('signs in through the system browser with PKCE and a loopback redirect', async () => {
    const store = new SecureSessionStore(filePath, fakeCipher());
    const exchangeCode = vi.fn().mockResolvedValue(tokens(1));
    let openedUrl = '';
    const { instance } = manager(fakeApi({ exchangeCode }), store, {
      openBrowser: async (url) => {
        openedUrl = url;
      },
      startLoopback: async (state) => ({
        redirectUri: 'http://127.0.0.1:50123/callback',
        result: Promise.resolve({
          kind: 'code' as const,
          code: `swc_${state.slice(0, 5)}${'c'.repeat(30)}`,
        }),
        close: () => undefined,
      }),
    });
    await instance.signIn();
    const opened = new URL(openedUrl);
    expect(opened.origin).toBe(apiBaseUrl);
    expect(opened.pathname).toBe('/v1/auth/login');
    expect(opened.searchParams.get('code_challenge_method')).toBe('S256');
    const verifier = exchangeCode.mock.calls[0]?.[0].codeVerifier as string;
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      opened.searchParams.get('code_challenge'),
    );
    expect(openedUrl).not.toContain(verifier);
    expect(instance.getState().status).toBe('signed-in');
    expect(await store.load(apiBaseUrl)).toBe(refreshToken(1));
  });

  it('returns to sign-in with a message when the browser flow is cancelled', async () => {
    const store = new SecureSessionStore(filePath, fakeCipher());
    const { instance } = manager(fakeApi(), store, {
      startLoopback: async () => ({
        redirectUri: 'http://127.0.0.1:50124/callback',
        result: Promise.resolve({ kind: 'denied' as const }),
        close: () => undefined,
      }),
    });
    await instance.signIn();
    expect(instance.getState()).toMatchObject({
      status: 'signed-out',
      message: expect.stringContaining('cancelled'),
    });
  });

  it('keeps the remembered session when the service fails with a non-401 error', async () => {
    const store = new SecureSessionStore(filePath, fakeCipher());
    await store.save(apiBaseUrl, refreshToken(1));
    const { instance } = manager(
      fakeApi({
        refresh: vi.fn().mockRejectedValue(new ApiResponseError(503)),
      }),
      store,
    );
    await instance.restore();
    expect(instance.getState()).toMatchObject({
      status: 'offline',
      message: expect.stringContaining('unavailable'),
    });
    expect(await store.load(apiBaseUrl)).toBe(refreshToken(1));
  });

  it('discards and revokes tokens that arrive after sign-out', async () => {
    const store = new SecureSessionStore(filePath, fakeCipher());
    await store.save(apiBaseUrl, refreshToken(1));
    let release: (value: TokenResponseDto) => void = () => undefined;
    const refresh = vi.fn(
      () =>
        new Promise<TokenResponseDto>((resolve) => {
          release = resolve;
        }),
    );
    const logout = vi.fn().mockResolvedValue(undefined);
    const { instance } = manager(fakeApi({ refresh, logout }), store);
    const restoring = instance.restore();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    await instance.signOut();
    release(tokens(2));
    await restoring;
    expect(instance.getState().status).toBe('signed-out');
    expect(await store.load(apiBaseUrl)).toBeNull();
    expect(logout).toHaveBeenCalledWith(refreshToken(2));
  });

  it('ignores retry while signed in', async () => {
    const store = new SecureSessionStore(filePath, fakeCipher());
    await store.save(apiBaseUrl, refreshToken(1));
    const refresh = vi.fn().mockResolvedValue(tokens(2));
    const { instance } = manager(fakeApi({ refresh }), store);
    await instance.restore();
    await instance.restore();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('signs out locally even when the API cannot be reached', async () => {
    const store = new SecureSessionStore(filePath, fakeCipher());
    await store.save(apiBaseUrl, refreshToken(1));
    const logout = vi.fn().mockRejectedValue(new OfflineError());
    const { instance } = manager(
      fakeApi({ refresh: vi.fn().mockResolvedValue(tokens(2)), logout }),
      store,
    );
    await instance.restore();
    await instance.signOut();
    expect(instance.getState().status).toBe('signed-out');
    expect(await store.load(apiBaseUrl)).toBeNull();
    expect(logout).toHaveBeenCalledWith(refreshToken(2));
  });

  it('refreshes once for concurrent calls and retries a 401 with the new token', async () => {
    const store = new SecureSessionStore(filePath, fakeCipher());
    await store.save(apiBaseUrl, refreshToken(1));
    const refresh = vi
      .fn()
      .mockResolvedValueOnce(tokens(2))
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return tokens(3);
      });
    const { instance } = manager(fakeApi({ refresh }), store);
    await instance.restore();
    const seen: string[] = [];
    const call = async (token: string) => {
      seen.push(token);
      if (token === tokens(2).accessToken) throw new UnauthorizedError();
      return token;
    };
    const results = await Promise.all([
      instance.withAccessToken(call),
      instance.withAccessToken(call),
    ]);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(results).toEqual([tokens(3).accessToken, tokens(3).accessToken]);
  });
});

describe('AuthApiClient', () => {
  it('maps network failures to offline and 401 to unauthorized, and validates responses', async () => {
    const failing: FetchLike = () =>
      Promise.reject(new TypeError('fetch failed'));
    await expect(
      new AuthApiClient(apiBaseUrl, failing).refresh(refreshToken(1)),
    ).rejects.toBeInstanceOf(OfflineError);
    const unauthorized: FetchLike = () =>
      Promise.resolve(new Response('{}', { status: 401 }));
    await expect(
      new AuthApiClient(apiBaseUrl, unauthorized).refresh(refreshToken(1)),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    const malformed: FetchLike = () =>
      Promise.resolve(Response.json({ accessToken: 1 }));
    await expect(
      new AuthApiClient(apiBaseUrl, malformed).refresh(refreshToken(1)),
    ).rejects.toThrow('Unexpected API response');
  });
});

describe('desktop configuration and views', () => {
  it('accepts only https or, in development, loopback http API origins', () => {
    expect(resolveApiBaseUrl('https://swyft-api.a.run.app', true)).toBe(
      'https://swyft-api.a.run.app',
    );
    expect(resolveApiBaseUrl(undefined, false)).toBe('http://127.0.0.1:8080');
    expect(resolveApiBaseUrl('http://127.0.0.1:8080', false)).toBe(
      'http://127.0.0.1:8080',
    );
    for (const bad of [
      'http://api.example.test',
      'https://user:pw@api.example.test',
      'https://api.example.test/v1',
      'file:///c:/x',
    ])
      expect(() => resolveApiBaseUrl(bad, false)).toThrow();
    // Packaged builds: configured HTTPS only, never a loopback or default origin.
    expect(() => resolveApiBaseUrl(undefined, true)).toThrow();
    expect(() => resolveApiBaseUrl('http://127.0.0.1:8080', true)).toThrow();
  });

  it('shows the app only for a live session', () => {
    const state = (status: AuthStateDto['status']): AuthStateDto => ({
      status,
      remembersSession: true,
    });
    expect(authView(undefined)).toBe('loading');
    expect(authView(state('restoring'))).toBe('loading');
    expect(authView(state('signed-out'))).toBe('sign-in');
    expect(authView(state('signing-in'))).toBe('sign-in');
    expect(authView(state('offline'))).toBe('offline');
    expect(authView(state('signed-in'))).toBe('app');
  });
});
