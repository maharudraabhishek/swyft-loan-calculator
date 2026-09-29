import { AnnualRate, Fraction, Money } from '@swyft/finance';
import { describe, expect, it } from 'vitest';
import {
  QuoteCompositionError,
  calculateFromSignature,
  composeQuote,
  feeSignatureProblems,
  toJsonSnapshot,
  type FeeSignature,
  type QuoteRequest,
} from '../src/index.js';

const money = (value: string) => Money.from(value);

function signature(overrides: Partial<FeeSignature> = {}): FeeSignature {
  return {
    id: '00000000-0000-4000-8000-000000000999',
    version: 1,
    lenderName: 'Traditional',
    name: 'Dealer',
    commissionModel: 'capitalised',
    interestMethod: 'monthly',
    paymentTiming: 'arrears',
    monthlyFee: money('0'),
    slidingFee: money('0'),
    fees: { establishment: { amount: money('495'), financed: true } },
    ...overrides,
  };
}

/** An override of `undefined` removes that optional field. */
function request(
  overrides: { [K in keyof QuoteRequest]?: QuoteRequest[K] | undefined } = {},
): QuoteRequest {
  const merged: Record<string, unknown> = {
    financeAmount: money('30000'),
    termMonths: 60,
    baseRate: AnnualRate.from('0.085'),
    commissionRate: Fraction.from('0.04'),
    balloon: money('0'),
    originationFee: money('0'),
    originationFinanced: true,
    feeFinancing: {},
    ...overrides,
  };
  for (const key of Object.keys(merged))
    if (merged[key] === undefined) delete merged[key];
  return merged as unknown as QuoteRequest;
}

describe('composeQuote', () => {
  it('reproduces the brief worked example for capitalised brokerage', () => {
    const { result, fees } = calculateFromSignature(signature(), request());
    expect(fees.financedFees.toFixed(2)).toBe('495.00');
    expect(result.netAmountFinanced.toFixed(2)).toBe('30495.00');
    expect(result.amountFinanced.toFixed(2)).toBe('31714.80');
    expect(result.monthlyPayment.toFixed(2)).toBe('650.68');
    expect(result.totalHiring.toFixed(2)).toBe('39040.80');
    expect(
      result.effectiveAnnualRate?.decimal().toDecimalPlaces(4).toString(),
    ).toBe('0.1018');
  });

  it('maps a commission-overs signature to the Branded central fixture', () => {
    const branded = signature({
      commissionModel: 'overs',
      baseCommission: money('110'),
      oversShare: Fraction.from('0.75'),
      gstRate: Fraction.from('0.10'),
      monthlyFee: money('8'),
      fees: {
        establishment: { amount: money('550'), financed: true },
        ppsrRegistration: { amount: money('6'), financed: true },
      },
    });
    const { result } = calculateFromSignature(
      branded,
      request({
        baseRate: AnnualRate.from('0.0669'),
        contractRate: AnnualRate.from('0.08'),
        commissionRate: undefined,
      }),
    );
    expect(result.netAmountFinanced.toFixed(2)).toBe('30556.00');
    expect(result.monthlyPayment.toFixed(2)).toBe('619.57');
    expect(result.grossMonthlyPayment.toFixed(2)).toBe('627.57');
    expect(result.model === 'branded' && result.commission.toFixed(2)).toBe(
      '939.51',
    );
  });

  it('grows a dynamic lender fee with origination up to its cap', () => {
    const dynamic = signature({
      fees: {
        establishment: {
          amount: money('350'),
          financed: true,
          maxAmount: money('550'),
        },
      },
    });
    const partial = composeQuote(
      dynamic,
      request({ originationFee: money('150') }),
    );
    expect(partial.fees.lenderFee.toFixed(2)).toBe('500.00');
    const capped = composeQuote(
      dynamic,
      request({ originationFee: money('990') }),
    );
    expect(capped.fees.lenderFee.toFixed(2)).toBe('550.00');
    expect(capped.fees.financedFees.toFixed(2)).toBe('1540.00');
  });

  it('splits financed and upfront fees using per-quote overrides', () => {
    const pepper = signature({
      commissionModel: 'loaded',
      paymentTiming: 'advance',
      loadingFactor: Fraction.from('0.4'),
      fees: {
        establishment: { amount: money('499'), financed: false },
        ppsrRegistration: { amount: money('6'), financed: false },
        ppsrSearch: { amount: money('2'), financed: false },
      },
    });
    const composed = composeQuote(
      pepper,
      request({
        financeAmount: money('34400'),
        originationFee: money('790'),
        feeFinancing: { ppsrSearch: true },
      }),
    );
    expect(composed.fees.financedFees.toFixed(2)).toBe('792.00');
    expect(composed.fees.upfrontFees.toFixed(2)).toBe('505.00');
    expect(composed.fees.lenderFee.toFixed(2)).toBe('507.00');
  });

  it('always applies the private-sale fee of a Private signature', () => {
    const westpacPrivate = signature({
      fees: {
        establishment: { amount: money('500'), financed: true },
        privateSale: { amount: money('250'), financed: true },
      },
    });
    const composed = composeQuote(westpacPrivate, request());
    expect(composed.fees.lenderFee.toFixed(2)).toBe('750.00');
    expect(composed.fees.financedFees.toFixed(2)).toBe('750.00');
  });

  it.each([
    [
      'commission above the lender maximum',
      signature({ maxCommissionRate: Fraction.from('0.06') }),
      request({ commissionRate: Fraction.from('0.07') }),
      'commissionRate',
    ],
    [
      'origination above the lender cap',
      signature({ maxBrokerOrigination: money('450') }),
      request({ originationFee: money('451') }),
      'originationFee',
    ],
    [
      'missing commission rate without a default',
      signature(),
      request({ commissionRate: undefined }),
      'commissionRate',
    ],
    [
      'a contract rate on a capitalised lender',
      signature(),
      request({ contractRate: AnnualRate.from('0.09') }),
      'contractRate',
    ],
    [
      'payment dates on a monthly lender',
      signature(),
      request({ settlementDate: '2025-05-31' }),
      'settlementDate',
    ],
  ])('rejects %s', (_label, feeSignature, quoteRequest, field) => {
    expect(() => composeQuote(feeSignature, quoteRequest)).toThrow(
      expect.objectContaining({ field }) as QuoteCompositionError,
    );
  });

  it('requires dates and uses origination mode for daily interest', () => {
    const autopay = signature({
      commissionModel: 'daily_interest',
      interestMethod: 'daily',
      rateMarkupFactor: Fraction.from('0.4'),
      slidingFee: money('12.50'),
      monthlyFee: money('12.50'),
    });
    expect(() => composeQuote(autopay, request())).toThrow(
      QuoteCompositionError,
    );
    const composed = composeQuote(
      autopay,
      request({
        settlementDate: '2025-05-31',
        firstRepaymentDate: '2025-06-06',
      }),
    );
    expect(composed.input).toMatchObject({
      model: 'autopay',
      mode: 'origination',
      timing: 'arrears',
      adjustBusinessDays: true,
    });
  });

  it('uses the signature default commission when none is supplied', () => {
    const composed = composeQuote(
      signature({ defaultCommissionRate: Fraction.from('0.04') }),
      request({ commissionRate: undefined }),
    );
    expect(composed.commissionRate?.toString()).toBe('0.04');
  });
});

describe('feeSignatureProblems', () => {
  it('accepts a complete signature and flags mismatched model parameters', () => {
    expect(feeSignatureProblems(signature())).toEqual([]);
    expect(
      feeSignatureProblems(
        signature({
          commissionModel: 'overs',
          loadingFactor: Fraction.from('0.4'),
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        'baseCommission is required for the overs model',
        'loadingFactor applies only to the loaded model',
      ]),
    );
    expect(
      feeSignatureProblems(
        signature({
          commissionModel: 'daily_interest',
          interestMethod: 'daily',
          rateMarkupFactor: Fraction.from('0.4'),
          paymentTiming: 'advance',
        }),
      ),
    ).toContain('Daily interest accrues in arrears');
  });
});

describe('toJsonSnapshot', () => {
  it('stores decimal values as full-precision strings with sorted keys', () => {
    const { input, result } = calculateFromSignature(signature(), request());
    const snapshot = toJsonSnapshot({ input, result });
    expect(snapshot).toMatchObject({
      input: {
        baseRate: '0.085',
        commissionRate: '0.04',
        financeAmount: '30000',
      },
      result: { commission: '1219.8', monthlyPayment: '650.68' },
    });
    expect(JSON.stringify(snapshot)).not.toContain('"value"');
  });
});
