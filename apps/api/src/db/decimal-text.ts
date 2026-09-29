/**
 * PostgreSQL returns `numeric(p, s)` padded to its scale ("0.0800000000"). Rates are
 * returned to clients in canonical form ("0.08"); the value is unchanged.
 */
export function canonicalDecimal(value: string): string;
export function canonicalDecimal(value: string | null): string | null;
export function canonicalDecimal(value: string | null): string | null {
  if (value === null || !value.includes('.')) return value;
  return value.replace(/\.?0+$/, '');
}
