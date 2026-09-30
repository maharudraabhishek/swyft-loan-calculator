import { randomUUID } from 'node:crypto';
import type { ApiErrorDto } from '@swyft/contracts';
import Fastify, { LogController } from 'fastify';
import type { FastifyInstance } from 'fastify';
import { sqlState } from './db/database.js';
import type { DealService } from './deals/deal-service.js';
import { AppError } from './http/errors.js';
import { registerProtectedRoutes } from './http/protected-routes.js';
import type { AuthService } from './identity/auth-service.js';
import {
  registerAuthRoutes,
  type AuthRateLimits,
} from './identity/auth-routes.js';
import type { LenderService } from './lenders/lender-service.js';

/**
 * What the HTTP layer needs: settings plus the business services (auth, deals, lenders)
 * and a readiness probe. `composition.ts` builds the real ones; tests inject their own.
 */
export interface AppDependencies {
  readonly logLevel: string;
  /** Proxy hops to trust for the client IP (Cloud Run: 1). Only used for rate limiting. */
  readonly trustProxyHops: 0 | 1;
  readonly publicBaseUrl: URL;
  readonly devIdentityProvider: boolean;
  readonly authRateLimits?: Partial<AuthRateLimits>;
  /** True when the database answers; drives `/ready`. */
  readonly isReady: () => Promise<boolean>;
  readonly auth: AuthService;
  readonly deals: DealService;
  readonly lenders: LenderService;
}

const cloudSeverity: Readonly<Record<string, string>> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

/** Driver/network failures that mean "try again later" rather than a bug. */
function isUnavailable(error: unknown): boolean {
  const state = sqlState(error);
  if (
    state?.startsWith('08') ||
    state === '57P01' ||
    state === '57P03' ||
    state === '53300'
  )
    return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ECONNREFUSED' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ENOTFOUND')
  );
}

/** Builds the stateless HTTP adapter. Business logic lives in services, not handlers. */
export function buildApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: {
      level: dependencies.logLevel,
      // No machine hostname or pid in entries: Cloud Run labels logs with its own service
      // and revision, and locally the host name only adds noise (it is the PC's name).
      base: null,
      // Cloud Logging reads `severity` and `message`; without them every entry is DEFAULT.
      messageKey: 'message',
      formatters: {
        level: (label: string) => ({
          severity: cloudSeverity[label] ?? 'DEFAULT',
        }),
      },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'request.headers.authorization',
          'request.headers.cookie',
        ],
        censor: '[redacted]',
      },
    },
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024,
    // Behind Cloud Run the socket peer is Google's front end, which appends the real client
    // IP as the rightmost X-Forwarded-For entry; trusting that one hop ignores spoofed
    // entries to its left. Without a proxy, nothing in the header is trusted.
    trustProxy:
      dependencies.trustProxyHops === 1
        ? (_address: string, hop: number) => hop === 0
        : false,
  });

  app.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id);
    done();
  });

  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    if (!reply.hasHeader('cache-control'))
      reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  app.addHook('onResponse', (request, reply, done) => {
    // Route template only: never the URL, which may carry one-time codes.
    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'Request completed',
    );
    done();
  });

  app.get('/health', { logLevel: 'silent' }, () => ({ status: 'ok' }) as const);
  app.get('/ready', { logLevel: 'silent' }, async (_request, reply) => {
    const ready = await dependencies.isReady().catch(() => false);
    return reply
      .status(ready ? 200 : 503)
      .send({ status: ready ? 'ready' : 'unavailable' });
  });

  registerAuthRoutes(app, {
    auth: dependencies.auth,
    publicBaseUrl: dependencies.publicBaseUrl,
    devProvider: dependencies.devIdentityProvider,
    ...(dependencies.authRateLimits && {
      rateLimits: dependencies.authRateLimits,
    }),
  });
  registerProtectedRoutes(app, dependencies);

  app.setNotFoundHandler((request, reply) => {
    const body: ApiErrorDto = {
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found.',
        requestId: request.id,
      },
    };
    return reply.status(404).send(body);
  });

  app.setErrorHandler((error, request, reply) => {
    let status: number;
    let body: ApiErrorDto['error'];
    if (error instanceof AppError) {
      status = error.statusCode;
      body = {
        code: error.code,
        message: error.message,
        requestId: request.id,
        ...(error.fields && { fields: { ...error.fields } }),
      };
    } else if (sqlState(error) === '22003') {
      // Numeric overflow: inputs within schema limits produced an out-of-range result.
      status = 400;
      body = {
        code: 'VALIDATION_FAILED',
        message: 'The values are outside the supported range.',
        requestId: request.id,
      };
    } else if (isUnavailable(error)) {
      status = 503;
      body = {
        code: 'SERVICE_UNAVAILABLE',
        message: 'The service is temporarily unavailable. Try again shortly.',
        requestId: request.id,
      };
    } else {
      const reported =
        typeof error === 'object' && error !== null && 'statusCode' in error
          ? error.statusCode
          : undefined;
      status =
        typeof reported === 'number' && reported >= 400 && reported < 500
          ? reported
          : 500;
      body = {
        code:
          status === 413
            ? 'PAYLOAD_TOO_LARGE'
            : status === 415
              ? 'UNSUPPORTED_MEDIA_TYPE'
              : status === 500
                ? 'INTERNAL_ERROR'
                : 'BAD_REQUEST',
        message:
          status === 500
            ? 'An unexpected error occurred.'
            : 'Request could not be processed.',
        requestId: request.id,
      };
    }
    // Stable category and error class only: raw messages may contain SQL, credentials or
    // private data. SQLSTATE codes are safe and make database failures diagnosable.
    const log =
      status >= 500
        ? request.log.error.bind(request.log)
        : request.log.warn.bind(request.log);
    log(
      {
        requestId: request.id,
        code: body.code,
        statusCode: status,
        ...(status >= 500 && {
          errorType: error instanceof Error ? error.name : typeof error,
          ...(sqlState(error) && { sqlState: sqlState(error) }),
        }),
      },
      'Request failed',
    );
    return reply.status(status).send({ error: body } satisfies ApiErrorDto);
  });

  return app;
}
