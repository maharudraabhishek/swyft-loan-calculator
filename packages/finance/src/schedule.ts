import { Decimal } from './decimal.js';
import { createDailyRepaymentPlan } from './daily.js';
import { calculateQuote } from './quote.js';
import type { AutopayInput, QuoteInput, ScheduleRow } from './types.js';
import { Money } from './value-objects.js';

const ZERO = new Decimal(0);

function makeMonthlySchedule(
  input: Exclude<QuoteInput, AutopayInput>,
  quote = calculateQuote(input),
): readonly ScheduleRow[] {
  // Pepper's loaded principal determines the quote payment, while its customer
  // amortization starts at NAF and accrues at the solved customer rate.
  const annualRate =
    input.model === 'capitalised'
      ? input.baseRate
      : input.model === 'branded'
        ? input.contractRate
        : quote.effectiveAnnualRate;
  if (!annualRate) throw new RangeError('Pepper customer rate is missing');
  const monthlyRate = annualRate.decimal().div(12);
  const timing =
    input.timing ?? (input.model === 'branded' ? 'arrears' : 'advance');
  const payment = quote.monthlyPayment.decimal();
  const fee = input.monthlyFee?.decimal() ?? ZERO;
  const balloon = input.balloon?.decimal() ?? ZERO;
  let balance =
    input.model === 'pepper'
      ? quote.netAmountFinanced.decimal()
      : quote.amountFinanced.decimal();
  const rows: ScheduleRow[] = [];

  for (let period = 1; period <= input.termMonths; period += 1) {
    const opening = balance;
    // Advance instalment one is paid at settlement and therefore accrues no prior interest.
    const interest = Money.from(
      period === 1 && timing === 'advance' ? ZERO : opening.mul(monthlyRate),
    )
      .roundCents()
      .decimal();
    // The balloon is due at month n; the last advance payment is at n - 1.
    // Retain its discounted value at each payment, including the final cent adjustment.
    const residual = balloon.div(
      new Decimal(1)
        .plus(monthlyRate)
        .pow(input.termMonths - period + (timing === 'advance' ? 1 : 0)),
    );
    let principal = payment.minus(interest);
    let actualPayment = payment;
    if (
      period === input.termMonths ||
      principal.greaterThan(opening.minus(residual))
    ) {
      // Never collect more principal than remains, even when cent PMTs pay off early.
      principal = opening.minus(residual);
      actualPayment = principal.plus(interest);
    }
    balance = opening.minus(principal);
    rows.push({
      period,
      openingBalance: Money.from(opening).roundCents(),
      payment: Money.from(actualPayment).roundCents(),
      interest: Money.from(interest),
      principal: Money.from(principal).roundCents(),
      fee: Money.from(fee).roundCents(),
      closingBalance: Money.from(balance).roundCents(),
    });
    if (balance.isZero()) break;
  }
  return rows;
}

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
  let balance = quote.amountFinanced.decimal();
  const rows: ScheduleRow[] = [];

  for (const { period, dueDate, days } of periods) {
    const opening = balance;
    const interest = opening.mul(dailyRate).mul(days);
    // Use the solved unrounded payment for every period, including the final one.
    // A balloon is a maturity target, not an intermediate minimum balance.
    const principal = payment.minus(interest);
    balance = opening.minus(principal);
    rows.push({
      period,
      dueDate,
      days,
      openingBalance: Money.from(opening).roundCents(),
      payment: Money.from(payment).roundCents(),
      interest: Money.from(interest).roundCents(),
      principal: Money.from(principal).roundCents(),
      fee: Money.from(
        monthlyFee.plus(period === 1 ? slidingFee : ZERO),
      ).roundCents(),
      closingBalance: Money.from(balance).roundCents(),
    });
  }
  return rows;
}

/** Produce a deterministic preview schedule from domain inputs; never reuse client-calculated values. */
export function generateSchedule(input: QuoteInput): readonly ScheduleRow[] {
  return input.model === 'autopay'
    ? makeDailySchedule(input)
    : makeMonthlySchedule(input);
}
