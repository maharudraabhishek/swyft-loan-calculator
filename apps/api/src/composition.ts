import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import type { ApiConfig } from './config.js';
import { Database } from './db/database.js';
import { DealService } from './deals/deal-service.js';
import type { AuthRateLimits } from './identity/auth-routes.js';
import { AuthService } from './identity/auth-service.js';
import {
  DevIdentityProvider,
  IdentityPlatformProvider,
  type IdentityProvider,
} from './identity/identity-provider.js';
import { LenderService } from './lenders/lender-service.js';
import {
  GcsLogoStorage,
  MemoryLogoStorage,
  type LogoStorage,
} from './storage/logo-storage.js';

export interface Application {
  readonly app: FastifyInstance;
  readonly database: Database;
}

export interface Overrides {
  readonly database?: Database;
  readonly identityProvider?: IdentityProvider;
  readonly logoStorage?: LogoStorage;
  readonly authRateLimits?: Partial<AuthRateLimits>;
}

/** Wires adapters to services. The only place that chooses concrete implementations. */
export function createApplication(
  config: ApiConfig,
  overrides: Overrides = {},
): Application {
  const database = overrides.database ?? Database.fromConfig(config);
  const identityProvider =
    overrides.identityProvider ??
    (config.identity.kind === 'identity-platform'
      ? new IdentityPlatformProvider(
          config.identity.apiKey,
          config.identity.projectId,
        )
      : new DevIdentityProvider(config.publicBaseUrl));
  const logoStorage =
    overrides.logoStorage ??
    (config.logos.kind === 'gcs'
      ? new GcsLogoStorage(config.logos.bucket)
      : new MemoryLogoStorage());

  const callbackUrl = new URL('/v1/auth/callback', config.publicBaseUrl).href;
  const auth = new AuthService(
    database,
    identityProvider,
    config.session,
    callbackUrl,
  );
  const app = buildApp({
    logLevel: config.logLevel,
    trustProxyHops: config.trustProxyHops,
    publicBaseUrl: config.publicBaseUrl,
    devIdentityProvider: config.identity.kind === 'dev',
    ...(overrides.authRateLimits && {
      authRateLimits: overrides.authRateLimits,
    }),
    isReady: async () => {
      await database.ping();
      return true;
    },
    auth,
    deals: new DealService(database),
    lenders: new LenderService(database, logoStorage, (key) =>
      app.log.warn(
        { code: 'LOGO_ORPHANED', key },
        'Logo object could not be removed',
      ),
    ),
  });
  return { app, database };
}
