import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createApplication } from '../../src/composition.js';
import { Database } from '../../src/db/database.js';
import { FixedWindowLimiter } from '../../src/http/rate-limit.js';

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
const database = new Database({
  host: '127.0.0.1',
  port: 1,
  database: 'unused',
  user: 'unused',
  password: 'unused',
  max: 1,
  ssl: false,
});
const apps: { close(): Promise<unknown> }[] = [];
afterAll(async () => {
  for (const app of apps) await app.close();
  await database.close();
});

function appWith(trustProxyHops: '0' | '1') {
  const { app } = createApplication(
    loadConfig({ ...environment, TRUST_PROXY_HOPS: trustProxyHops }),
    { database, authRateLimits: { token: 3 } },
  );
  apps.push(app);
  return app;
}

// Malformed bodies still count: the limiter runs before validation and before the database.
const tokenRequest = (app: ReturnType<typeof appWith>, forwardedFor?: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/auth/token',
    payload: { grantType: 'refresh_token', refreshToken: 'bad' },
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
  });

describe('FixedWindowLimiter', () => {
  it('allows the limit, then reports the wait, then resets with the window', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(2, 60_000, 100, () => now);
    expect(limiter.hit('a')).toBeNull();
    expect(limiter.hit('a')).toBeNull();
    expect(limiter.hit('a')).toBe(60);
    now = 45_000;
    expect(limiter.hit('a')).toBe(15);
    expect(limiter.hit('b')).toBeNull();
    now = 60_000;
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
