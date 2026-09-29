import { AnnualRate, Fraction, Money } from '@swyft/finance';
import { describe, expect, it } from 'vitest';
import {
  QuoteCompositionError,
  calculateFromSignature,
  solveTargetCommission,
  type FeeSignature,
  type QuoteRequest,
} from '../src/index.js';

const money = (value: string) => Money.from(value);

const capitalised: FeeSignature = {
  id: '00000000-0000-4000-8000-000000000301',
  version: 1,
  lenderName: 'Westpac',
  name: 'Dealer',
  commissionModel: 'capitalised',
  interestMethod: 'monthly',
  paymentTiming: 'arrears',
  defaultCommissionRate: Fraction.from('0.04'),
  maxCommissionRate: Fraction.from('0.06'),
  monthlyFee: money('0'),
  slidingFee: money('0'),
  fees: { establishment: { amount: money('495'), financed: true } },
};

const overs: FeeSignature = {
  ...capitalised,
  id: '00000000-0000-4000-8000-000000000401',
  lenderName: 'Branded',
  commissionModel: 'overs',
  paymentTiming: 'advance',
  baseCommission: money('110'),
  oversShare: Fraction.from('0.75'),
  gstRate: Fraction.from('0.10'),
  monthlyFee: money('8'),
  fees: {},
};
delete (overs as { defaultCommissionRate?: unknown }).defaultCommissionRate;
delete (overs as { maxCommissionRate?: unknown }).maxCommissionRate;

const daily: FeeSignature = {
  ...capitalised,
  id: '00000000-0000-4000-8000-000000000501',
  lenderName: 'Autopay',
  commissionModel: 'daily_interest',
  interestMethod: 'daily',
  paymentTiming: 'arrears',
  rateMarkupFactor: Fraction.from('0.4'),
  monthlyFee: money('12.50'),
  slidingFee: money('12.50'),
  fees: {},
};
delete (daily as { maxCommissionRate?: unknown }).maxCommissionRate;

function request(overrides: Partial<QuoteRequest> = {}): QuoteRequest {
  return {
    financeAmount: money('30000'),
    termMonths: 60,
    baseRate: AnnualRate.from('0.085'),
    balloon: money('0'),
    originationFee: money('0'),
    originationFinanced: true,
    feeFinancing: {},
    ...overrides,
  };
}

describe('target commission calculator', () => {
  it('reverses the brief worked example: $1,219.80 needs 4.00% commission', () => {
    const solution = solveTargetCommission(
      capitalised,
      request(),
      money('1219.80'),
    );
    expect(solution.kind).toBe('commission-rate');
    if (solution.kind !== 'commission-rate') return;
    expect(solution.commissionRate.toString()).toBe('0.04');
    expect(solution.commission.toFixed(2)).toBe('1219.80');
  });

  it('rounds the commission % up so the target is always reached', () => {
    const solution = solveTargetCommission(
      capitalised,
      request(),
      money('1000'),
    );
    if (solution.kind !== 'commission-rate') throw new Error('kind');
    // 1000 / 30495 = 3.2792...% -> 3.28%
    expect(solution.commissionRate.toString()).toBe('0.0328');
    expect(Number(solution.commission.toFixed(2))).toBeGreaterThanOrEqual(1000);
  });

  it("refuses a target above the lender's maximum commission", () => {
    expect(() =>
      solveTargetCommission(capitalised, request(), money('3000')),
    ).toThrow(QuoteCompositionError);
  });

  it('finds the lowest 0.01% contract rate whose overs reach the target', () => {
    // Brief Branded case 1: NAF $20,315.50, base 8.54%, contract 10.04% earns $734.58.
    const branded = request({
      financeAmount: money('20315.50'),
      baseRate: AnnualRate.from('0.0854'),
    });
    const solution = solveTargetCommission(overs, branded, money('734.58'));
    if (solution.kind !== 'contract-rate') throw new Error('kind');
    expect(solution.contractRate.toString()).toBe('0.1004');
    expect(solution.commission.toFixed(2)).toBe('734.58');
    expect(solution.metByBaseCommission).toBe(false);
    const oneStepLower = calculateFromSignature(overs, {
      ...branded,
      contractRate: AnnualRate.from('0.1003'),
    }).result;
    expect(
      'commission' in oneStepLower &&
        oneStepLower.commission.decimal().lessThan('734.58'),
    ).toBe(true);
  });

  it('needs no dial-up when the base commission already meets the target', () => {
    const solution = solveTargetCommission(overs, request(), money('100'));
    if (solution.kind !== 'contract-rate') throw new Error('kind');
    expect(solution.metByBaseCommission).toBe(true);
    expect(solution.contractRate.toString()).toBe('0.085');
    expect(solution.commission.toFixed(2)).toBe('110.00');
  });

  it('reports the daily-interest contract rate: 4% adds 1.6% to 7.35%', () => {
    const solution = solveTargetCommission(
      daily,
      request({
        financeAmount: money('85704.86'),
        baseRate: AnnualRate.from('0.0735'),
        settlementDate: '2025-05-31',
        firstRepaymentDate: '2025-06-06',
      }),
      money('3428.19'),
    );
    if (solution.kind !== 'commission-rate') throw new Error('kind');
    expect(solution.commissionRate.toString()).toBe('0.04');
    expect(solution.commission.toFixed(2)).toBe('3428.19');
    expect(solution.contractRate?.decimal().toFixed(4)).toBe('0.0895');
  });

  it('ignores the current commission choice while solving', () => {
    const solution = solveTargetCommission(
      capitalised,
      request({ commissionRate: Fraction.from('0.06') }),
      money('1219.80'),
    );
    if (solution.kind !== 'commission-rate') throw new Error('kind');
    expect(solution.commissionRate.toString()).toBe('0.04');
  });
});
