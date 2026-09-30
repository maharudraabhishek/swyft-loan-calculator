import { z } from 'zod';

const booleanFlag = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** Externally visible origin, used to build OAuth callback URLs. Never derived from Host. */
    PUBLIC_BASE_URL: z.url(),
    DB_HOST: z.string().min(1),
    DB_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),
    DB_NAME: z.string().min(1),
    DB_USER: z.string().min(1),
    DB_PASSWORD: z.string().min(1),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
    DB_SSL: booleanFlag.default(false),
    IDENTITY_PROVIDER: z.enum(['identity-platform', 'dev']),
    GCIP_API_KEY: z.string().min(1).optional(),
    GCIP_PROJECT_ID: z.string().min(1).optional(),
    LOGO_STORAGE: z.enum(['gcs', 'memory']),
    LOGO_BUCKET: z.string().min(3).max(222).optional(),
    /** 1 on Cloud Run: trust exactly the Google front end's X-Forwarded-For entry. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(1).default(0),
  })
  .superRefine((env, context) => {
    const issue = (path: string, message: string) =>
      context.addIssue({ code: 'custom', path: [path], message });
    if (env.IDENTITY_PROVIDER === 'identity-platform') {
      if (!env.GCIP_API_KEY)
        issue('GCIP_API_KEY', 'required for identity-platform');
      if (!env.GCIP_PROJECT_ID)
        issue('GCIP_PROJECT_ID', 'required for identity-platform');
    }
    if (env.LOGO_STORAGE === 'gcs' && !env.LOGO_BUCKET)
      issue('LOGO_BUCKET', 'required for gcs storage');
    if (env.NODE_ENV === 'production') {
      // Development conveniences can never be switched on in production.
      if (env.IDENTITY_PROVIDER === 'dev')
        issue('IDENTITY_PROVIDER', 'dev is not allowed in production');
      if (env.LOGO_STORAGE === 'memory')
        issue('LOGO_STORAGE', 'memory is not allowed in production');
      if (!env.PUBLIC_BASE_URL.startsWith('https://'))
        issue('PUBLIC_BASE_URL', 'must be https in production');
    }
  });

/** How long each sign-in artefact lives (see `defaultSessionPolicy` for the values). */
export interface SessionPolicy {
  /** Access (bearer) token lifetime. */
  readonly accessTtlSeconds: number;
  /** A session ends if it is not refreshed for this long. */
  readonly refreshIdleTtlSeconds: number;
  /** A session ends this long after sign-in, however active. */
  readonly refreshAbsoluteTtlSeconds: number;
  /**
   * If the response carrying a new refresh token is lost, the app may present the
   * just-used token again within this window and get another rotation; any other reuse
   * revokes the whole session.
   */
  readonly refreshReuseGraceSeconds: number;
  /** Time allowed to finish Google sign-in in the browser. */
  readonly loginAttemptTtlSeconds: number;
  /** Lifetime of the single-use code handed to the app's loopback address. */
  readonly authorizationCodeTtlSeconds: number;
}

/** Validated API configuration, read once from environment variables at startup. */
export interface ApiConfig {
  readonly environment: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly trustProxyHops: 0 | 1;
  readonly publicBaseUrl: URL;
  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly name: string;
    readonly user: string;
    readonly password: string;
    readonly poolMax: number;
    readonly ssl: boolean;
  };
  readonly identity:
    | {
        readonly kind: 'identity-platform';
        readonly apiKey: string;
        readonly projectId: string;
      }
    | { readonly kind: 'dev' };
  readonly logos:
    | { readonly kind: 'gcs'; readonly bucket: string }
    | { readonly kind: 'memory' };
  readonly session: SessionPolicy;
}

/** Session lifetimes. Fixed in code so changes go through review rather than config. */
export const defaultSessionPolicy: SessionPolicy = {
  accessTtlSeconds: 15 * 60,
  refreshIdleTtlSeconds: 14 * 24 * 60 * 60,
  refreshAbsoluteTtlSeconds: 30 * 24 * 60 * 60,
  refreshReuseGraceSeconds: 30,
  loginAttemptTtlSeconds: 10 * 60,
  authorizationCodeTtlSeconds: 2 * 60,
};

/** Startup configuration problems. Lists variable names only, never values (they may be secrets). */
export class ConfigurationError extends Error {
  constructor(readonly problems: readonly string[]) {
    // Names only: values may be secrets.
    super(`Invalid configuration: ${problems.join('; ')}`);
    this.name = 'ConfigurationError';
  }
}

/** Parses environment variables once at startup. Missing or unsafe values stop the process. */
export function loadConfig(environment: NodeJS.ProcessEnv): ApiConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success)
    throw new ConfigurationError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join('.')}: ${issue.message}`,
      ),
    );
  const env = parsed.data;
  return {
    environment: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    trustProxyHops: env.TRUST_PROXY_HOPS === 1 ? 1 : 0,
    publicBaseUrl: new URL(env.PUBLIC_BASE_URL),
    database: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      name: env.DB_NAME,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      poolMax: env.DB_POOL_MAX,
      ssl: env.DB_SSL,
    },
    identity:
      env.IDENTITY_PROVIDER === 'identity-platform' &&
      env.GCIP_API_KEY &&
      env.GCIP_PROJECT_ID
        ? {
            kind: 'identity-platform',
            apiKey: env.GCIP_API_KEY,
            projectId: env.GCIP_PROJECT_ID,
          }
        : { kind: 'dev' },
    logos:
      env.LOGO_STORAGE === 'gcs' && env.LOGO_BUCKET
        ? { kind: 'gcs', bucket: env.LOGO_BUCKET }
        : { kind: 'memory' },
    session: defaultSessionPolicy,
  };
}
