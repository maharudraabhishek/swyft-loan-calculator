import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  AnnualRate,
  Fraction,
  Money,
  calculateQuote,
  generateSchedule,
  type QuoteInput,
  type ScheduleRow,
} from '../src/index.js';

/**
 * "Some lenders: round up payment to whole dollar" (brief, Rounding Rules). With
 * `paymentRounding: 'dollar-up'` the cent payment is rounded up to the next dollar, the
 * final instalment is reduced so the loan closes exactly, rates are solved for the
 * charged payment, and total hiring sums the instalments actually charged. The default
 * (`cent`) must stay exactly as before.
 */

const money = (value: string) => Money.from(value);
const rate = (value: string) => AnnualRate.from(value);
const fraction = (value: string) => Fraction.from(value);

const workedExample = {
  model: 'capitalised' as const,
  financeAmount: money('30000'),
  financedFees: money('495'),
  baseRate: rate('0.085'),
  commissionRate: fraction('0.04'),
  termMonths: 60,
  timing: 'arrears' as const,
};

const sum = (rows: readonly ScheduleRow[]) =>
  rows
    .reduce((total, row) => total.plus(row.payment.toString()), new Decimal(0))
    .toFixed(2);

function expectWholeDollarSchedule(
  input: QuoteInput,
  charged: string,
  closing = '0.00',
) {
  const rows = generateSchedule(input);
  const last = rows.at(-1);
  // Every instalment but the last is the rounded-up payment; the last one is smaller.
  expect(
    rows.slice(0, -1).every((row) => row.payment.toFixed() === charged),
  ).toBe(true);
  expect(new Decimal(last!.payment.toString()).lessThan(charged)).toBe(true);
  expect(last!.closingBalance.toFixed()).toBe(closing);
  return rows;
}

describe('whole-dollar repayments', () => {
  it('leaves cent rounding unchanged by default', () => {
    const quote = calculateQuote(workedExample);
    const explicit = calculateQuote({
      ...workedExample,
      paymentRounding: 'cent',
    });
    expect(quote.monthlyPayment.toFixed()).toBe('650.68');
    expect(explicit).toEqual(quote);
  });

  it('rounds the worked example up to $651 and reduces the final instalment', () => {
    const input = { ...workedExample, paymentRounding: 'dollar-up' as const };
    const quote = calculateQuote(input);
    const cent = calculateQuote(workedExample);
    expect(quote.monthlyPayment.toFixed()).toBe('651.00');
    expect(quote.grossMonthlyPayment.toFixed()).toBe('651.00');
    // Commission and amounts financed do not depend on how the payment is rounded.
    expect(quote.commission.toFixed()).toBe('1219.80');
    expect(quote.amountFinanced.toFixed()).toBe('31714.80');
    const rows = expectWholeDollarSchedule(input, '651.00');
    expect(rows).toHaveLength(60);
    // Total hiring is what the customer actually pays: 59 × $651 + the reduced final
    // instalment. Paying 32¢ more each month repays principal sooner, so less interest
    // accrues and the total ($39,036.02) is slightly below the cent loan's $39,040.80.
    expect(rows.at(-1)?.payment.toFixed()).toBe('627.02');
    expect(quote.totalHiring.toFixed()).toBe(sum(rows));
    expect(quote.totalHiring.toFixed()).toBe('39036.02');
    expect(new Decimal('651').mul(59).plus('627.02').toFixed(2)).toBe(
      '39036.02',
    );
    if (quote.model !== 'capitalised') throw new Error('capitalised expected');
    expect(quote.totalInterest.toFixed()).toBe(
      new Decimal(sum(rows)).minus('31714.80').toFixed(2),
    );
    // The comparison rate is solved for the $651 actually charged, so it is higher.
    expect(
      new Decimal(quote.effectiveAnnualRate!.toString()).greaterThan(
        cent.effectiveAnnualRate!.toString(),
      ),
    ).toBe(true);
  });

  it('keeps a payment that is already a whole dollar', () => {
    const quote = calculateQuote({
      ...workedExample,
      financeAmount: money('1200'),
      financedFees: money('0'),
      baseRate: rate('0'),
      commissionRate: fraction('0'),
      termMonths: 12,
      paymentRounding: 'dollar-up',
    });
    expect(quote.monthlyPayment.toFixed()).toBe('100.00');
    expect(quote.totalHiring.toFixed()).toBe('1200.00');
  });

  it('closes on the balloon and pays advance instalment one at settlement', () => {
    const input = {
      ...workedExample,
      timing: 'advance' as const,
      balloon: money('9000'),
      paymentRounding: 'dollar-up' as const,
    };
    const quote = calculateQuote(input);
    const rows = expectWholeDollarSchedule(
      input,
      quote.monthlyPayment.toFixed(),
      // The last advance instalment is a month before maturity: the balloon is still
      // owed then, less the month's interest it has yet to earn.
      new Decimal('9000')
        .div(new Decimal(1).plus(new Decimal('0.085').div(12)))
        .toFixed(2),
    );
    expect(rows[0]?.interest.toFixed()).toBe('0.00');
    expect(quote.totalHiring.toFixed()).toBe(
      new Decimal(sum(rows)).plus('9000').toFixed(2),
    );
  });

  it('Branded: the customer pays whole dollars, the overs commission is unchanged', () => {
    const input = {
      model: 'branded' as const,
      financeAmount: money('18769.50'),
      financedFees: money('1546'),
      baseRate: rate('0.0854'),
      contractRate: rate('0.1004'),
      termMonths: 60,
      monthlyFee: money('8'),
      timing: 'advance' as const,
    };
    const cent = calculateQuote(input);
    const quote = calculateQuote({ ...input, paymentRounding: 'dollar-up' });
    expect(cent.monthlyPayment.toFixed()).toBe('428.46');
    expect(quote.monthlyPayment.toFixed()).toBe('429.00');
    expect(quote.grossMonthlyPayment.toFixed()).toBe('437.00');
    expect(quote.commission.toFixed()).toBe(cent.commission.toFixed());
    const rows = expectWholeDollarSchedule(
      { ...input, paymentRounding: 'dollar-up' },
      '429.00',
    );
    expect(quote.totalHiring.toFixed()).toBe(sum(rows));
  });

  it('Pepper: the customer rate is solved for the charged payment', () => {
    const input = {
      model: 'pepper' as const,
      financeAmount: money('34400'),
      financedFees: money('790'),
      financierRate: rate('0.1234'),
      commissionRate: fraction('0.02'),
      termMonths: 60,
      timing: 'advance' as const,
    };
    const cent = calculateQuote(input);
    const quote = calculateQuote({ ...input, paymentRounding: 'dollar-up' });
    expect(cent.monthlyPayment.toFixed()).toBe('795.37');
    expect(quote.monthlyPayment.toFixed()).toBe('796.00');
    expect(
      new Decimal(quote.effectiveAnnualRate!.toString()).greaterThan(
        cent.effectiveAnnualRate!.toString(),
      ),
    ).toBe(true);
    // At that rate the charged payment amortises NAF exactly (the last row absorbs cents).
    const rows = generateSchedule({ ...input, paymentRounding: 'dollar-up' });
    expect(rows).toHaveLength(60);
    expect(rows.at(-1)?.closingBalance.toFixed()).toBe('0.00');
    expect(
      new Decimal(rows.at(-1)!.payment.toString())
        .minus('796')
        .abs()
        .lessThan('0.50'),
    ).toBe(true);
    expect(quote.totalHiring.toFixed()).toBe(sum(rows));
  });

  it('Autopay: daily interest with a rounded-up instalment and a reduced final one', () => {
    const input = {
      model: 'autopay' as const,
      mode: 'contract-terms' as const,
      startingPrincipal: money('85704.86'),
      annualRate: rate('0.0895'),
      termMonths: 60,
      settlementDate: '2025-05-31',
      firstRepaymentDate: '2025-06-06',
      adjustBusinessDays: true,
    };
    expect(calculateQuote(input).monthlyPayment.toFixed()).toBe('1767.42');
    const quote = calculateQuote({ ...input, paymentRounding: 'dollar-up' });
    expect(quote.monthlyPayment.toFixed()).toBe('1768.00');
    const rows = expectWholeDollarSchedule(
      { ...input, paymentRounding: 'dollar-up' },
      '1768.00',
    );
    expect(quote.totalHiring.toFixed()).toBe(sum(rows));
    // Interest is still balance × 8.95% / 365 × actual days (7 days in period one).
    expect(rows[0]?.interest.toFixed()).toBe('147.11');
  });

  it('rejects an unknown rounding rule', () => {
    expect(() =>
      calculateQuote({
        ...workedExample,
        paymentRounding: 'dollar-down' as unknown as 'cent',
      }),
    ).toThrow(RangeError);
  });
});
