import {
  dealWriteSchema,
  feeSignatureCreateSchema,
  feeSignatureDefinitionSchema,
  lenderCreateSchema,
  lenderUpdateSchema,
  listQuerySchema,
  quoteCreateSchema,
  quoteUpdateSchema,
  uuidSchema,
} from '@swyft/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DealService } from '../deals/deal-service.js';
import type { AuthService } from '../identity/auth-service.js';
import type { LenderService } from '../lenders/lender-service.js';
import { maxLogoBytes } from '../storage/logo-storage.js';
import { rateLimited, unauthenticated, validationFailed } from './errors.js';
import { FixedWindowLimiter, overLimit } from './rate-limit.js';
import { parse, principalOf } from './validation.js';

/** Business services behind the authenticated routes. */
export interface ProtectedRouteServices {
  readonly auth: AuthService;
  readonly deals: DealService;
  readonly lenders: LenderService;
}

/** Per-minute budgets for the signed-in routes, counted per instance (see rate-limit.ts). */
export interface ProtectedRateLimits {
  /**
   * Bearer tokens per client IP that fail the session lookup. Once spent, further tokens
   * from that IP are refused without touching the database until the window ends.
   */
  readonly failedTokensPerIp: number;
  /** Every signed-in request, per account. */
  readonly requestsPerAccount: number;
  /** POST, PUT, PATCH and DELETE per account: each writes to the database. */
  readonly writesPerAccount: number;
  /** Logo downloads and uploads per account: up to 512 KB of egress or storage each. */
  readonly logoTransfersPerAccount: number;
}

/**
 * Production budgets, set well above real use: the app makes about four requests at
 * start-up plus one per logo (cached for the session) and one per broker action, and its
 * live preview runs locally. A refresh or sign-out elsewhere costs one failed lookup.
 */
export const defaultProtectedRateLimits: ProtectedRateLimits = {
  failedTokensPerIp: 30,
  requestsPerAccount: 300,
  writesPerAccount: 60,
  logoTransfersPerAccount: 120,
};

// HEAD runs the GET handler, which still reads the object from storage.
const logoTransferRoutes = new Set([
  'GET /v1/lenders/:id/logo',
  'HEAD /v1/lenders/:id/logo',
  'PUT /v1/lenders/:id/logo',
]);

const idParams = z.strictObject({ id: uuidSchema });
const dealParams = z.strictObject({ dealId: uuidSchema });
const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(header);
  return match?.[1];
}

/**
 * Registers every route that needs a signed-in user. The scope's `onRequest` hook runs
 * before routing to handlers, so a route added here can never be reached anonymously.
 * It also enforces the rate limits, before any body is parsed.
 */
export function registerProtectedRoutes(
  app: FastifyInstance,
  services: ProtectedRouteServices,
  rateLimits: Partial<ProtectedRateLimits> = {},
): void {
  const minute = 60_000;
  const perMinute = { ...defaultProtectedRateLimits, ...rateLimits };
  const limits = {
    failedTokens: new FixedWindowLimiter(perMinute.failedTokensPerIp, minute),
    requests: new FixedWindowLimiter(perMinute.requestsPerAccount, minute),
    writes: new FixedWindowLimiter(perMinute.writesPerAccount, minute),
    logoTransfers: new FixedWindowLimiter(
      perMinute.logoTransfersPerAccount,
      minute,
    ),
  };

  app.register(async (scope) => {
    scope.addHook('onRequest', async (request, reply) => {
      // A missing or malformed header costs nothing, so it is not counted.
      const token = bearerToken(request);
      if (!token) throw unauthenticated();
      // A well-formed token costs a database lookup, which anyone could otherwise trigger
      // at will with made-up tokens. Once an IP has spent its failure budget, its tokens
      // are refused here. Refusals count too, so only the first one is logged.
      if (
        limits.failedTokens.exhausted(request.ip) &&
        overLimit(
          limits.failedTokens,
          request.ip,
          'failed-tokens',
          request,
          reply,
        )
      )
        throw rateLimited();
      const principal = await services.auth.authenticate(token);
      if (!principal) {
        limits.failedTokens.hit(request.ip);
        throw unauthenticated();
      }
      request.principal = principal;

      // Keyed by account, not token or IP: refreshing for new tokens or changing networks
      // does not reset the budget, and brokers sharing an office IP do not share one.
      const account = principal.userId;
      const route = `${request.method} ${request.routeOptions.url}`;
      if (
        overLimit(limits.requests, account, 'account', request, reply) ||
        (request.method !== 'GET' &&
          request.method !== 'HEAD' &&
          overLimit(
            limits.writes,
            account,
            'account.writes',
            request,
            reply,
          )) ||
        (logoTransferRoutes.has(route) &&
          overLimit(
            limits.logoTransfers,
            account,
            'account.logo-transfers',
            request,
            reply,
          ))
      )
        throw rateLimited();
    });

    scope.addContentTypeParser(
      ['image/png', 'image/jpeg', 'image/webp'],
      { parseAs: 'buffer', bodyLimit: maxLogoBytes },
      (_request, body, done) => done(null, body),
    );

    scope.get('/v1/me', (request) =>
      services.auth.currentUser(principalOf(request)),
    );

    // Deals and their quote log -------------------------------------------------
    scope.get('/v1/deals', (request) =>
      services.deals.listDeals(
        principalOf(request),
        parse(listQuerySchema, request.query),
      ),
    );
    scope.post('/v1/deals', async (request, reply) => {
      const { name } = parse(dealWriteSchema, request.body);
      return reply
        .status(201)
        .send(await services.deals.createDeal(principalOf(request), name));
    });
    scope.get('/v1/deals/:dealId', (request) =>
      services.deals.getDeal(
        principalOf(request),
        parse(dealParams, request.params).dealId,
      ),
    );
    scope.patch('/v1/deals/:dealId', (request) => {
      const { name } = parse(dealWriteSchema, request.body);
      return services.deals.renameDeal(
        principalOf(request),
        parse(dealParams, request.params).dealId,
        name,
      );
    });
    scope.delete('/v1/deals/:dealId', async (request, reply) => {
      await services.deals.deleteDeal(
        principalOf(request),
        parse(dealParams, request.params).dealId,
      );
      return reply.status(204).send();
    });
    scope.get('/v1/deals/:dealId/quotes', async (request) => ({
      items: await services.deals.listQuotes(
        principalOf(request),
        parse(dealParams, request.params).dealId,
      ),
    }));
    scope.post('/v1/deals/:dealId/quotes', async (request, reply) => {
      const key = idempotencyKeySchema.safeParse(
        request.headers['idempotency-key'],
      );
      if (!key.success)
        throw validationFailed({
          'Idempotency-Key': 'Send a unique 8–128 character key.',
        });
      const { dealId } = parse(dealParams, request.params);
      const body = parse(quoteCreateSchema, request.body);
      const saved = await services.deals.createQuote(
        principalOf(request),
        dealId,
        key.data,
        body,
      );
      return reply.status(saved.replayed ? 200 : 201).send(saved.quote);
    });
    scope.delete('/v1/deals/:dealId/quotes', async (request) => ({
      deleted: await services.deals.clearQuotes(
        principalOf(request),
        parse(dealParams, request.params).dealId,
      ),
    }));
    scope.get('/v1/quotes/:id', (request) =>
      services.deals.getQuote(
        principalOf(request),
        parse(idParams, request.params).id,
      ),
    );
    scope.patch('/v1/quotes/:id', (request) =>
      services.deals.updateQuoteNotes(
        principalOf(request),
        parse(idParams, request.params).id,
        parse(quoteUpdateSchema, request.body).notes,
      ),
    );
    scope.delete('/v1/quotes/:id', async (request, reply) => {
      await services.deals.deleteQuote(
        principalOf(request),
        parse(idParams, request.params).id,
      );
      return reply.status(204).send();
    });

    // Lenders and logos ------------------------------------------------------------
    scope.get('/v1/lenders', async (request) => ({
      items: await services.lenders.listLenders(principalOf(request)),
    }));
    scope.post('/v1/lenders', async (request, reply) =>
      reply
        .status(201)
        .send(
          await services.lenders.createLender(
            principalOf(request),
            parse(lenderCreateSchema, request.body),
          ),
        ),
    );
    scope.patch('/v1/lenders/:id', (request) =>
      services.lenders.updateLender(
        principalOf(request),
        parse(idParams, request.params).id,
        parse(lenderUpdateSchema, request.body),
      ),
    );
    scope.delete('/v1/lenders/:id', async (request, reply) => {
      await services.lenders.deleteLender(
        principalOf(request),
        parse(idParams, request.params).id,
      );
      return reply.status(204).send();
    });
    scope.get('/v1/lenders/:id/logo', async (request, reply) => {
      const logo = await services.lenders.getLogo(
        principalOf(request),
        parse(idParams, request.params).id,
      );
      return reply
        .header('content-type', logo.contentType)
        .header('cache-control', 'private, max-age=300')
        .header('content-security-policy', "default-src 'none'")
        .send(logo.bytes);
    });
    scope.put('/v1/lenders/:id/logo', (request) => {
      if (!Buffer.isBuffer(request.body))
        throw validationFailed({ body: 'Upload a PNG, JPEG or WebP image.' });
      return services.lenders.putLogo(
        principalOf(request),
        parse(idParams, request.params).id,
        String(request.headers['content-type'] ?? '')
          .split(';')[0]
          ?.trim() ?? '',
        request.body,
      );
    });
    scope.delete('/v1/lenders/:id/logo', async (request, reply) => {
      await services.lenders.deleteLogo(
        principalOf(request),
        parse(idParams, request.params).id,
      );
      return reply.status(204).send();
    });

    // Fee signatures ---------------------------------------------------------------
    scope.get('/v1/fee-signatures', async (request) => ({
      items: await services.lenders.listFeeSignatures(principalOf(request)),
    }));
    scope.post('/v1/fee-signatures', async (request, reply) =>
      reply
        .status(201)
        .send(
          await services.lenders.createFeeSignature(
            principalOf(request),
            parse(feeSignatureCreateSchema, request.body),
          ),
        ),
    );
    scope.get('/v1/fee-signatures/:id', (request) =>
      services.lenders.getFeeSignature(
        principalOf(request),
        parse(idParams, request.params).id,
      ),
    );
    scope.put('/v1/fee-signatures/:id', (request) =>
      services.lenders.updateFeeSignature(
        principalOf(request),
        parse(idParams, request.params).id,
        parse(feeSignatureDefinitionSchema, request.body),
      ),
    );
    scope.delete('/v1/fee-signatures/:id', async (request, reply) => {
      await services.lenders.deleteFeeSignature(
        principalOf(request),
        parse(idParams, request.params).id,
      );
      return reply.status(204).send();
    });
  });
}
