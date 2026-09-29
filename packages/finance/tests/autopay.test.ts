import { describe, expect, it } from 'vitest';
import {
  AnnualRate,
  Money,
  calculateQuote,
  generateSchedule,
} from '../src/index.js';
import { buildDailyPeriods, createDailyRepaymentPlan } from '../src/daily.js';
import { Decimal } from '../src/decimal.js';

const contract = {
  model: 'autopay',
  mode: 'contract-terms',
  startingPrincipal: Money.from('85704.86'),
  annualRate: AnnualRate.from('0.0895'),
  termMonths: 60,
  settlementDate: '2025-05-31',
  firstRepaymentDate: '2025-06-06',
  adjustBusinessDays: true,
} as const;

describe('Autopay actual/365 level repayment', () => {
  it('matches the official $1,767.42 payment using actual adjusted periods', () => {
    const quote = calculateQuote(contract);
    expect(quote.monthlyPayment.toFixed()).toBe('1767.42');
    expect(quote.firstPaymentInterest.toFixed()).toBe('147.11');
    const schedule = generateSchedule(contract);
    expect(schedule).toHaveLength(60);
    expect(schedule[0]?.days).toBe(7);
    expect(schedule[1]?.dueDate).toBe('2025-07-07');
    expect(schedule[1]?.days).toBe(31);
    for (const row of schedule) expect(row.payment.toFixed()).toBe('1767.42');
    expect(schedule.at(-1)?.closingBalance.toFixed()).toBe('0.00');
  });

  it.each(['0', '15000', '85704.86'])(
    'solves the full unrounded recurrence for a $%s maturity balloon',
    (target) => {
      const balloon = Money.from(target);
      const input = { ...contract, balloon };
      const plan = createDailyRepaymentPlan(
        input,
        input.startingPrincipal.decimal(),
        input.annualRate.decimal(),
        balloon.decimal(),
      );
      // Independently roll the debt forward without final-payment adjustments or balance clamps.
      let balance = input.startingPrincipal.decimal();
      for (const { days } of plan.periods) {
        balance = balance
          .plus(balance.mul(input.annualRate.decimal()).mul(days).div(365))
          .minus(plan.payment);
      }
      expect(balance.minus(target).abs().lessThan('1e-25')).toBe(true);
      const quote = calculateQuote(input);
      const rows = generateSchedule(input);
      expect(rows).toHaveLength(input.termMonths);
      expect(rows.at(-1)?.closingBalance.toFixed()).toBe(balloon.toFixed());
      for (const [index, row] of rows.entries()) {
        expect(row.payment.toFixed()).toBe(quote.monthlyPayment.toFixed());
        expect({
          period: row.period,
          dueDate: row.dueDate,
          days: row.days,
        }).toEqual(plan.periods[index]);
      }
      if (target === '85704.86') {
        // A short first period can take the balance below its eventual maturity target.
        expect(rows[0]?.closingBalance.decimal().lessThan(target)).toBe(true);
      }
    },
  );

  it('handles zero interest and a single inclusive settlement-day payment', () => {
    const input = {
      ...contract,
      annualRate: AnnualRate.from('0'),
      termMonths: 1,
      firstRepaymentDate: contract.settlementDate,
      adjustBusinessDays: false,
      balloon: Money.from('10000'),
    };
    const quote = calculateQuote(input);
    const rows = generateSchedule(input);
    expect(quote.monthlyPayment.toFixed()).toBe('75704.86');
    expect(rows[0]?.days).toBe(1);
    expect(rows[0]?.interest.toFixed()).toBe('0.00');
    expect(rows[0]?.closingBalance.toFixed()).toBe('10000.00');
    expect(() =>
      calculateQuote({ ...input, balloon: Money.from('90000') }),
    ).toThrow(/balloon/i);
  });

  it('preserves the month-end anchor across leap February', () => {
    expect(
      buildDailyPeriods({
        ...contract,
        termMonths: 3,
        settlementDate: '2028-01-30',
        firstRepaymentDate: '2028-01-31',
      }),
    ).toEqual([
      { period: 1, dueDate: '2028-01-31', days: 2 },
      { period: 2, dueDate: '2028-02-29', days: 29 },
      { period: 3, dueDate: '2028-03-31', days: 31 },
    ]);
  });

  it('re-solves the payment when business-day adjustment changes the periods', () => {
    const unadjusted = { ...contract, adjustBusinessDays: false };
    const rows = generateSchedule(unadjusted);
    expect(rows[1]?.dueDate).toBe('2025-07-06');
    expect(rows[1]?.days).toBe(30);
    expect(calculateQuote(unadjusted).monthlyPayment.toFixed()).not.toBe(
      calculateQuote(contract).monthlyPayment.toFixed(),
    );
    expect(rows.at(-1)?.closingBalance.toFixed()).toBe('0.00');
  });

  it('retains more precision than cents when solving and carrying balances', () => {
    const plan = createDailyRepaymentPlan(
      contract,
      contract.startingPrincipal.decimal(),
      contract.annualRate.decimal(),
      new Decimal(0),
    );
    expect(
      plan.payment.minus('1767.4175558437819').abs().lessThan('1e-10'),
    ).toBe(true);
    const firstClose = contract.startingPrincipal
      .decimal()
      .mul(new Decimal(1).plus(plan.dailyRate.mul(7)))
      .minus(plan.payment);
    expect(generateSchedule(contract)[0]?.closingBalance.toFixed()).toBe(
      firstClose.toFixed(2),
    );
  });
});
