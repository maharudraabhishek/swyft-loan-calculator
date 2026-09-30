import { Decimal } from 'decimal.js';

/**
 * Display formatting for decimal-string values from the API and the local preview.
 * Everything here is presentation only: results are never parsed back into requests,
 * so display rounding cannot change a calculation. Money is AUD; rates arrive as annual
 * fractions (`"0.085"` = 8.50%).
 */

const halfUp = Decimal.ROUND_HALF_UP;

function groupThousands(integerDigits: string): string {
  return integerDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fixed(value: Decimal, places: number): string {
  const rounded = value.toDecimalPlaces(places, halfUp);
  const [whole = '0', fraction] = rounded.abs().toFixed(places).split('.');
  const body =
    fraction === undefined
      ? groupThousands(whole)
      : `${groupThousands(whole)}.${fraction}`;
  return rounded.isNegative() && !rounded.isZero() ? `-${body}` : body;
}

/** `"1234.5"` → `"$1,234.50"`. */
export function formatMoney(value: string): string {
  const amount = new Decimal(value);
  const text = fixed(amount, 2);
  return text.startsWith('-') ? `-$${text.slice(1)}` : `$${text}`;
}

/**
 * Email style from the brief (`$ 500`, `$ 2,020`): whole dollars when there are no
 * cents, otherwise two decimals so an amount such as $8.25 is never misstated.
 */
export function formatMoneyForEmail(value: string): string {
  const amount = new Decimal(value);
  const places = amount.isInteger() ? 0 : 2;
  return `$ ${fixed(amount, places)}`;
}

/** `"0.085"` → `"8.50%"`. */
export function formatRate(fraction: string, places = 2): string {
  return `${new Decimal(fraction).mul(100).toFixed(places, halfUp)}%`;
}

/** Trailing zeros removed: `"0.04"` → `"4%"`, `"0.0408"` → `"4.08%"`. */
export function formatRateCompact(fraction: string): string {
  const percent = new Decimal(fraction).mul(100).toDecimalPlaces(2, halfUp);
  return `${percent.toString()}%`;
}

/** User-entered percent (`"8.5"`) → annual fraction string (`"0.085"`), exactly. */
export function percentToFraction(percent: string): string {
  return new Decimal(percent).div(100).toString();
}

/** Annual fraction (`"0.085"`) → editable percent text (`"8.5"`). */
export function fractionToPercent(fraction: string): string {
  return new Decimal(fraction).mul(100).toString();
}

/** `60` → `"60 months"`. */
export function formatTerm(months: number): string {
  return `${months} ${months === 1 ? 'month' : 'months'}`;
}

/** Brief: a zero residual is written "NIL"; otherwise amount and share of the finance amount. */
export function formatResidual(balloon: string, financeAmount: string): string {
  const amount = new Decimal(balloon);
  if (amount.isZero()) return 'NIL';
  const base = new Decimal(financeAmount);
  if (base.isZero()) return formatMoney(balloon);
  const share = amount.div(base).mul(100).toDecimalPlaces(1, halfUp);
  return `${formatMoney(balloon)} (${share.toString()}%)`;
}

const dateFormat = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** ISO timestamp or `YYYY-MM-DD` → `29 Sep 2026` (local time for timestamps). */
export function formatDate(iso: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(iso)
    ? new Date(`${iso}T00:00:00`)
    : new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateFormat.format(date);
}

/** True for a decimal string greater than zero; false for anything unparsable. */
export function isPositiveAmount(value: string): boolean {
  try {
    return new Decimal(value).greaterThan(0);
  } catch {
    return false;
  }
}
