import { Decimal } from './decimal.js';
import type { DailyPeriod } from './daily.js';
import type { PaymentTiming } from './types.js';
import { Money } from './value-objects.js';

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

/** One repayment period of an amortisation, in full precision unless noted. */
export interface AmortizedPeriod {
  readonly period: number;
  readonly opening: Decimal;
  readonly interest: Decimal;
  readonly principal: Decimal;
  /** The instalment charged this period (the final one may be smaller). */
  readonly payment: Decimal;
  readonly closing: Decimal;
}

/** Inputs for {@link amortizeMonthly}. */
export interface MonthlyTerms {
  /** Balance the interest runs on (amount financed, or NAF for Pepper/Branded). */
  readonly startingBalance: Decimal;
  /** Annual rate / 12. */
  readonly monthlyRate: Decimal;
  readonly termMonths: number;
  /** The level instalment charged. */
  readonly payment: Decimal;
  /** Residual due after the last instalment. */
  readonly balloon: Decimal;
  readonly timing: PaymentTiming;
}

/**
 * Monthly-compounding amortisation.
 *
 * - Interest for a period is `opening × monthly rate`, rounded to the cent (as lenders show
 *   it). An advance loan's first instalment is paid at settlement, so it carries no interest
 *   and goes entirely to principal.
 * - The balloon is carried as its present value at each payment, so the loan closes on it
 *   at maturity rather than on zero.
 * - The final instalment (or any instalment that would overpay) is set to exactly what
 *   remains, so cent rounding or a rounded-up instalment never collects too much. If the
 *   balance reaches zero early the schedule stops there.
 */
export function amortizeMonthly(terms: MonthlyTerms): AmortizedPeriod[] {
  const { monthlyRate, termMonths, payment, balloon, timing } = terms;
  let balance = terms.startingBalance;
  const rows: AmortizedPeriod[] = [];
  for (let period = 1; period <= termMonths; period += 1) {
    const opening = balance;
    const interest = Money.from(
      period === 1 && timing === 'advance' ? ZERO : opening.mul(monthlyRate),
    )
      .roundCents()
      .decimal();
    // The balloon is due at month n; the last advance payment is at n - 1.
    const residual = balloon.div(
      ONE.plus(monthlyRate).pow(
        termMonths - period + (timing === 'advance' ? 1 : 0),
      ),
    );
    let principal = payment.minus(interest);
    let charged = payment;
    if (
      period === termMonths ||
      principal.greaterThan(opening.minus(residual))
    ) {
      principal = opening.minus(residual);
      charged = principal.plus(interest);
    }
    balance = opening.minus(principal);
    rows.push({
      period,
      opening,
      interest,
      principal,
      payment: charged,
      closing: balance,
    });
    if (balance.isZero()) break;
  }
  return rows;
}

/** Inputs for {@link amortizeDaily}. */
export interface DailyTerms {
  readonly periods: readonly DailyPeriod[];
  /** Annual rate / 365. */
  readonly dailyRate: Decimal;
  readonly startingBalance: Decimal;
  readonly payment: Decimal;
  readonly balloon: Decimal;
  /**
   * `false`: every period charges `payment` (the solved payment already lands on the
   * balloon at maturity). `true`: the instalment was rounded up, so the final one (or any
   * that would overpay) is reduced to exactly what remains above the balloon.
   */
  readonly settleFinalInstalment: boolean;
}

/**
 * Daily-interest amortisation (Autopay/MoneyMe): interest = balance × annual rate / 365 ×
 * actual days in the period (the first period already counts settlement day), kept in
 * full precision.
 */
export function amortizeDaily(terms: DailyTerms): AmortizedPeriod[] {
  const { periods, dailyRate, payment, balloon, settleFinalInstalment } = terms;
  let balance = terms.startingBalance;
  const rows: AmortizedPeriod[] = [];
  for (const [index, { period, days }] of periods.entries()) {
    const opening = balance;
    const interest = opening.mul(dailyRate).mul(days);
    let principal = payment.minus(interest);
    let charged = payment;
    if (
      settleFinalInstalment &&
      (index === periods.length - 1 ||
        principal.greaterThan(opening.minus(balloon)))
    ) {
      principal = opening.minus(balloon);
      charged = principal.plus(interest);
    }
    balance = opening.minus(principal);
    rows.push({
      period,
      opening,
      interest,
      principal,
      payment: charged,
      closing: balance,
    });
    if (settleFinalInstalment && balance.isZero()) break;
  }
  return rows;
}

/** Sum of the instalments as charged (each rounded to the cent). */
export function sumInstalments(rows: readonly AmortizedPeriod[]): Decimal {
  return rows.reduce(
    (total, row) => total.plus(Money.from(row.payment).roundCents().decimal()),
    ZERO,
  );
}
