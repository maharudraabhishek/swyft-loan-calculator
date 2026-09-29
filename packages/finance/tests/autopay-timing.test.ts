import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  AnnualRate,
  Money,
  calculateQuote,
  generateSchedule,
  type QuoteInput,
} from '../src/index.js';

/**
 * Autopay payment timing. The brief's
 * fee-signature table calls Autopay "Advance", but its own Autopay resources — the
 * central fixture, both lender CSVs and the reference calculator — show every
 * repayment, including the first, paying the interest accrued since the previous date
 * (settlement day counted), with the first repayment a few days after settlement. The
 * "advance" start is expressed by the first repayment date, not by the monthly
 * PMT / (1 + i) adjustment, which would contradict the asserted $1,767.42.
 */
const official = {
  model: 'autopay',
  mode: 'contract-terms',
  termMonths: 60,
  startingPrincipal: Money.from('85704.86'),
  annualRate: AnnualRate.from('0.0895'),
  monthlyFee: Money.from('12.50'),
  slidingFee: Money.from('12.50'),
  adjustBusinessDays: true,
  settlementDate: '2025-05-31',
  firstRepaymentDate: '2025-06-06',
} as const satisfies QuoteInput;

const withDates = (settlementDate: string, firstRepaymentDate: string) =>
  ({ ...official, settlementDate, firstRepaymentDate }) satisfies QuoteInput;

describe('Autopay payment timing semantics', () => {
  it('reproduces the official payment with an interest-bearing first repayment', () => {
    expect(calculateQuote(official).monthlyPayment.toFixed(2)).toBe('1767.42');
    const [first] = generateSchedule(official);
    // Seven days of interest (6 elapsed + settlement day); not a pure-principal payment.
    expect(first?.dueDate).toBe('2025-06-06');
    expect(first?.interest.decimal().greaterThan(0)).toBe(true);
  });

  it('does not apply the monthly advance adjustment, which contradicts the official payment', () => {
    const monthlyRate = new Decimal('0.0895').div(12);
    const advanceStyle = new Decimal('1767.42').div(monthlyRate.plus(1));
    expect(advanceStyle.toFixed(2)).toBe('1754.34');
    expect(() => calculateQuote({ ...official, timing: 'advance' })).toThrow(
      'Autopay daily accrual requires arrears timing',
    );
  });

  it('never produces a pure-principal first payment, even on settlement day', () => {
    const sameDay = withDates('2025-06-02', '2025-06-02');
    const [first] = generateSchedule(sameDay);
    expect(first?.interest.toFixed(2)).toBe('21.02');
  });

  it('lets the first repayment date carry the start: earlier start, lower payment', () => {
    const payment = (settlement: string, first: string) =>
      calculateQuote(withDates(settlement, first)).monthlyPayment.toFixed(2);
    expect(payment('2025-05-31', '2025-06-30')).toBe('1777.74');
    expect(payment('2025-05-31', '2025-06-06')).toBe('1767.42');
    expect(payment('2025-06-02', '2025-06-02')).toBe('1764.81');
  });
});
