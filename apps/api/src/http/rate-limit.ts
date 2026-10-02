import type { FastifyReply, FastifyRequest } from 'fastify';

/** A hit over the limit. */
export interface RateLimitRejection {
  /** Seconds until the key's window resets (the `Retry-After` value). */
  readonly retryAfterSeconds: number;
  /** True only for the key's first rejection in a window, so a flood logs one line. */
  readonly first: boolean;
}

/**
 * Small fixed-window limiter.
 *
 * Scope and limits, stated plainly: counters live in one Cloud Run instance (the service
 * runs at most 3), so the effective ceiling is up to 3× the configured value. A shared
 * store (Redis, or counters in PostgreSQL) would cost more than this service does, or
 * add database writes to every request. These limits keep anonymous callers away from
 * the database and stop one account from running up writes or egress; they are not a
 * DDoS control (Cloud Run's instance cap bounds compute cost).
 * Memory is bounded: at most `maxClients` keys, evicting the oldest window first.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<
    string,
    { start: number; count: number }
  >();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxClients = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one event for `key`. @returns the rejection when over the limit, otherwise null */
  hit(key: string): RateLimitRejection | null {
    const now = this.now();
    let window = this.live(key, now);
    if (!window) {
      this.windows.delete(key);
      if (this.windows.size >= this.maxClients) {
        const oldest = this.windows.keys().next().value;
        if (oldest !== undefined) this.windows.delete(oldest);
      }
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    window.count += 1;
    if (window.count <= this.limit) return null;
    return {
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((window.start + this.windowMs - now) / 1000),
      ),
      first: window.count === this.limit + 1,
    };
  }

  /** True when `key` has used its whole budget in the current window. Counts nothing. */
  exhausted(key: string): boolean {
    const window = this.live(key, this.now());
    return window !== undefined && window.count >= this.limit;
  }

  get size(): number {
    return this.windows.size;
  }

  private live(key: string, now: number) {
    const window = this.windows.get(key);
    return window && now - window.start < this.windowMs ? window : undefined;
  }
}

/**
 * Counts this request against `limiter` under `key`. Over the limit it sets `Retry-After`
 * and returns true; the caller then answers 429. Only the first rejection per key and
 * window is logged, so a rejected flood cannot multiply log volume.
 *
 * @param name which limit, for the log (never the key: it is an IP or account ID)
 */
export function overLimit(
  limiter: FixedWindowLimiter,
  key: string,
  name: string,
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const rejection = limiter.hit(key);
  if (rejection === null) return false;
  reply.header('retry-after', String(rejection.retryAfterSeconds));
  if (rejection.first)
    request.log.warn(
      { code: 'RATE_LIMITED', limit: name, route: request.routeOptions.url },
      'Rate limit reached',
    );
  return true;
}
