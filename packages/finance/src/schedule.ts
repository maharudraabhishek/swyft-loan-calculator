import { Decimal } from './decimal.js';
import { amortizeDaily, amortizeMonthly } from './amortization.js';
import { createDailyRepaymentPlan } from './daily.js';
import { calculateQuote } from './quote.js';
import type { AutopayInput, QuoteInput, ScheduleRow } from './types.js';
import { Money } from './value-objects.js';

const ZERO = new Decimal(0);

/**
 * Monthly lenders. Which balance and rate the schedule runs on depends on the model:
 * - Traditional (capitalised): total financed (NAF + commission) at the base rate.
 * - Branded (overs): NAF at the contract rate; the commission is not added to principal.
 * - Pepper (loaded): NAF at the solved customer rate, because the commission is serviced
 *   by the rate margin rather than added to the balance.
 */
function makeMonthlySchedule(
  input: Exclude<QuoteInput, AutopayInput>,
  quote = calculateQuote(input),
): readonly ScheduleRow[] {
  const annualRate =
    input.model === 'capitalised'
      ? input.baseRate
      : input.model === 'branded'
        ? input.contractRate
        : quote.effectiveAnnualRate;
  if (!annualRate) throw new RangeError('Pepper customer rate is missing');
  const fee = Money.from(input.monthlyFee?.decimal() ?? ZERO).roundCents();
  const rows = amortizeMonthly({
    startingBalance:
      input.model === 'pepper'
        ? quote.netAmountFinanced.decimal()
        : quote.amountFinanced.decimal(),
    monthlyRate: annualRate.decimal().div(12),
    termMonths: input.termMonths,
    payment: quote.monthlyPayment.decimal(),
    balloon: input.balloon?.decimal() ?? ZERO,
    timing: input.timing ?? (input.model === 'branded' ? 'arrears' : 'advance'),
  });
  return rows.map((row) => ({
    period: row.period,
    openingBalance: Money.from(row.opening).roundCents(),
    payment: Money.from(row.payment).roundCents(),
    interest: Money.from(row.interest),
    principal: Money.from(row.principal).roundCents(),
    fee,
    closingBalance: Money.from(row.closing).roundCents(),
  }));
}

/**
 * Daily-interest lenders (Autopay): actual payment dates, actual/365 interest, settlement
 * day counted in the first period, and a sliding fee on the first instalment.
 */
function makeDailySchedule(
  input: AutopayInput,
  quote = calculateQuote(input),
): readonly ScheduleRow[] {
  if (!quote.effectiveAnnualRate)
    throw new RangeError('Autopay contract rate is missing');
  const monthlyFee = input.monthlyFee?.decimal() ?? ZERO;
  const slidingFee = input.slidingFee?.decimal() ?? ZERO;
  const balloon = input.balloon?.decimal() ?? ZERO;
  const { periods, dailyRate, payment } = createDailyRepaymentPlan(
    input,
    quote.amountFinanced.decimal(),
    quote.effectiveAnnualRate.decimal(),
    balloon,
  );
  const dollarUp = input.paymentRounding === 'dollar-up';
  const rows = amortizeDaily({
    periods,
    dailyRate,
    startingBalance: quote.amountFinanced.decimal(),
    // Cent rounding charges the solved payment every period (it lands on the balloon at
    // maturity); a rounded-up payment needs its final instalment reduced instead.
    payment: dollarUp ? quote.monthlyPayment.decimal() : payment,
    balloon,
    settleFinalInstalment: dollarUp,
  });
  return rows.map((row, index) => ({
    period: row.period,
    dueDate: periods[index]?.dueDate ?? '',
    days: periods[index]?.days ?? 0,
    openingBalance: Money.from(row.opening).roundCents(),
    payment: Money.from(row.payment).roundCents(),
    interest: Money.from(row.interest).roundCents(),
    principal: Money.from(row.principal).roundCents(),
    fee: Money.from(
      monthlyFee.plus(row.period === 1 ? slidingFee : ZERO),
    ).roundCents(),
    closingBalance: Money.from(row.closing).roundCents(),
  }));
}

/**
 * The repayment schedule for a quote, generated from the domain inputs (never from
 * figures a client calculated). Payments exclude the monthly and sliding fees, which are
 * shown in their own column.
 */
export function generateSchedule(input: QuoteInput): readonly ScheduleRow[] {
  return input.model === 'autopay'
    ? makeDailySchedule(input)
    : makeMonthlySchedule(input);
}
