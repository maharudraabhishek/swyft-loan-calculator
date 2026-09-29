import type { DealDto, FeeSignatureDto, QuoteDto } from '@swyft/contracts';

/** Deterministic DTOs shaped exactly like `/v1` responses, for unit and component tests. */

const timestamp = '2026-09-29T04:00:00.000Z';

export function dealFixture(overrides: Partial<DealDto> = {}): DealDto {
  return {
    id: '20000000-0000-4000-8000-000000000001',
    name: 'Smith — Ranger ute',
    quoteLogId: '30000000-0000-4000-8000-000000000001',
    quoteCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

/** The brief's worked example (capitalised brokerage) as a saved server quote. */
export function quoteFixture(overrides: Partial<QuoteDto> = {}): QuoteDto {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    dealId: '20000000-0000-4000-8000-000000000001',
    quoteLogId: '30000000-0000-4000-8000-000000000001',
    feeSignatureId: '00000000-0000-4000-8000-000000000301',
    lenderName: 'Westpac',
    feeSignatureName: 'Dealer',
    feeSignatureVersion: 1,
    commissionModel: 'capitalised',
    interestMethod: 'monthly',
    paymentTiming: 'arrears',
    assetDescription: 'New Vehicle',
    financeAmount: '30000.00',
    termMonths: 60,
    balloon: '0.00',
    baseRate: '0.085',
    contractRate: null,
    commissionRate: '0.04',
    comparisonRate: '0.1018123456',
    lenderFee: '495.00',
    originationFee: '0.00',
    monthlyFee: '0.00',
    upfrontFees: '0.00',
    netAmountFinanced: '30495.00',
    amountFinanced: '31714.80',
    monthlyPayment: '650.68',
    grossMonthlyPayment: '650.68',
    commission: '1219.80',
    totalHiring: '39040.80',
    engineVersion: 'finance-1.0.0',
    notes: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

const presetBase = {
  isPreset: true,
  sourceFeeSignatureId: null,
  defaultCommissionRate: null,
  maxCommissionRate: null,
  baseCommission: null,
  oversShare: null,
  gstRate: null,
  loadingFactor: null,
  rateMarkupFactor: null,
  slidingFee: '0.00',
  maxBrokerOrigination: null,
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
} as const;

/** Mirrors migration 0002 presets used by the UI tests. */
export const signatureFixtures = {
  westpacDealer: {
    ...presetBase,
    id: '00000000-0000-4000-8000-000000000301',
    lenderId: '00000000-0000-4000-8000-000000000003',
    lenderName: 'Westpac',
    name: 'Dealer',
    commissionModel: 'capitalised',
    interestMethod: 'monthly',
    paymentTiming: 'advance',
    defaultCommissionRate: '0.04',
    maxCommissionRate: '0.06',
    monthlyFee: '0.00',
    fees: { establishment: { amount: '500.00', financed: true } },
  },
  brandedDealer: {
    ...presetBase,
    id: '00000000-0000-4000-8000-000000000401',
    lenderId: '00000000-0000-4000-8000-000000000004',
    lenderName: 'Branded',
    name: 'Dealer',
    commissionModel: 'overs',
    interestMethod: 'monthly',
    paymentTiming: 'advance',
    baseCommission: '110.00',
    oversShare: '0.75',
    gstRate: '0.1',
    monthlyFee: '8.00',
    fees: {
      establishment: { amount: '550.00', financed: true },
      ppsrRegistration: { amount: '6.00', financed: true },
    },
  },
  autopay: {
    ...presetBase,
    id: '00000000-0000-4000-8000-000000000501',
    lenderId: '00000000-0000-4000-8000-000000000005',
    lenderName: 'Autopay',
    name: 'Standard',
    commissionModel: 'daily_interest',
    interestMethod: 'daily',
    paymentTiming: 'arrears',
    rateMarkupFactor: '0.4',
    monthlyFee: '12.50',
    slidingFee: '12.50',
    fees: {
      establishment: { amount: '350.00', financed: true, maxAmount: '550.00' },
    },
  },
} satisfies Record<string, FeeSignatureDto>;
