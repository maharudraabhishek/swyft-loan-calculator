import type { TokenResponseDto } from '@swyft/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSecret } from '../../src/identity/tokens.js';
import {
  browserLogin,
  createTestApp,
  ownerClient,
  signIn,
  uniqueEmail,
  type TestApp,
} from './support.js';

let test: TestApp;
let owner: pg.Client;

beforeAll(async () => {
  test = await createTestApp();
  owner = await ownerClient();
});

afterAll(async () => {
  await owner.end();
  await test.close();
});

const exchange = (payload: Record<string, unknown>) =>
  test.app.inject({ method: 'POST', url: '/v1/auth/token', payload });
const refresh = (refreshToken: string) =>
  exchange({ grantType: 'refresh_token', refreshToken });
const me = (accessToken: string) =>
  test.app.inject({
    method: 'GET',
    url: '/v1/me',
    headers: { authorization: `Bearer ${accessToken}` },
  });

describe('browser sign-in and code exchange', () => {
  it('issues a session for a valid code, verifier and redirect URI', async () => {
    const email = uniqueEmail('login');
    const login = await browserLogin(test.app, email);
    expect(login.code).toMatch(/^swc_/);
    const response = await exchange({
      grantType: 'authorization_code',
      code: login.code,
      codeVerifier: login.verifier,
      redirectUri: login.redirectUri,
    });
    expect(response.statusCode).toBe(200);
    const tokens = response.json<TokenResponseDto>();
    expect(tokens.user.email).toBe(email);
    expect(tokens.accessToken).toMatch(/^swa_/);
    expect(tokens.refreshToken).toMatch(/^swr_/);
    expect((await me(tokens.accessToken)).json()).toEqual(tokens.user);
  });

  it('stores only hashes of issued tokens', async () => {
    const { tokens } = await signIn(test.app, uniqueEmail('hash'));
    const { rows } = await owner.query(
      `SELECT s.access_token_hash, t.token_hash FROM auth.sessions s
       JOIN auth.refresh_tokens t ON t.session_id = s.id
       WHERE s.access_token_hash = $1`,
      [hashSecret(tokens.accessToken)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toEqual(hashSecret(tokens.refreshToken));
    const dump = await owner.query(
      'SELECT row_to_json(s)::text AS json FROM auth.sessions s',
    );
    expect(dump.rows.map((row) => row.json).join()).not.toContain(
      tokens.accessToken,
    );
  });

  it('rejects a wrong PKCE verifier and burns the code', async () => {
    const login = await browserLogin(test.app, uniqueEmail('pkce'));
    const wrong = await exchange({
      grantType: 'authorization_code',
      code: login.code,
      codeVerifier: 'x'.repeat(43),
      redirectUri: login.redirectUri,
    });
    expect(wrong.statusCode).toBe(401);
    const retry = await exchange({
      grantType: 'authorization_code',
      code: login.code,
      codeVerifier: login.verifier,
      redirectUri: login.redirectUri,
    });
    expect(retry.statusCode).toBe(401);
  });

  it('rejects a replayed code and a mismatched redirect URI', async () => {
    const login = await browserLogin(test.app, uniqueEmail('replay'));
    const mismatched = await exchange({
      grantType: 'authorization_code',
      code: login.code,
      codeVerifier: login.verifier,
      redirectUri: 'http://127.0.0.1:1999/callback',
    });
    expect(mismatched.statusCode).toBe(401);

    const second = await browserLogin(test.app, uniqueEmail('replay2'));
    const body = {
      grantType: 'authorization_code',
      code: second.code,
      codeVerifier: second.verifier,
      redirectUri: second.redirectUri,
    };
    expect((await exchange(body)).statusCode).toBe(200);
    expect((await exchange(body)).statusCode).toBe(401);
  });

  it('rejects an expired code', async () => {
    const login = await browserLogin(test.app, uniqueEmail('expired-code'));
    await owner.query(
      "UPDATE auth.login_attempts SET code_expires_at = now() - interval '1 second' WHERE code_hash = $1",
      [hashSecret(login.code)],
    );
    const response = await exchange({
      grantType: 'authorization_code',
      code: login.code,
      codeVerifier: login.verifier,
      redirectUri: login.redirectUri,
    });
    expect(response.statusCode).toBe(401);
  });

  it('does not complete a callback without the starting browser cookie', async () => {
    const start = await test.app.inject({
      method: 'GET',
      url: '/v1/auth/login',
      query: {
        redirect_uri: 'http://127.0.0.1:45000/callback',
        state: 's'.repeat(24),
        code_challenge: 'c'.repeat(43),
        code_challenge_method: 'S256',
      },
    });
    const session =
      new URL(String(start.headers.location)).searchParams.get('session') ?? '';
    const forged = await test.app.inject({
      method: 'GET',
      url: `/v1/auth/callback?dev_session=${session}&email=victim%40example.test`,
      headers: {
        cookie: 'swyft_login=00000000-0000-4000-8000-000000000000.swb_forged',
      },
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.headers.location).toBeUndefined();
  });

  it('tells the desktop when the provider refuses, without issuing a code', async () => {
    const start = await test.app.inject({
      method: 'GET',
      url: '/v1/auth/login',
      query: {
        redirect_uri: 'http://127.0.0.1:45001/callback',
        state: 't'.repeat(24),
        code_challenge: 'c'.repeat(43),
        code_challenge_method: 'S256',
      },
    });
    const cookie = String(start.headers['set-cookie']).split(';')[0] ?? '';
    const callback = await test.app.inject({
      method: 'GET',
      url: '/v1/auth/callback?dev_session=wrong-session&email=a%40example.test',
      headers: { cookie },
    });
    expect(callback.statusCode).toBe(302);
    const location = new URL(String(callback.headers.location));
    expect(location.origin).toBe('http://127.0.0.1:45001');
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('t'.repeat(24));
    expect(location.searchParams.has('code')).toBe(false);
  });
});

describe('session lifecycle', () => {
  it('rotates refresh tokens and invalidates the previous access token', async () => {
    const { tokens } = await signIn(test.app, uniqueEmail('rotate'));
    const rotated = await refresh(tokens.refreshToken);
    expect(rotated.statusCode).toBe(200);
    const next = rotated.json<TokenResponseDto>();
    expect(next.refreshToken).not.toBe(tokens.refreshToken);
    expect((await me(tokens.accessToken)).statusCode).toBe(401);
    expect((await me(next.accessToken)).statusCode).toBe(200);
  });

  it('re-rotates within the grace period when the successor was never used (lost response)', async () => {
    const { tokens } = await signIn(test.app, uniqueEmail('grace'));
    // The client never receives this response.
    expect((await refresh(tokens.refreshToken)).statusCode).toBe(200);
    const retried = await refresh(tokens.refreshToken);
    expect(retried.statusCode).toBe(200);
    const recovered = retried.json<TokenResponseDto>();
    expect((await me(recovered.accessToken)).statusCode).toBe(200);
    // The recovered session continues to rotate normally.
    const next = await refresh(recovered.refreshToken);
    expect(next.statusCode).toBe(200);
    // A second replay of the original token is no longer covered by grace.
    expect((await refresh(tokens.refreshToken)).statusCode).toBe(401);
    expect(
      (await me(next.json<TokenResponseDto>().accessToken)).statusCode,
    ).toBe(401);
  });

  it('detects theft inside the grace window when the real client presents its successor', async () => {
    const { tokens: stolen } = await signIn(test.app, uniqueEmail('theft'));
    // Real client rotates T1 -> T2; an attacker holding a copy of T1 replays it quickly.
    const real = (await refresh(stolen.refreshToken)).json<TokenResponseDto>();
    const attacker = await refresh(stolen.refreshToken);
    expect(attacker.statusCode).toBe(200);
    const attackerTokens = attacker.json<TokenResponseDto>();
    // The real client's next refresh uses T2, which the grace rotation retired: replay.
    expect((await refresh(real.refreshToken)).statusCode).toBe(401);
    expect((await me(attackerTokens.accessToken)).statusCode).toBe(401);
    expect((await refresh(attackerTokens.refreshToken)).statusCode).toBe(401);
    const { rows } = await owner.query(
      'SELECT revoke_reason FROM auth.sessions WHERE user_id = $1',
      [real.user.id],
    );
    expect(rows).toEqual([{ revoke_reason: 'refresh_token_reuse' }]);
  });

  it('revokes the whole session when a rotated refresh token is replayed', async () => {
    const { tokens } = await signIn(test.app, uniqueEmail('reuse'));
    const next = (await refresh(tokens.refreshToken)).json<TokenResponseDto>();
    const third = (await refresh(next.refreshToken)).json<TokenResponseDto>();
    // `tokens.refreshToken` is two generations old and its successor was used: replay.
    expect((await refresh(tokens.refreshToken)).statusCode).toBe(401);
    expect((await me(third.accessToken)).statusCode).toBe(401);
    expect((await refresh(third.refreshToken)).statusCode).toBe(401);
    const { rows } = await owner.query(
      'SELECT revoke_reason FROM auth.sessions WHERE user_id = $1',
      [third.user.id],
    );
    expect(rows).toEqual([{ revoke_reason: 'refresh_token_reuse' }]);
  });

  it('treats a replay after the grace period as reuse', async () => {
    const { tokens } = await signIn(test.app, uniqueEmail('late'));
    const next = (await refresh(tokens.refreshToken)).json<TokenResponseDto>();
    await owner.query(
      "UPDATE auth.refresh_tokens SET consumed_at = now() - interval '5 minutes' WHERE token_hash = $1",
      [hashSecret(tokens.refreshToken)],
    );
    expect((await refresh(tokens.refreshToken)).statusCode).toBe(401);
    expect((await me(next.accessToken)).statusCode).toBe(401);
  });

  it('rejects an expired access token and an idle-expired refresh token', async () => {
    const { tokens } = await signIn(test.app, uniqueEmail('expiry'));
    await owner.query(
      "UPDATE auth.sessions SET access_expires_at = now() - interval '1 second' WHERE access_token_hash = $1",
      [hashSecret(tokens.accessToken)],
    );
    expect((await me(tokens.accessToken)).statusCode).toBe(401);
    await owner.query(
      "UPDATE auth.sessions SET idle_expires_at = now() - interval '1 second' WHERE user_id = $1",
      [tokens.user.id],
    );
    expect((await refresh(tokens.refreshToken)).statusCode).toBe(401);
  });

  it('logout revokes the session for both tokens and is idempotent', async () => {
    const { tokens } = await signIn(test.app, uniqueEmail('logout'));
    const logout = () =>
      test.app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        payload: { refreshToken: tokens.refreshToken },
      });
    expect((await logout()).statusCode).toBe(204);
    expect((await me(tokens.accessToken)).statusCode).toBe(401);
    expect((await refresh(tokens.refreshToken)).statusCode).toBe(401);
    expect((await logout()).statusCode).toBe(204);
  });

  it('blocks every session of a disabled user immediately', async () => {
    const { tokens } = await signIn(test.app, uniqueEmail('disabled'));
    await owner.query(
      'UPDATE app.users SET disabled_at = now() WHERE id = $1',
      [tokens.user.id],
    );
    expect((await me(tokens.accessToken)).statusCode).toBe(401);
    expect((await refresh(tokens.refreshToken)).statusCode).toBe(401);
  });

  it('keeps sessions independent across devices', async () => {
    const email = uniqueEmail('devices');
    const laptop = await signIn(test.app, email);
    const desktop = await signIn(test.app, email);
    expect(laptop.tokens.user.id).toBe(desktop.tokens.user.id);
    await test.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      payload: { refreshToken: laptop.tokens.refreshToken },
    });
    expect((await me(laptop.tokens.accessToken)).statusCode).toBe(401);
    expect((await me(desktop.tokens.accessToken)).statusCode).toBe(200);
  });
});
