import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, ConfigurationError } from '../../src/config.js';
import { createApplication } from '../../src/composition.js';
import { Database } from '../../src/db/database.js';

const baseEnvironment = {
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

// No database is reachable: every assertion here must hold before any query runs.
const database = new Database({
  host: '127.0.0.1',
  port: 1,
  database: 'unused',
  user: 'unused',
  password: 'unused',
  max: 1,
  ssl: false,
});
const { app } = createApplication(loadConfig(baseEnvironment), { database });
// Plugins (the protected scope) register on ready; the route table is complete only after it.
await app.ready();

afterAll(async () => {
  await app.close();
  await database.close();
});

const publicRoutes = new Set([
  'GET /health',
  'GET /ready',
  'GET /v1/auth/login',
  'GET /v1/auth/callback',
  'POST /v1/auth/token',
  'POST /v1/auth/logout',
  'GET /v1/auth/dev/authorize',
]);

/**
 * Rebuilds full paths from Fastify's route tree, where a child line is indented four
 * characters per level and shows only its suffix (e.g. `│   └── /:dealId (GET)`).
 */
function registeredRoutes(): string[] {
  const routes: string[] = [];
  const prefixes: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const match = /^(.*?)[├└]── (\S+)(?: \(([^)]+)\))?$/.exec(line);
    if (!match) continue;
    const [, indent = '', segment = '', methods] = match;
    const depth = indent.length / 4;
    const path = (depth > 0 ? (prefixes[depth - 1] ?? '') : '') + segment;
    prefixes[depth] = path;
    prefixes.length = depth + 1;
    for (const method of methods?.split(', ') ?? [])
      if (method !== 'HEAD') routes.push(`${method} ${path}`);
  }
  return routes;
}

describe('HTTP boundary', () => {
  it('returns health with a server-generated request ID and safety headers', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'attacker-controlled' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports not-ready when the database is unreachable', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
  });

  it('returns a safe 404 envelope that does not echo the URL', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v2/quotes?token=private',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found.',
        requestId: response.headers['x-request-id'],
      },
    });
    expect(response.body).not.toContain('private');
  });

  it('does not expose parser diagnostics for malformed JSON', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('BAD_REQUEST');
    expect(response.body).not.toContain('Unexpected');
  });
});

describe('authentication is required on every non-public route', () => {
  const routes = registeredRoutes();

  it('discovers the full route table', () => {
    expect(routes).toContain('GET /v1/me');
    expect(routes).toContain('POST /v1/deals/:dealId/quotes');
    expect(routes).toContain('PUT /v1/lenders/:id/logo');
    expect(routes.length).toBeGreaterThan(25);
  });

  const protectedRoutes = registeredRoutes().filter(
    (route) => !publicRoutes.has(route),
  );
  it.each(protectedRoutes)(
    '%s rejects anonymous and malformed bearer requests',
    async (route) => {
      const [method, template] = route.split(' ') as [
        'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        string,
      ];
      const url = template.replace(
        /:[A-Za-z]+/g,
        '00000000-0000-4000-8000-000000000001',
      );
      for (const authorization of [
        undefined,
        'Bearer',
        'Basic abc',
        'Bearer short',
      ]) {
        const response = await app.inject({
          method,
          url,
          headers: authorization === undefined ? {} : { authorization },
          ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }),
        });
        expect(response.statusCode).toBe(401);
        expect(response.json().error.code).toBe('UNAUTHENTICATED');
      }
    },
  );
});

describe('sign-in endpoint validation', () => {
  const valid = {
    redirect_uri: 'http://127.0.0.1:53123/callback',
    state: 'a'.repeat(32),
    code_challenge: 'b'.repeat(43),
    code_challenge_method: 'S256',
  };

  it.each([
    [
      'a non-loopback host',
      { redirect_uri: 'http://evil.example:53123/callback' },
    ],
    [
      'userinfo smuggling',
      { redirect_uri: 'http://127.0.0.1:80@evil.example/callback' },
    ],
    ['a privileged port', { redirect_uri: 'http://127.0.0.1:80/callback' }],
    ['a query string', { redirect_uri: 'http://127.0.0.1:53123/callback?x=1' }],
    ['https loopback', { redirect_uri: 'https://127.0.0.1:53123/callback' }],
    ['plain PKCE', { code_challenge_method: 'plain' }],
    ['a short state', { state: 'short' }],
    ['an extra parameter', { prompt: 'none' }],
  ])('rejects %s before any redirect', async (_label, override) => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/login',
      query: { ...valid, ...override },
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
  });

  it('shows an expiry page and clears the cookie when the callback has no attempt cookie', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/callback?code=x&state=y',
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('text/html');
    expect(String(response.headers['set-cookie'])).toContain('Max-Age=0');
    expect(response.headers.location).toBeUndefined();
    // Other pages keep the strict policy.
    expect(response.headers['content-security-policy']).toContain(
      "form-action 'self'",
    );
    expect(response.headers['content-security-policy']).not.toContain(
      '127.0.0.1',
    );
  });

  it('lets the dev consent form redirect to the desktop loopback receiver', async () => {
    // CSP form-action also applies to redirects after a form submission; with only 'self'
    // browsers silently block the callback's 302 to http://127.0.0.1:<port>/callback.
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/dev/authorize?session=abcdefghijklmnop',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http://127.0.0.1:* http://[::1]:*",
    );
  });

  it.each([
    [{ grantType: 'password', username: 'a', password: 'b' }],
    [
      {
        grantType: 'authorization_code',
        code: 'c'.repeat(30),
        codeVerifier: 'short',
        redirectUri: valid.redirect_uri,
      },
    ],
    [{ grantType: 'refresh_token', refreshToken: 'r'.repeat(30), extra: true }],
  ])('rejects malformed token requests with 400: %j', async (payload) => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('configuration', () => {
  it('refuses development conveniences and plain HTTP in production', () => {
    expect(() =>
      loadConfig({ ...baseEnvironment, NODE_ENV: 'production' }),
    ).toThrow(ConfigurationError);
    try {
      loadConfig({ ...baseEnvironment, NODE_ENV: 'production' });
    } catch (error) {
      const message = (error as ConfigurationError).message;
      expect(message).toContain('IDENTITY_PROVIDER');
      expect(message).toContain('LOGO_STORAGE');
      expect(message).toContain('PUBLIC_BASE_URL');
      expect(message).not.toContain('unused');
    }
  });

  it('requires Identity Platform settings and a bucket when those adapters are chosen', () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        IDENTITY_PROVIDER: 'identity-platform',
        LOGO_STORAGE: 'gcs',
      }),
    ).toThrow(/GCIP_API_KEY.*GCIP_PROJECT_ID.*LOGO_BUCKET/s);
  });
});

describe('identity provider outage', () => {
  it('renders a 503 sign-in page instead of a 500 when the provider refuses', async () => {
    const { IdentityVerificationError } =
      await import('../../src/identity/identity-provider.js');
    const unavailable = createApplication(loadConfig(baseEnvironment), {
      database,
      identityProvider: {
        begin: () =>
          Promise.reject(
            new IdentityVerificationError(
              'identity service returned 400 CONFIGURATION_NOT_FOUND',
            ),
          ),
        complete: () => Promise.reject(new Error('unused')),
      },
    });
    const response = await unavailable.app.inject({
      method: 'GET',
      url: '/v1/auth/login',
      query: {
        redirect_uri: 'http://127.0.0.1:53123/callback',
        state: 's'.repeat(24),
        code_challenge: 'c'.repeat(43),
        code_challenge_method: 'S256',
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).not.toContain('CONFIGURATION_NOT_FOUND');
    expect(response.headers['set-cookie']).toBeUndefined();
    await unavailable.app.close();
  });
});
