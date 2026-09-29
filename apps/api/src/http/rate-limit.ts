/**
 * Small fixed-window limiter for the public sign-in endpoints.
 *
 * Scope and limits, stated plainly: counters live in one Cloud Run instance (the service
 * runs at most 3), so the effective ceiling is per instance. It blunts floods of
 * unauthenticated login-attempt writes and token guessing; it is not a DDoS control.
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

  /** @returns seconds to wait when the key is over its limit, otherwise null */
  hit(key: string): number | null {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
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
    return Math.max(1, Math.ceil((window.start + this.windowMs - now) / 1000));
  }

  get size(): number {
    return this.windows.size;
  }
}
