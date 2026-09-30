import { Decimal } from './decimal.js';
import {
  addMonthsOnAnchor,
  daysBetween,
  isoDate,
  nextBusinessDay,
  parseDate,
} from './dates.js';
import type { AutopayInput } from './types.js';

type DailyDates = Pick<
  AutopayInput,
  'termMonths' | 'settlementDate' | 'firstRepaymentDate' | 'adjustBusinessDays'
>;

/**
 * One daily-interest repayment period: its (business-day adjusted) due date and the
 * number of days of interest it carries (the first period includes settlement day).
 */
export interface DailyPeriod {
  readonly period: number;
  readonly dueDate: string;
  readonly days: number;
}

/** Actual adjusted dates with a fixed monthly anchor; settlement counts only in period one. */
export function buildDailyPeriods(input: DailyDates): readonly DailyPeriod[] {
  if (
    !Number.isSafeInteger(input.termMonths) ||
    input.termMonths < 1 ||
    input.termMonths > 600
  )
    throw new RangeError('Term must be an integer from 1 to 600 months');
  const settlement = parseDate(input.settlementDate);
  const firstRequested = parseDate(input.firstRepaymentDate);
  if (daysBetween(settlement, firstRequested) < 0)
    throw new RangeError('First repayment precedes settlement');
  const periods: DailyPeriod[] = [];
  let previousDate = settlement;
  for (let period = 1; period <= input.termMonths; period += 1) {
    const dueDate = nextBusinessDay(
      addMonthsOnAnchor(
        firstRequested,
        period - 1,
        firstRequested.getUTCDate(),
      ),
      input.adjustBusinessDays ?? true,
    );
    const days = daysBetween(previousDate, dueDate) + (period === 1 ? 1 : 0);
    if (days < 1) throw new RangeError('Repayment dates must increase');
    periods.push({ period, dueDate: isoDate(dueDate), days });
    previousDate = dueDate;
  }
  return periods;
}

interface DailyRepaymentPlan {
  readonly periods: readonly DailyPeriod[];
  readonly dailyRate: Decimal;
  readonly payment: Decimal;
}

/**
 * Solve B[n] = A * principal - C * payment = balloon over actual/365 periods.
 * A and C retain Decimal precision. Money and the annual fractional rate are
 * unrounded; monthly/sliding fees are collected separately and do not accrue.
 */
export function createDailyRepaymentPlan(
  input: DailyDates,
  principal: Decimal,
  annualRate: Decimal,
  balloon: Decimal,
): DailyRepaymentPlan {
  if (!principal.isFinite() || principal.isNegative())
    throw new RangeError('Invalid starting principal');
  if (
    !annualRate.isFinite() ||
    annualRate.isNegative() ||
    annualRate.greaterThan(1)
  )
    throw new RangeError('Invalid annual rate');
  if (
    !balloon.isFinite() ||
    balloon.isNegative() ||
    balloon.greaterThan(principal)
  )
    throw new RangeError('Invalid balloon');
  const periods = buildDailyPeriods(input);
  const dailyRate = annualRate.div(365);
  let accumulatedPrincipal = new Decimal(1);
  let accumulatedPayments = new Decimal(0);
  for (const { days } of periods) {
    const factor = new Decimal(1).plus(dailyRate.mul(days));
    accumulatedPrincipal = factor.mul(accumulatedPrincipal);
    accumulatedPayments = factor.mul(accumulatedPayments).plus(1);
  }
  const payment = accumulatedPrincipal
    .mul(principal)
    .minus(balloon)
    .div(accumulatedPayments);
  return { periods, dailyRate, payment };
}
