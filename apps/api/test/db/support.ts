import { createHash, randomBytes } from 'node:crypto';
import type { TokenResponseDto } from '@swyft/contracts';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { inject } from 'vitest';
import { defaultSessionPolicy, type ApiConfig } from '../../src/config.js';
import { createApplication } from '../../src/composition.js';
import type { Database, Principal } from '../../src/db/database.js';
import { hashSecret } from '../../src/identity/tokens.js';
import { MemoryLogoStorage } from '../../src/storage/logo-storage.js';

export const presetIds = {
  pepperLender: '00000000-0000-4000-8000-000000000001',
  pepperDealer: '00000000-0000-4000-8000-000000000101',
  westpacDealer: '00000000-0000-4000-8000-000000000301',
  westpacPrivate: '00000000-0000-4000-8000-000000000302',
  brandedDealer: '00000000-0000-4000-8000-000000000401',
  autopay: '00000000-0000-4000-8000-000000000501',
  metro: '00000000-0000-4000-8000-000000000601',
} as const;

const publicBaseUrl = 'http://127.0.0.1:8080';

export function testConfig(): ApiConfig {
  const db = inject('testDatabase');
  return {
    environment: 'test',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    trustProxyHops: 0,
    publicBaseUrl: new URL(publicBaseUrl),
    database: {
      host: db.host,
      port: db.port,
      name: db.database,
      user: 'swyft_app',
      password: db.appPassword,
      poolMax: 4,
      ssl: false,
    },
    identity: { kind: 'dev' },
    logos: { kind: 'memory' },
    session: defaultSessionPolicy,
  };
}

export interface TestApp {
  readonly app: FastifyInstance;
  readonly database: Database;
  readonly storage: MemoryLogoStorage;
  close(): Promise<void>;
}

/** The real application (dev identity provider, memory logos) against the test database. */
export async function createTestApp(): Promise<TestApp> {
  const storage = new MemoryLogoStorage();
  const { app, database } = createApplication(testConfig(), {
    logoStorage: storage,
    // Suites sign in many users from one IP; limiter behaviour has its own unit tests.
    authRateLimits: {
      login: 10_000,
      callback: 10_000,
      token: 10_000,
      logout: 10_000,
    },
    protectedRateLimits: {
      failedTokensPerIp: 10_000,
      requestsPerAccount: 10_000,
      writesPerAccount: 10_000,
      logoTransfersPerAccount: 10_000,
    },
  });
  await app.ready();
  return {
    app,
    database,
    storage,
    async close() {
      await app.close();
      await database.close();
    },
  };
}

/** Connects as the migration owner, for arranging state the API cannot (e.g. expiry). */
export async function ownerClient(): Promise<pg.Client> {
  const db = inject('testDatabase');
  const client = new pg.Client({
    host: db.host,
    port: db.port,
    database: db.database,
    user: 'swyft_owner',
    password: db.ownerPassword,
  });
  await client.connect();
  return client;
}

/** Connects as the runtime role directly, for policy tests that bypass the API. */
export async function appRoleClient(): Promise<pg.Client> {
  const db = inject('testDatabase');
  const client = new pg.Client({
    host: db.host,
    port: db.port,
    database: db.database,
    user: 'swyft_app',
    password: db.appPassword,
  });
  await client.connect();
  return client;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
}

export interface BrowserLogin {
  readonly code: string;
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
}

/**
 * Drives the browser half of sign-in through the real routes with the dev provider:
 * login start → provider page → callback with the attempt cookie → loopback redirect.
 */
export async function browserLogin(
  app: FastifyInstance,
  email: string,
): Promise<BrowserLogin> {
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(24).toString('base64url');
  const redirectUri = `http://127.0.0.1:${40_000 + Math.floor(Math.random() * 20_000)}/callback`;
  const start = await app.inject({
    method: 'GET',
    url: '/v1/auth/login',
    query: {
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    },
  });
  if (start.statusCode !== 302)
    throw new Error(`login start failed: ${start.statusCode}`);
  const cookie = String(start.headers['set-cookie']).split(';')[0] ?? '';
  const providerUrl = new URL(String(start.headers.location));
  const session = providerUrl.searchParams.get('session') ?? '';
  const callback = await app.inject({
    method: 'GET',
    url: `/v1/auth/callback?dev_session=${encodeURIComponent(session)}&email=${encodeURIComponent(email)}`,
    headers: { cookie },
  });
  if (callback.statusCode !== 302)
    throw new Error(`callback failed: ${callback.statusCode}`);
  const loopback = new URL(String(callback.headers.location));
  return {
    code: loopback.searchParams.get('code') ?? '',
    state: loopback.searchParams.get('state') ?? '',
    verifier,
    redirectUri,
  };
}

export interface SignedInUser {
  readonly tokens: TokenResponseDto;
  readonly principal: Principal;
  readonly headers: { authorization: string };
}

/** Full sign-in: browser login plus PKCE code exchange. */
export async function signIn(
  app: FastifyInstance,
  email: string,
): Promise<SignedInUser> {
  const login = await browserLogin(app, email);
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/token',
    payload: {
      grantType: 'authorization_code',
      code: login.code,
      codeVerifier: login.verifier,
      redirectUri: login.redirectUri,
    },
  });
  if (response.statusCode !== 200)
    throw new Error(`token exchange failed: ${response.statusCode}`);
  const tokens = response.json<TokenResponseDto>();
  return {
    tokens,
    principal: {
      userId: tokens.user.id,
      sessionId: '',
      accessTokenHash: hashSecret(tokens.accessToken),
    },
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  };
}

export function uniqueEmail(label: string): string {
  return `${label}-${randomBytes(4).toString('hex')}@example.test`;
}

/** Minimal valid PNG (1×1). */
export const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
