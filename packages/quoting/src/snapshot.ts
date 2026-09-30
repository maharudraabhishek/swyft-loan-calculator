import { AnnualRate, Fraction, Money } from '@swyft/finance';

/** Plain JSON, as stored in the quote snapshot columns (`jsonb`). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Converts finance inputs, results and fee signatures to plain JSON for immutable
 * storage. Decimal values keep full precision as strings; nothing is rounded here.
 */
export function toJsonSnapshot(value: unknown): JsonValue {
  if (
    value instanceof Money ||
    value instanceof AnnualRate ||
    value instanceof Fraction
  )
    return value.toString();
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Snapshot numbers must be finite');
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonSnapshot);
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, toJsonSnapshot(entry)] as const);
    return Object.fromEntries(entries);
  }
  throw new TypeError(`Cannot snapshot a ${typeof value}`);
}
