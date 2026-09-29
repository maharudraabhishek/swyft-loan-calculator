import { describe, expect, it } from 'vitest';
import {
  defaultDisplayOptions,
  displayOptionsSchema,
  maxExportQuotes,
  quoteExportRequestSchema,
  quotePreviewRequestSchema,
  type FeeSignatureDto,
  type QuoteDto,
} from './index';

const signature: FeeSignatureDto = {
  id: '00000000-0000-4000-8000-000000000201',
  lenderId: '00000000-0000-4000-8000-000000000002',
  lenderName: 'Firstmac',
  name: 'Dealer',
  isPreset: true,
  sourceFeeSignatureId: null,
  commissionModel: 'capitalised',
  interestMethod: 'monthly',
  paymentTiming: 'arrears',
  defaultCommissionRate: null,
  maxCommissionRate: null,
  baseCommission: null,
  oversShare: null,
  gstRate: null,
  loadingFactor: null,
  rateMarkupFactor: null,
  monthlyFee: '8.00',
  slidingFee: '0.00',
  maxBrokerOrigination: null,
  fees: { establishment: { amount: '499.00', financed: true } },
  version: 1,
  createdAt: '2026-09-29T00:00:00.000Z',
  updatedAt: '2026-09-29T00:00:00.000Z',
};

const quote: QuoteDto = {
  id: '10000000-0000-4000-8000-000000000001',
  dealId: '20000000-0000-4000-8000-000000000001',
  quoteLogId: '30000000-0000-4000-8000-000000000001',
  feeSignatureId: signature.id,
  lenderName: 'Firstmac',
  feeSignatureName: 'Dealer',
  feeSignatureVersion: 1,
  commissionModel: 'capitalised',
  interestMethod: 'monthly',
  paymentTiming: 'arrears',
  assetDescription: 'Car',
  financeAmount: '30000.00',
  termMonths: 60,
  balloon: '0.00',
  baseRate: '0.085',
  contractRate: null,
  commissionRate: '0.04',
  comparisonRate: '0.1018',
  lenderFee: '499.00',
  originationFee: '0.00',
  monthlyFee: '8.00',
  upfrontFees: '0.00',
  netAmountFinanced: '30499.00',
  amountFinanced: '31718.96',
  monthlyPayment: '650.77',
  grossMonthlyPayment: '658.77',
  commission: '1219.96',
  totalHiring: '39046.20',
  engineVersion: 'finance-1.0.0',
  notes: '',
  createdAt: '2026-09-29T00:00:00.000Z',
  updatedAt: '2026-09-29T00:00:00.000Z',
};

describe('IPC preview request validation', () => {
  const request = {
    feeSignatureId: signature.id,
    financeAmount: '30000',
    termMonths: 60,
    baseRate: '0.085',
    commissionRate: '0.04',
  };

  it('accepts a signature plus broker choices and applies request defaults', () => {
    const parsed = quotePreviewRequestSchema.parse({ signature, request });
    expect(parsed.request.balloon).toBe('0');
    expect(parsed.request.originationFinanced).toBe(true);
  });

  it.each([
    ['a calculated amount', { ...request, monthlyPayment: '1.00' }],
    ['an owner claim', { ...request, ownerUserId: signature.id }],
    ['a non-decimal amount', { ...request, financeAmount: 30000 }],
    ['a percent instead of a fraction', { ...request, baseRate: '8.5' }],
    ['an impossible date', { ...request, settlementDate: '2026-02-30' }],
  ])('rejects %s', (_label, bad) => {
    expect(
      quotePreviewRequestSchema.safeParse({ signature, request: bad }).success,
    ).toBe(false);
  });
});

describe('export request validation', () => {
  it('accepts saved quotes with display options', () => {
    expect(
      quoteExportRequestSchema.safeParse({
        quotes: [quote],
        display: defaultDisplayOptions,
      }).success,
    ).toBe(true);
  });

  it('rejects extra quote properties, empty and oversized exports', () => {
    const display = defaultDisplayOptions;
    expect(
      quoteExportRequestSchema.safeParse({
        quotes: [{ ...quote, html: '<b>x</b>' }],
        display,
      }).success,
    ).toBe(false);
    expect(
      quoteExportRequestSchema.safeParse({ quotes: [], display }).success,
    ).toBe(false);
    expect(
      quoteExportRequestSchema.safeParse({
        quotes: Array.from({ length: maxExportQuotes + 1 }, () => quote),
        display,
      }).success,
    ).toBe(false);
  });

  it('bounds decimals echoed back by the Renderer', () => {
    const display = defaultDisplayOptions;
    for (const bad of ['1e1000000000', '9'.repeat(40), '-1', 'NaN'])
      expect(
        quoteExportRequestSchema.safeParse({
          quotes: [{ ...quote, totalHiring: bad }],
          display,
        }).success,
      ).toBe(false);
    expect(
      quotePreviewRequestSchema.safeParse({
        signature: { ...signature, monthlyFee: '1e1000000000' },
        request: {
          feeSignatureId: signature.id,
          financeAmount: '30000',
          termMonths: 60,
          baseRate: '0.085',
        },
      }).success,
    ).toBe(false);
  });

  it('requires every display flag to be a boolean', () => {
    expect(
      displayOptionsSchema.safeParse({
        ...defaultDisplayOptions,
        showCommission: 'yes',
      }).success,
    ).toBe(false);
  });
});
