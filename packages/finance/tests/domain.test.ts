import { describe, expect, it } from 'vitest';
import {
  AnnualRate,
  Fraction,
  Money,
  calculateQuote,
  generateSchedule,
} from '../src/index.js';

const money = (value: string): Money => Money.from(value);
const rate = (value: string): AnnualRate => AnnualRate.from(value);
const fraction = (value: string): Fraction => Fraction.from(value);

describe('finance domain', () => {
  it('keeps annual rates and dimensionless percentages distinct', () => {
    expect(rate('0.085').toString()).toBe('0.085');
    expect(fraction('0.04').toString()).toBe('0.04');
    expect(() => fraction('1.01')).toThrow(RangeError);
    expect(() => money('NaN')).toThrow(RangeError);
  });

  it('uses level repayments with payment timing independent from commission model', () => {
    const common = {
      model: 'capitalised' as const,
      financeAmount: money('30000'),
      financedFees: money('495'),
      baseRate: rate('0.085'),
      commissionRate: fraction('0.04'),
      termMonths: 60,
    };
    const advance = calculateQuote({ ...common, timing: 'advance' });
    const arrears = calculateQuote({ ...common, timing: 'arrears' });
    expect(advance.commission.toFixed()).toBe('1219.80');
    expect(advance.brokerReceives.toFixed()).toBe('1341.78');
    expect(advance.amountFinanced.toFixed()).toBe('31714.80');
    expect(advance.monthlyPayment.toFixed()).toBe('646.10');
    expect(
      arrears.monthlyPayment
        .decimal()
        .greaterThan(advance.monthlyPayment.decimal()),
    ).toBe(true);
    const first = generateSchedule({ ...common, timing: 'advance' })[0];
    expect(first?.interest.toFixed()).toBe('0.00');
    expect(first?.principal.toFixed()).toBe(first?.payment.toFixed());
  });

  it('totals capitalised interest from the unrounded monthly payment', () => {
    const quote = calculateQuote({
      model: 'capitalised',
      financeAmount: money('30000'),
      financedFees: money('495'),
      baseRate: rate('0.085'),
      commissionRate: fraction('0.04'),
      termMonths: 60,
      timing: 'advance',
    });
    expect(quote.monthlyPayment.toFixed()).toBe('646.10');
    expect(quote.totalInterest.toFixed()).toBe('7051.27');
  });

  it('calculates Branded overs from rounded instalments and takes the larger commission', () => {
    const common = {
      model: 'branded' as const,
      financeAmount: money('30000'),
      financedFees: money('556'),
      baseRate: rate('0.0669'),
      termMonths: 60,
      monthlyFee: money('8'),
    };
    const base = calculateQuote({ ...common, contractRate: rate('0.0669') });
    const overs = calculateQuote({ ...common, contractRate: rate('0.08') });
    expect(base.commission.toFixed()).toBe('110.00');
    expect(overs.commission.toFixed()).toBe('939.51');
    expect(overs.monthlyPayment.toFixed()).toBe('619.57');
    expect(overs.grossMonthlyPayment.toFixed()).toBe('627.57');
    expect(() =>
      calculateQuote({ ...common, contractRate: rate('0.06') }),
    ).toThrow(RangeError);
  });

  it('takes Branded overs from arrears instalments even for advance repayments', () => {
    // Brief README Branded cases 1-3 (advance): net payment exact; the contracts'
    // commissions ($735.02, $1,380.43, $1,254.20) are arrears-basis overs. Cent-rounded
    // instalments keep the central JSON case exact and land within $0.44 of each contract.
    const cases = [
      ['20315.50', '0.0854', '0.1004', '428.46', '734.58', '735.02'],
      ['81411.09', '0.0925', '0.0995', '1713.53', '1380.06', '1380.43'],
      ['33146', '0.1190', '0.1340', '752.57', '1254.33', '1254.20'],
    ] as const;
    for (const [naf, base, contract, net, commission, contracted] of cases) {
      const input = {
        model: 'branded' as const,
        financeAmount: money(naf),
        financedFees: money('0'),
        baseRate: rate(base),
        contractRate: rate(contract),
        termMonths: 60,
        monthlyFee: money('8'),
      };
      const advance = calculateQuote({ ...input, timing: 'advance' });
      const arrears = calculateQuote({ ...input, timing: 'arrears' });
      expect(advance.monthlyPayment.toFixed()).toBe(net);
      expect(advance.commission.toFixed()).toBe(commission);
      expect(arrears.commission.toFixed()).toBe(commission);
      expect(
        advance.commission.decimal().minus(contracted).abs().toNumber(),
      ).toBeLessThanOrEqual(0.44);
    }
  });

  it('applies Pepper loading without capitalising the whole commission', () => {
    const input = {
      model: 'pepper',
      financeAmount: money('34400'),
      financedFees: money('790'),
      financierRate: rate('0.1229'),
      commissionRate: fraction('0.02'),
      termMonths: 60,
    } as const;
    const quote = calculateQuote(input);
    const schedule = generateSchedule(input);
    expect(quote.commission.toFixed()).toBe('703.80');
    expect(quote.amountFinanced.toFixed()).toBe('35846.08');
    expect(quote.monthlyPayment.toFixed()).toBe('794.50');
    expect(schedule[0]?.openingBalance.toFixed()).toBe('35190.00');
    expect(schedule[0]?.interest.toFixed()).toBe('0.00');
    expect(schedule.at(-1)?.closingBalance.toFixed()).toBe('0.00');
  });

  it('supports zero interest, balloon and a closing residual', () => {
    const input = {
      model: 'capitalised' as const,
      financeAmount: money('1200'),
      financedFees: money('0'),
      baseRate: rate('0'),
      commissionRate: fraction('0'),
      termMonths: 12,
      balloon: money('200'),
      timing: 'arrears' as const,
    };
    const quote = calculateQuote(input);
    const schedule = generateSchedule(input);
    expect(quote.monthlyPayment.toFixed()).toBe('83.33');
    expect(schedule).toHaveLength(12);
    expect(schedule.at(-1)?.closingBalance.toFixed()).toBe('200.00');
  });

  it('uses actual calendar days and shifts a weekend due date while retaining its due-day anchor', () => {
    const input = {
      model: 'autopay' as const,
      mode: 'contract-terms' as const,
      startingPrincipal: money('85704.86'),
      annualRate: rate('0.0895'),
      termMonths: 3,
      settlementDate: '2025-05-31',
      firstRepaymentDate: '2025-06-06',
      adjustBusinessDays: true,
    };
    const rows = generateSchedule(input);
    expect(rows[0]?.days).toBe(7);
    expect(rows[0]?.interest.toFixed()).toBe('147.11');
    expect(rows[1]?.dueDate).toBe('2025-07-07');
    expect(rows[1]?.days).toBe(31);
    expect(rows[2]?.dueDate).toBe('2025-08-06');
    expect(() =>
      calculateQuote({ ...input, firstRepaymentDate: '2025-05-30' }),
    ).toThrow(RangeError);
    expect(() => calculateQuote({ ...input, timing: 'advance' })).toThrow(
      RangeError,
    );
    expect(() =>
      calculateQuote({
        ...input,
        termMonths: 120,
        firstRepaymentDate: '2030-12-01',
      }),
    ).toThrow(RangeError);
  });

  it('derives Autopay origination terms and retains sub-cent domain precision', () => {
    const input = {
      model: 'autopay' as const,
      mode: 'origination' as const,
      financeAmount: money('10000'),
      financedFees: money('500'),
      baseRate: rate('0.08'),
      commissionRate: fraction('0.05'),
      termMonths: 12,
      settlementDate: '2026-09-01',
      firstRepaymentDate: '2026-10-01',
    };
    const quote = calculateQuote(input);
    expect(quote.commission.toFixed()).toBe('525.00');
    expect(quote.amountFinanced.toFixed()).toBe('11025.00');
    expect(quote.effectiveAnnualRate?.toString()).toBe('0.1');
    expect(quote.firstPaymentInterest.toFixed()).toBe('93.64');
    expect(generateSchedule(input)[0]?.interest.toFixed()).toBe('93.64');
    expect(
      money('999999999999.123456789012')
        .decimal()
        .plus('0.000000000001')
        .toString(),
    ).toBe('999999999999.123456789013');
  });
});
