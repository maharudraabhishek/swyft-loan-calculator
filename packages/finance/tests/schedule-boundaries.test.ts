import { describe, expect, it } from 'vitest';
import {
  AnnualRate,
  Fraction,
  Money,
  calculateQuote,
  generateSchedule,
  type QuoteInput,
} from '../src/index.js';

const daily = {
  model: 'autopay',
  mode: 'contract-terms',
  startingPrincipal: Money.from('10000'),
  annualRate: AnnualRate.from('0.20'),
  termMonths: 84,
  settlementDate: '2025-05-31',
  firstRepaymentDate: '2025-06-06',
  monthlyFee: Money.from('12.50'),
  slidingFee: Money.from('12.50'),
} as const;

describe('schedule cash-flow boundaries', () => {
  it.each(['capitalised', 'branded', 'pepper', 'autopay'] as const)(
    'includes upfront fees and balloon in %s hiring without financing them',
    (model) => {
      const common = {
        financeAmount: Money.from('1200'),
        financedFees: Money.zero(),
        upfrontFees: Money.from('50'),
        termMonths: 12,
        balloon: Money.from('240'),
        baseRate: AnnualRate.from('0'),
        commissionRate: Fraction.from('0'),
      };
      const input: QuoteInput =
        model === 'branded'
          ? { ...common, model, contractRate: AnnualRate.from('0') }
          : model === 'pepper'
            ? { ...common, model, financierRate: AnnualRate.from('0') }
            : model === 'autopay'
              ? {
                  ...common,
                  model,
                  mode: 'origination',
                  settlementDate: '2025-06-01',
                  firstRepaymentDate: '2025-07-01',
                }
              : { ...common, model };
      const quote = calculateQuote(input);
      expect(quote.amountFinanced.toFixed()).toBe('1200.00');
      expect(quote.monthlyPayment.toFixed()).toBe('80.00');
      expect(quote.totalHiring.toFixed()).toBe('1250.00');
      expect(() =>
        calculateQuote({ ...input, upfrontFees: Money.from('-1') }),
      ).toThrow();
    },
  );
  it('excludes the first-only sliding fee from recurring Autopay payments', () => {
    const quote = calculateQuote(daily);
    expect(
      quote.grossMonthlyPayment
        .decimal()
        .minus(quote.monthlyPayment.decimal())
        .toFixed(2),
    ).toBe('12.50');
  });

  it('rejects a requested first date before settlement even when a holiday shifts it forward', () => {
    expect(() =>
      calculateQuote({
        ...daily,
        settlementDate: '2025-06-08',
        firstRepaymentDate: '2025-06-07',
      }),
    ).toThrow(/settlement/i);
    expect(
      calculateQuote({
        ...daily,
        settlementDate: '2025-06-06',
        firstRepaymentDate: '2025-06-07',
      }).firstPaymentDays,
    ).toBe(5);
  });

  it('uses a level daily payment through the contracted term without overcollecting', () => {
    const rows = generateSchedule(daily);
    expect(rows).toHaveLength(daily.termMonths);
    const quote = calculateQuote(daily);
    for (const row of rows) {
      expect(row.payment.toFixed()).toBe(quote.monthlyPayment.toFixed());
      expect(row.payment.decimal().isNegative(), `payment ${row.period}`).toBe(
        false,
      );
      expect(
        row.closingBalance.decimal().isNegative(),
        `balance ${row.period}`,
      ).toBe(false);
      expect(
        row.interest.decimal().isNegative(),
        `interest ${row.period}`,
      ).toBe(false);
    }
    expect(rows.at(-1)?.closingBalance.toFixed()).toBe('0.00');
    expect(
      rows.slice(0, -1).some((row) => row.closingBalance.decimal().isZero()),
    ).toBe(false);
  });

  it('does not let cent-rounded monthly payments overdraw a small balance', () => {
    const rows = generateSchedule({
      model: 'branded',
      financeAmount: Money.from('0.05'),
      financedFees: Money.zero(),
      baseRate: AnnualRate.from('0'),
      contractRate: AnnualRate.from('0'),
      termMonths: 10,
      timing: 'arrears',
    });
    for (const row of rows) {
      expect(row.payment.decimal().isNegative()).toBe(false);
      expect(row.closingBalance.decimal().isNegative()).toBe(false);
    }
    expect(rows.at(-1)?.closingBalance.toFixed()).toBe('0.00');
  });

  it('leaves the discounted balloon after the last advance instalment', () => {
    const rows = generateSchedule({
      model: 'capitalised',
      financeAmount: Money.from('10000'),
      financedFees: Money.zero(),
      baseRate: AnnualRate.from('0.12'),
      commissionRate: Fraction.from('0'),
      balloon: Money.from('3000'),
      termMonths: 12,
      timing: 'advance',
    });
    // The last advance instalment occurs at month 11. The residual is due at month 12.
    expect(rows.at(-1)?.closingBalance.toFixed()).toBe(
      Money.from('3000').decimal().div('1.01').toFixed(2),
    );
  });
});
