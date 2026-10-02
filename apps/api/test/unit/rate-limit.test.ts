import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createApplication } from '../../src/composition.js';
import { Database, type Principal, type Sql } from '../../src/db/database.js';
import type { ProtectedRateLimits } from '../../src/http/protected-routes.js';
import { FixedWindowLimiter } from '../../src/http/rate-limit.js';
import { hashSecret } from '../../src/identity/tokens.js';

const environment = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
  DB_HOST: '127.0.0.1',
  DB_PORT: '1',
  DB_NAME: 'unused',
  DB_USER: 'unused',
  DB_PASSWORD: 'unused',
  IDENTITY_PROVIDER: 'dev',
  LOGO_STORAGE: 'memory',
  LOG_LEVEL: 'silent',
};
const unreachable = {
  host: '127.0.0.1',
  port: 1,
  database: 'unused',
  user: 'unused',
  password: 'unused',
  max: 1,
  ssl: false,
};
const database = new Database(unreachable);

/** Signed-in callers the fake database recognises, by bearer token. */
const accounts = {
  alice: { token: `swa_${'a'.repeat(43)}`, userId: 'user-alice' },
  bob: { token: `swa_${'b'.repeat(43)}`, userId: 'user-bob' },
};
const unknownToken = `swa_${'z'.repeat(43)}`;

/**
 * Answers the session lookup and `/v1/me` without PostgreSQL and counts lookups, so the
 * tests can show which requests reach the database. Other queries return no rows.
 */
class FakeDatabase extends Database {
  lookups = 0;

  constructor() {
    super(unreachable);
  }

  override withoutUser<T>(work: (sql: Sql) => Promise<T>): Promise<T> {
    return work(this.sql);
  }

  override withUser<T>(
    _principal: Principal,
    work: (sql: Sql) => Promise<T>,
  ): Promise<T> {
    return work(this.sql);
  }

  private readonly sql: Sql = {
    query: async <Row extends object>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<Row[]> => {
      if (text.includes('auth.resolve_access_token')) {
        this.lookups += 1;
        const account = Object.values(accounts).find((candidate) =>
          hashSecret(candidate.token).equals(values[0] as Buffer),
        );
        return (
          account ? [{ user_id: account.userId, session_id: 'session' }] : []
        ) as Row[];
      }
      if (text.includes('FROM app.users'))
        return [
          { id: values[0], email: 'broker@example.com', display_name: null },
        ] as Row[];
      return [];
    },
  };
}

const closers: { close(): Promise<unknown> }[] = [database];
afterAll(async () => {
  for (const closer of closers) await closer.close();
});

function appWith(trustProxyHops: '0' | '1') {
  const { app } = createApplication(
    loadConfig({ ...environment, TRUST_PROXY_HOPS: trustProxyHops }),
    { database, authRateLimits: { token: 3 } },
  );
  closers.unshift(app);
  return app;
}

function signedInApp(limits: Partial<ProtectedRateLimits>) {
  const fake = new FakeDatabase();
  const { app } = createApplication(
    loadConfig({ ...environment, TRUST_PROXY_HOPS: '1' }),
    { database: fake, protectedRateLimits: limits },
  );
  closers.unshift(app, fake);
  return { app, fake };
}

type TestApp = ReturnType<typeof appWith>;

// Malformed bodies still count: the limiter runs before validation and before the database.
const tokenRequest = (app: TestApp, forwardedFor?: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/auth/token',
    payload: { grantType: 'refresh_token', refreshToken: 'bad' },
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
  });

const signedIn = (
  app: TestApp,
  token: string | undefined,
  options: {
    method?: 'GET' | 'PATCH';
    url?: string;
    ip?: string;
  } = {},
) =>
  app.inject({
    method: options.method ?? 'GET',
    url: options.url ?? '/v1/me',
    headers: {
      'x-forwarded-for': options.ip ?? '203.0.113.7',
      ...(token !== undefined && { authorization: `Bearer ${token}` }),
    },
    // An empty body fails validation in the handler, after the limits: no database write.
    ...(options.method === 'PATCH' && { payload: {} }),
  });

const dealUrl = '/v1/deals/00000000-0000-4000-8000-000000000001';
const logoUrl = '/v1/lenders/00000000-0000-4000-8000-000000000001/logo';

describe('FixedWindowLimiter', () => {
  it('allows the limit, then reports the wait, then resets with the window', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(2, 60_000, 100, () => now);
    expect(limiter.hit('a')).toBeNull();
    expect(limiter.hit('a')).toBeNull();
    expect(limiter.hit('a')).toEqual({ retryAfterSeconds: 60, first: true });
    now = 45_000;
    expect(limiter.hit('a')).toEqual({ retryAfterSeconds: 15, first: false });
    expect(limiter.hit('b')).toBeNull();
    now = 60_000;
    expect(limiter.hit('a')).toBeNull();
  });

  it('flags only the first rejection in each window', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(1, 60_000, 100, () => now);
    limiter.hit('a');
    const firsts = Array.from({ length: 5 }, () => limiter.hit('a')?.first);
    expect(firsts).toEqual([true, false, false, false, false]);
    now = 60_000;
    limiter.hit('a');
    expect(limiter.hit('a')?.first).toBe(true);
  });

  it('reports an exhausted budget without counting', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(2, 60_000, 100, () => now);
    expect(limiter.exhausted('a')).toBe(false);
    limiter.hit('a');
    expect(limiter.exhausted('a')).toBe(false);
    limiter.hit('a');
    expect(limiter.exhausted('a')).toBe(true);
    expect(limiter.exhausted('a')).toBe(true);
    now = 60_000;
    expect(limiter.exhausted('a')).toBe(false);
    expect(limiter.hit('a')).toBeNull();
  });

  it('keeps memory bounded by evicting the oldest client', () => {
    const limiter = new FixedWindowLimiter(1, 60_000, 3);
    for (const key of ['a', 'b', 'c', 'd', 'e']) limiter.hit(key);
    expect(limiter.size).toBe(3);
  });
});

describe('public auth endpoints', () => {
  it('returns 429 with Retry-After once a client exceeds the limit', async () => {
    const app = appWith('0');
    for (let i = 0; i < 3; i += 1)
      expect((await tokenRequest(app)).statusCode).toBe(400);
    const limited = await tokenRequest(app);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('behind Cloud Run keys on the proxy-appended IP, so spoofed entries cannot evade it', async () => {
    const app = appWith('1');
    for (let i = 0; i < 3; i += 1)
      expect(
        (await tokenRequest(app, `10.0.0.${i}, 203.0.113.7`)).statusCode,
      ).toBe(400);
    expect((await tokenRequest(app, 'spoofed, 203.0.113.7')).statusCode).toBe(
      429,
    );
    expect((await tokenRequest(app, '203.0.113.8')).statusCode).toBe(400);
  });

  it('without a trusted proxy ignores X-Forwarded-For entirely', async () => {
    const app = appWith('0');
    for (let i = 0; i < 3; i += 1)
      expect((await tokenRequest(app, `198.51.100.${i}`)).statusCode).toBe(400);
    expect((await tokenRequest(app, '198.51.100.99')).statusCode).toBe(429);
  });
});

describe('signed-in endpoints', () => {
  it('refuses an IP that keeps presenting unknown tokens before it reaches the database', async () => {
    const { app, fake } = signedInApp({ failedTokensPerIp: 2 });
    for (let i = 0; i < 2; i += 1)
      expect((await signedIn(app, unknownToken)).statusCode).toBe(401);
    expect(fake.lookups).toBe(2);

    const refused = await signedIn(app, unknownToken);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe('RATE_LIMITED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    // Until the window ends this IP's tokens are not looked up, valid or not.
    expect((await signedIn(app, accounts.alice.token)).statusCode).toBe(429);
    expect(fake.lookups).toBe(2);

    // Other clients are unaffected.
    const elsewhere = await signedIn(app, accounts.alice.token, {
      ip: '203.0.113.8',
    });
    expect(elsewhere.statusCode).toBe(200);
  });

  it('does not count missing or malformed tokens, which never reach the database', async () => {
    const { app, fake } = signedInApp({ failedTokensPerIp: 2 });
    for (let i = 0; i < 5; i += 1) {
      expect((await signedIn(app, undefined)).statusCode).toBe(401);
      expect((await signedIn(app, 'short')).statusCode).toBe(401);
    }
    expect(fake.lookups).toBe(0);
    expect((await signedIn(app, accounts.alice.token)).statusCode).toBe(200);
  });

  it('gives each account its own budget, even from one IP', async () => {
    const { app } = signedInApp({ requestsPerAccount: 3 });
    for (let i = 0; i < 3; i += 1)
      expect((await signedIn(app, accounts.alice.token)).statusCode).toBe(200);
    const limited = await signedIn(app, accounts.alice.token);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // A new IP does not reset an account's budget; another account is unaffected.
    expect(
      (await signedIn(app, accounts.alice.token, { ip: '198.51.100.1' }))
        .statusCode,
    ).toBe(429);
    expect((await signedIn(app, accounts.bob.token)).statusCode).toBe(200);
  });

  it('budgets writes separately, so reads keep working', async () => {
    const { app } = signedInApp({ writesPerAccount: 2 });
    const write = () =>
      signedIn(app, accounts.alice.token, { method: 'PATCH', url: dealUrl });
    for (let i = 0; i < 2; i += 1) expect((await write()).statusCode).toBe(400);
    expect((await write()).statusCode).toBe(429);
    expect((await signedIn(app, accounts.alice.token)).statusCode).toBe(200);
    expect(
      (
        await signedIn(app, accounts.bob.token, {
          method: 'PATCH',
          url: dealUrl,
        })
      ).statusCode,
    ).toBe(400);
  });

  it('budgets logo transfers separately, so other requests keep working', async () => {
    const { app } = signedInApp({ logoTransfersPerAccount: 2 });
    const download = () =>
      signedIn(app, accounts.alice.token, { url: logoUrl });
    for (let i = 0; i < 2; i += 1)
      expect((await download()).statusCode).toBe(404);
    expect((await download()).statusCode).toBe(429);
    expect((await signedIn(app, accounts.alice.token)).statusCode).toBe(200);
  });
});
