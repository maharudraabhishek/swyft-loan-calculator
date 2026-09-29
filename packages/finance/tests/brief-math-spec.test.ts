import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/decimal.js';
import { monthlyPayment, solveAnnualRate } from '../src/math.js';
import {
  AnnualRate,
  Fraction,
  Money,
  calculateQuote,
  generateSchedule,
  monthlyDueDate,
} from '../src/index.js';

/**
 * The quoting-tool brief's "Mathematical Specifications", line by line. Each formula is
 * written out here from the brief's text (independently of the engine) and compared with
 * what the engine calculates, so a change to either shows up as a failing line.
 */

const money = (value: string): Money => Money.from(value);
const rate = (value: string): AnnualRate => AnnualRate.from(value);
const fraction = (value: string): Fraction => Fraction.from(value);
const d = (value: string | number): Decimal => new Decimal(value);
const ONE = d(1);

/** Brief: R = F × [i(1+i)^n] / [(1+i)^n − 1], with the balloon term when BV > 0. */
function briefArrears(F: Decimal, r: Decimal, n: number, BV = d(0)): Decimal {
  const i = r.div(12);
  const growth = ONE.plus(i).pow(n);
  return F.minus(BV.div(growth)).mul(i.mul(growth)).div(growth.minus(1));
}

/** Brief: R = R_arrears / (1 + i). */
function briefAdvance(F: Decimal, r: Decimal, n: number, BV = d(0)): Decimal {
  return briefArrears(F, r, n, BV).div(ONE.plus(r.div(12)));
}

const cents = (value: Decimal): string =>
  value.toFixed(2, Decimal.ROUND_HALF_UP);

describe('brief: interest rates', () => {
  it('monthly rate i = r / 12 and daily rate d = r / 365 (8.5% example)', () => {
    const r = d('0.085');
    expect(r.div(12).toFixed(6)).toBe('0.007083');
    expect(r.div(365).toFixed(6)).toBe('0.000233');
  });
});

describe('brief: payment formulas', () => {
  const F = d('31714.80');
  const r = d('0.085');
  const BV = d('5000');
  const agree = (engine: Decimal, brief: Decimal) =>
    expect(engine.minus(brief).abs().lessThan('1e-25')).toBe(true);

  it('arrears, no balloon', () => {
    agree(monthlyPayment(F, r, 60, d(0), 'arrears'), briefArrears(F, r, 60));
  });

  it('arrears, with balloon', () => {
    agree(monthlyPayment(F, r, 60, BV, 'arrears'), briefArrears(F, r, 60, BV));
  });

  it('advance = arrears / (1 + i), with and without balloon', () => {
    agree(monthlyPayment(F, r, 60, d(0), 'advance'), briefAdvance(F, r, 60));
    agree(monthlyPayment(F, r, 60, BV, 'advance'), briefAdvance(F, r, 60, BV));
  });

  it('arrears: first payment one period after settlement; advance: at settlement', () => {
    expect(monthlyDueDate('2025-01-15', 1, 'arrears')).toBe('2025-02-15');
    expect(monthlyDueDate('2025-01-15', 1, 'advance')).toBe('2025-01-15');
  });
});

describe('brief: fee structures and total hiring', () => {
  it('F = P + L + O + B with only financed fees; total monthly = R + monthly fee', () => {
    // P $30,000; L $495 financed; O $790 upfront; B = 4% of NAF; $8 monthly fee.
    const quote = calculateQuote({
      model: 'capitalised',
      financeAmount: money('30000'),
      financedFees: money('495'),
      upfrontFees: money('790'),
      monthlyFee: money('8'),
      baseRate: rate('0.085'),
      commissionRate: fraction('0.04'),
      termMonths: 60,
      timing: 'arrears',
    });
    const naf = d('30495');
    const B = naf.mul('0.04');
    expect(quote.amountFinanced.toFixed()).toBe(cents(naf.plus(B)));
    const R = d(quote.monthlyPayment.toFixed());
    expect(quote.grossMonthlyPayment.toFixed()).toBe(cents(R.plus(8)));
    // Total hiring = PMT × term + balloon + fees payable at settlement.
    expect(quote.totalHiring.toFixed()).toBe(cents(R.mul(60).plus(790)));
  });
});

describe('brief: worked example (capitalised brokerage)', () => {
  const quote = calculateQuote({
    model: 'capitalised',
    financeAmount: money('30000'),
    financedFees: money('495'),
    monthlyFee: money('0'),
    baseRate: rate('0.085'),
    commissionRate: fraction('0.04'),
    termMonths: 60,
    timing: 'arrears',
  });

  it('steps 1–3: NAF, commission, total financed', () => {
    expect(quote.netAmountFinanced.toFixed()).toBe('30495.00');
    expect(quote.commission.toFixed()).toBe('1219.80');
    expect(quote.amountFinanced.toFixed()).toBe('31714.80');
  });

  it('steps 4–5: i, (1+i)^60, the payment factor and R', () => {
    const i = d('0.085').div(12);
    expect(i.toFixed(8)).toBe('0.00708333');
    // The brief prints (1+i)^60 = 1.52699, which is (1.00708)^60 — i cut to 0.00708.
    // Exactly it is 1.52730. Only full precision reaches the brief's own final $650.68:
    // its printed intermediates would give $650.93 (and 0.02052 × F gives $650.79).
    const growth = ONE.plus(i).pow(60);
    expect(growth.toFixed(5)).toBe('1.52730');
    expect(ONE.plus('0.00708').pow(60).toFixed(5)).toBe('1.52700');
    expect(i.mul(growth).div(growth.minus(1)).toFixed(5)).toBe('0.02052');
    expect(quote.monthlyPayment.toFixed()).toBe('650.68');
    const printed = d('0.00708333').mul('1.52699').div('0.52699');
    expect(cents(d('31714.80').mul(printed))).toBe('650.93');
  });

  it('step 6: total repayments $650.68 × 60 = $39,040.80', () => {
    expect(quote.totalHiring.toFixed()).toBe('39040.80');
  });

  it('step 7: comparison rate 10.18% — the rate on NAF alone giving the same payment', () => {
    const comparison = d(quote.effectiveAnnualRate!.toString());
    expect(comparison.mul(100).toFixed(2)).toBe('10.18');
    expect(comparison.greaterThan('0.085')).toBe(true); // always above the base rate
    const onNaf = monthlyPayment(d('30495'), comparison, 60, d(0), 'arrears');
    expect(cents(onNaf)).toBe('650.68');
    expect(
      solveAnnualRate(d('650.68'), d('30495'), 60, d(0), 'arrears')
        .mul(100)
        .toFixed(2),
    ).toBe('10.18');
  });

  it('summary: $650.68, $39,040.80, 8.50%, 10.18%, $1,219.80', () => {
    expect([
      quote.monthlyPayment.toFixed(),
      quote.totalHiring.toFixed(),
      d('0.085').mul(100).toFixed(2),
      d(quote.effectiveAnnualRate!.toString()).mul(100).toFixed(2),
      quote.commission.toFixed(),
    ]).toEqual(['650.68', '39040.80', '8.50', '10.18', '1219.80']);
  });
});

describe('brief: commission overs', () => {
  const input = {
    model: 'branded' as const,
    financeAmount: money('18769.50'),
    financedFees: money('556'),
    baseRate: rate('0.0854'),
    contractRate: rate('0.1004'),
    termMonths: 60,
    timing: 'advance' as const,
  };

  it('Commission = MAX(Base Commission, 75% × Hiring Difference × 1.10)', () => {
    const naf = d('19325.50');
    const basePmt = d(cents(briefArrears(naf, d('0.0854'), 60)));
    const finalPmt = d(cents(briefArrears(naf, d('0.1004'), 60)));
    const difference = finalPmt.mul(60).minus(basePmt.mul(60));
    const expected = Decimal.max(110, difference.mul('0.75').mul('1.10'));
    const quote = calculateQuote(input);
    expect(quote.hiringDifference.toFixed()).toBe(cents(difference));
    expect(quote.commission.toFixed()).toBe(cents(expected));
  });

  it('pays the base commission when the overs are smaller', () => {
    const quote = calculateQuote({ ...input, contractRate: rate('0.0855') });
    expect(quote.commission.toFixed()).toBe('110.00');
  });
});

describe('brief: daily interest with rate adjustment (Autopay)', () => {
  it('contract rate = base + commission% × 0.4: 7.35% + 4% × 0.4 = 8.95%', () => {
    const quote = calculateQuote({
      model: 'autopay',
      mode: 'origination',
      financeAmount: money('30000'),
      financedFees: money('350'),
      baseRate: rate('0.0735'),
      commissionRate: fraction('0.04'),
      termMonths: 60,
      settlementDate: '2025-05-31',
      firstRepaymentDate: '2025-06-30',
    });
    expect(d(quote.effectiveAnnualRate!.toString()).mul(100).toFixed(2)).toBe(
      '8.95',
    );
    // Commission is capitalised into the starting principal.
    expect(quote.commission.toFixed()).toBe('1214.00');
    expect(quote.amountFinanced.toFixed()).toBe('31564.00');
  });

  it('interest = balance × r/365 × actual days; first period counts settlement day (+1)', () => {
    const annual = d('0.0895');
    const rows = generateSchedule({
      model: 'autopay',
      mode: 'contract-terms',
      startingPrincipal: money('85704.86'),
      annualRate: rate('0.0895'),
      termMonths: 12,
      settlementDate: '2025-05-31',
      firstRepaymentDate: '2025-06-06',
      adjustBusinessDays: true,
    });
    // 31 May → 6 Jun is 6 calendar days; the settlement day makes it 7.
    expect(rows[0]?.days).toBe(7);
    for (const row of rows.slice(0, -1)) {
      const expected = d(row.openingBalance.toString())
        .mul(annual)
        .div(365)
        .mul(row.days!);
      expect(
        d(row.interest.toString())
          .minus(expected)
          .abs()
          .lessThanOrEqualTo('0.005'),
      ).toBe(true);
    }
  });
});

describe('brief: loaded commission (factor rate)', () => {
  it('Loading = NAF/(NAF+C) × (1 − 0.4 × r); AF = NAF + Loading × C; customer rate on NAF', () => {
    const quote = calculateQuote({
      model: 'pepper',
      financeAmount: money('30000'),
      financedFees: money('505'),
      financierRate: rate('0.0899'),
      commissionRate: fraction('0.03'),
      termMonths: 60,
      timing: 'advance',
    });
    const naf = d('30505');
    const C = naf.mul('0.03');
    const loading = naf.div(naf.plus(C)).mul(ONE.minus(d('0.4').mul('0.0899')));
    expect(
      d(quote.loading.toString()).minus(loading).abs().lessThan('1e-30'),
    ).toBe(true);
    expect(
      d(quote.amountFinanced.toString())
        .minus(naf.plus(loading.mul(C)))
        .abs()
        .lessThan('1e-30'),
    ).toBe(true);
    const customer = d(quote.effectiveAnnualRate!.toString());
    expect(cents(monthlyPayment(naf, customer, 60, d(0), 'advance'))).toBe(
      quote.monthlyPayment.toFixed(),
    );
  });
});
