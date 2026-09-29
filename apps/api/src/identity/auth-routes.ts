import {
  loginStartQuerySchema,
  logoutRequestSchema,
  tokenRequestSchema,
} from '@swyft/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { FixedWindowLimiter } from '../http/rate-limit.js';
import { parse } from '../http/validation.js';
import type { AuthService } from './auth-service.js';
import { IdentityVerificationError } from './identity-provider.js';

export interface AuthRouteOptions {
  readonly auth: AuthService;
  readonly publicBaseUrl: URL;
  readonly devProvider: boolean;
  /** Requests per minute per client IP; defaults suit production. */
  readonly rateLimits?: Partial<AuthRateLimits>;
}

export interface AuthRateLimits {
  readonly login: number;
  readonly callback: number;
  readonly token: number;
  readonly logout: number;
}

export const defaultAuthRateLimits: AuthRateLimits = {
  login: 20,
  callback: 30,
  token: 60,
  logout: 30,
};

const invalidGrant = () =>
  new AppError(
    401,
    'UNAUTHENTICATED',
    'Your sign-in has expired. Sign in again.',
  );

/**
 * `form-action` also governs the redirects that follow a form submission. The dev consent
 * form posts to /v1/auth/callback, which redirects to the desktop's RFC 8252 loopback
 * receiver on a random 127.0.0.1 / [::1] port; with plain 'self' the browser silently
 * blocks that hop. Only the dev page needs the loopback targets (the API never redirects
 * anywhere else: redirect URIs are validated as loopback when the attempt starts).
 */
const devConsentFormAction = "'self' http://127.0.0.1:* http://[::1]:*";

/** Static page for the browser tab; no user data, scripts or external resources. */
function page(
  reply: FastifyReply,
  status: number,
  title: string,
  body: string,
  formAction = "'self'",
): FastifyReply {
  return reply
    .status(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header(
      'content-security-policy',
      `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}`,
    )
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
        '<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#16324f}</style>' +
        `</head><body><h1>${title}</h1>${body}</body></html>`,
    );
}

function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/**
 * Public sign-in endpoints. The browser cookie binds the provider callback to the
 * browser that started the attempt; `__Host-` pins it to this origin over HTTPS.
 */
export function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRouteOptions,
): void {
  const secure = options.publicBaseUrl.protocol === 'https:';
  const cookieName = secure ? '__Host-swyft_login' : 'swyft_login';
  const cookieAttributes = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const clearCookie = `${cookieName}=; ${cookieAttributes}; Max-Age=0`;

  // Per client IP, per instance (see rate-limit.ts). Login start writes a database row.
  const minute = 60_000;
  const perMinute = { ...defaultAuthRateLimits, ...options.rateLimits };
  const limits = {
    login: new FixedWindowLimiter(perMinute.login, minute),
    callback: new FixedWindowLimiter(perMinute.callback, minute),
    token: new FixedWindowLimiter(perMinute.token, minute),
    logout: new FixedWindowLimiter(perMinute.logout, minute),
  };
  const retryAfter = (
    limiter: FixedWindowLimiter,
    request: FastifyRequest,
    reply: FastifyReply,
  ): number | null => {
    const wait = limiter.hit(request.ip);
    if (wait !== null) {
      reply.header('retry-after', String(wait));
      request.log.warn(
        { code: 'RATE_LIMITED', route: request.routeOptions.url },
        'Rate limited',
      );
    }
    return wait;
  };
  const tooManyPage = (reply: FastifyReply) =>
    page(
      reply,
      429,
      'Too many sign-in attempts',
      '<p>Please wait a minute and try again.</p>',
    );
  const tooMany = () =>
    new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.');

  app.get('/v1/auth/login', async (request, reply) => {
    if (retryAfter(limits.login, request, reply) !== null)
      return tooManyPage(reply);
    const query = parse(loginStartQuerySchema, request.query);
    let started;
    try {
      started = await options.auth.startLogin({
        redirectUri: query.redirect_uri,
        desktopState: query.state,
        codeChallenge: query.code_challenge,
      });
    } catch (error) {
      if (!(error instanceof IdentityVerificationError)) throw error;
      request.log.warn(
        { code: 'IDENTITY_PROVIDER_UNAVAILABLE', reason: error.reason },
        'Sign-in could not start',
      );
      return page(
        reply,
        503,
        'Google sign-in is temporarily unavailable',
        '<p>Please try again in a few minutes. If this keeps happening, contact support.</p>',
      );
    }
    return reply
      .header(
        'set-cookie',
        `${cookieName}=${started.attemptId}.${started.browserSecret}; ${cookieAttributes}; Max-Age=600`,
      )
      .redirect(started.authorizationUrl, 302);
  });

  app.get('/v1/auth/callback', async (request, reply) => {
    if (retryAfter(limits.callback, request, reply) !== null)
      return tooManyPage(reply);
    reply.header('set-cookie', clearCookie);
    const cookie = readCookie(request.headers.cookie, cookieName);
    const [attemptId, browserSecret] = cookie?.split('.') ?? [];
    const expired = () =>
      page(
        reply,
        400,
        'Sign-in link expired',
        '<p>Return to Swyft Finance and choose <strong>Sign in with Google</strong> again.</p>',
      );
    if (!attemptId || !browserSecret || !z.uuid().safeParse(attemptId).success)
      return expired();
    // Built from configuration, never from Host/X-Forwarded headers.
    const callbackUrl = new URL(request.url, options.publicBaseUrl).href;
    const completion = await options.auth.completeLogin({
      attemptId,
      browserSecret,
      callbackUrl,
    });
    if (completion.kind === 'expired') return expired();
    return reply.redirect(completion.location, 302);
  });

  app.post('/v1/auth/token', async (request, reply) => {
    if (retryAfter(limits.token, request, reply) !== null) throw tooMany();
    const body = parse(tokenRequestSchema, request.body);
    if (body.grantType === 'authorization_code') {
      const tokens = await options.auth.exchangeCode(body);
      if (!tokens) throw invalidGrant();
      return tokens;
    }
    const outcome = await options.auth.refresh(body.refreshToken);
    if (outcome.kind !== 'rotated') throw invalidGrant();
    return outcome.tokens;
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    if (retryAfter(limits.logout, request, reply) !== null) throw tooMany();
    const body = parse(logoutRequestSchema, request.body);
    await options.auth.logout(body.refreshToken);
    return reply.status(204).send();
  });

  if (options.devProvider) {
    // Local stand-in for the Google consent screen. Registered only with IDENTITY_PROVIDER=dev.
    app.get('/v1/auth/dev/authorize', (request, reply) => {
      const { session } = parse(
        z.strictObject({ session: z.string().regex(/^[A-Za-z0-9_-]{10,64}$/) }),
        request.query,
      );
      return page(
        reply,
        200,
        'Development sign-in',
        '<p>Local development only. No Google account is used.</p>' +
          '<form method="get" action="/v1/auth/callback">' +
          `<input type="hidden" name="dev_session" value="${session}">` +
          '<label>Email <input name="email" type="email" required autofocus></label> ' +
          '<button type="submit">Continue</button></form>',
        devConsentFormAction,
      );
    });
  }
}
