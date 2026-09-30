import type { FeeSignatureDto } from '@swyft/contracts';
import { quoteCreateSchema } from '@swyft/contracts';
import { describe, expect, it } from 'vitest';
import {
  calculateFromSignature,
  feeSignatureFromDto,
  quoteRequestFromDto,
  scheduleFor,
  summarizeCalculation,
} from '../src/index.js';

const autopay: FeeSignatureDto = {
  id: '00000000-0000-4000-8000-000000000501',
  lenderId: '00000000-0000-4000-8000-000000000005',
  lenderName: 'Autopay',
  name: 'Standard',
  isPreset: true,
  sourceFeeSignatureId: null,
  commissionModel: 'daily_interest',
  interestMethod: 'daily',
  paymentTiming: 'arrears',
  defaultCommissionRate: null,
  maxCommissionRate: null,
  baseCommission: null,
  oversShare: null,
  gstRate: null,
  loadingFactor: null,
  rateMarkupFactor: '0.4',
  monthlyFee: '12.50',
  slidingFee: '12.50',
  maxBrokerOrigination: null,
  fees: {
    establishment: { amount: '350.00', financed: true, maxAmount: '550.00' },
  },
  version: 3,
  createdAt: '2026-09-29T00:00:00.000Z',
  updatedAt: '2026-09-29T00:00:00.000Z',
};

describe('transport mapping', () => {
  it('maps a signature DTO to the domain, keeping the dynamic fee cap', () => {
    const signature = feeSignatureFromDto(autopay);
    expect(signature.version).toBe(3);
    expect(signature.rateMarkupFactor?.toString()).toBe('0.4');
    expect(signature.fees.establishment?.maxAmount?.toFixed(2)).toBe('550.00');
    expect(signature.defaultCommissionRate).toBeUndefined();
    expect('baseCommission' in signature).toBe(false);
    // An absent flag (older API versions omit it) means cent rounding.
    expect('roundPaymentUpToDollar' in signature).toBe(false);
    expect(
      feeSignatureFromDto({ ...autopay, roundPaymentUpToDollar: true })
        .roundPaymentUpToDollar,
    ).toBe(true);
  });

  it('maps a parsed request and drops unset fee-financing overrides', () => {
    const request = quoteRequestFromDto(
      quoteCreateSchema.parse({
        feeSignatureId: autopay.id,
        financeAmount: '84724.86',
        termMonths: 60,
        baseRate: '0.0735',
        commissionRate: '0.04',
        originationFee: '490',
        feeFinancing: { establishment: undefined },
        settlementDate: '2025-08-13',
        firstRepaymentDate: '2025-09-13',
      }),
    );
    expect(request.feeFinancing).toEqual({});
    expect(request.contractRate).toBeUndefined();
    expect(request.originationFee.toFixed(2)).toBe('490.00');
  });

  it('summarises with the saved-quote rounding and yields a dated schedule', () => {
    const calculated = calculateFromSignature(
      feeSignatureFromDto(autopay),
      quoteRequestFromDto(
        quoteCreateSchema.parse({
          feeSignatureId: autopay.id,
          financeAmount: '84724.86',
          termMonths: 60,
          baseRate: '0.0735',
          commissionRate: '0.04',
          originationFee: '490',
          settlementDate: '2025-08-13',
          firstRepaymentDate: '2025-09-13',
        }),
      ),
    );
    const summary = summarizeCalculation(calculated);
    // Dynamic lender fee: $350 + $490 origination, capped at $550.
    expect(summary.lenderFee).toBe('550.00');
    expect(summary.monthlyFee).toBe('12.50');
    expect(summary.monthlyPayment).toMatch(/^\d+\.\d{2}$/);
    expect(summary.commissionRate).toBe('0.04');
    const schedule = scheduleFor(calculated);
    expect(schedule).toHaveLength(60);
    expect(schedule[0]?.paymentDate).toBe('2025-09-15');
  });
});
