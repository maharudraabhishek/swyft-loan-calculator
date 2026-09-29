import { Decimal } from 'decimal.js';
import {
  paymentFrequencies,
  type DisplayOptions,
  type PaymentFrequency,
} from '@swyft/contracts';
import { formatMoney } from './format';

/** Payments per year used by the brief's simple conversion from the monthly amount. */
const paymentsPerYear: Record<PaymentFrequency, number> = {
  monthly: 12,
  fortnightly: 26,
  weekly: 52,
};

/**
 * Brief: fortnightly = monthly / (26/12), weekly = monthly / (52/12). Computed exactly
 * as monthly × 12 / n with Decimal from the displayed cent amount, then rounded half-up
 * to cents — e.g. $650.68 → $300.31 fortnightly and $150.16 weekly.
 */
export function convertMonthlyAmount(
  monthly: string,
  frequency: PaymentFrequency,
): string {
  return new Decimal(monthly)
    .mul(12)
    .div(paymentsPerYear[frequency])
    .toFixed(2, Decimal.ROUND_HALF_UP);
}

/** Frequencies to show, in brief order; never empty (falls back to monthly). */
export function selectedFrequencies(
  display: DisplayOptions,
): readonly PaymentFrequency[] {
  const chosen = paymentFrequencies.filter(
    (frequency) => display.frequencies[frequency],
  );
  return chosen.length > 0 ? chosen : ['monthly'];
}

/** Brief: `(incl. $12.50 monthly fee)` or `(no monthly fees)`. */
export function monthlyFeeNote(monthlyFee: string): string {
  return new Decimal(monthlyFee).isZero()
    ? '(no monthly fees)'
    : `(incl. ${formatMoney(monthlyFee)} monthly fee)`;
}

export interface RepaymentPart {
  readonly frequency: PaymentFrequency;
  readonly amount: string;
  /** e.g. `$650.68 (monthly) (no monthly fees)` */
  readonly text: string;
}

export interface RepaymentSource {
  readonly grossMonthlyPayment: string;
  readonly monthlyFee: string;
}

/**
 * The repayment a client pays: the gross monthly payment (instalment + monthly fee), as
 * in the brief's Branded example and the reference calculator, converted per frequency.
 */
export function repaymentParts(
  quote: RepaymentSource,
  display: DisplayOptions,
): readonly RepaymentPart[] {
  const note = monthlyFeeNote(quote.monthlyFee);
  return selectedFrequencies(display).map((frequency) => {
    const amount = convertMonthlyAmount(quote.grossMonthlyPayment, frequency);
    return {
      frequency,
      amount,
      text: `${formatMoney(amount)} (${frequency}) ${note}`,
    };
  });
}

/** `$650.68 (monthly) (no monthly fees) OR $300.31 (fortnightly) (no monthly fees)` */
export function formatRepayments(
  quote: RepaymentSource,
  display: DisplayOptions,
): string {
  return repaymentParts(quote, display)
    .map((part) => part.text)
    .join(' OR ');
}
