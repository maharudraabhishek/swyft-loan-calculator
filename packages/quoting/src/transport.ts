import type {
  FeeSignatureDto,
  QuoteCreateParsed,
  ScheduleRowDto,
} from '@swyft/contracts';
import {
  AnnualRate,
  Fraction,
  Money,
  generateSchedule,
  monthlyDueDate,
} from '@swyft/finance';
import type { CalculatedQuote } from './compose.js';
import {
  lenderFeeKinds,
  type FeeSignature,
  type LenderFee,
  type LenderFeeKind,
  type QuoteRequest,
} from './fee-signature.js';

/**
 * Transport ↔ domain mapping shared by the API (server recalculation) and Electron Main
 * (local preview), so both sides interpret a validated request identically. Inputs must
 * already have passed the shared zod schemas.
 */
export function quoteRequestFromDto(dto: QuoteCreateParsed): QuoteRequest {
  return {
    financeAmount: Money.from(dto.financeAmount),
    termMonths: dto.termMonths,
    baseRate: AnnualRate.from(dto.baseRate),
    balloon: Money.from(dto.balloon),
    originationFee: Money.from(dto.originationFee),
    originationFinanced: dto.originationFinanced,
    feeFinancing: Object.fromEntries(
      Object.entries(dto.feeFinancing).filter(
        ([, value]) => value !== undefined,
      ),
    ),
    ...(dto.commissionRate !== undefined && {
      commissionRate: Fraction.from(dto.commissionRate),
    }),
    ...(dto.contractRate !== undefined && {
      contractRate: AnnualRate.from(dto.contractRate),
    }),
    ...(dto.settlementDate !== undefined && {
      settlementDate: dto.settlementDate,
    }),
    ...(dto.firstRepaymentDate !== undefined && {
      firstRepaymentDate: dto.firstRepaymentDate,
    }),
  };
}

const fraction = (value: string | null) =>
  value === null ? undefined : Fraction.from(value);
const money = (value: string | null) =>
  value === null ? undefined : Money.from(value);

/** Maps a signature received over HTTP/IPC to the quoting domain (preview only). */
export function feeSignatureFromDto(dto: FeeSignatureDto): FeeSignature {
  const fees: Partial<Record<LenderFeeKind, LenderFee>> = {};
  for (const kind of lenderFeeKinds) {
    const fee = dto.fees[kind];
    if (fee === undefined) continue;
    const maxAmount = 'maxAmount' in fee ? fee.maxAmount : undefined;
    fees[kind] = {
      amount: Money.from(fee.amount),
      financed: fee.financed,
      ...(maxAmount !== undefined && { maxAmount: Money.from(maxAmount) }),
    };
  }
  const optional = {
    defaultCommissionRate: fraction(dto.defaultCommissionRate),
    maxCommissionRate: fraction(dto.maxCommissionRate),
    baseCommission: money(dto.baseCommission),
    oversShare: fraction(dto.oversShare),
    gstRate: fraction(dto.gstRate),
    loadingFactor: fraction(dto.loadingFactor),
    rateMarkupFactor: fraction(dto.rateMarkupFactor),
    maxBrokerOrigination: money(dto.maxBrokerOrigination),
  };
  return {
    id: dto.id,
    version: dto.version,
    lenderName: dto.lenderName,
    name: dto.name,
    commissionModel: dto.commissionModel,
    interestMethod: dto.interestMethod,
    paymentTiming: dto.paymentTiming,
    monthlyFee: Money.from(dto.monthlyFee),
    slidingFee: Money.from(dto.slidingFee),
    fees,
    ...Object.fromEntries(
      Object.entries(optional).filter(([, value]) => value !== undefined),
    ),
  };
}

/**
 * The calculated figures a saved quote stores and a preview shows, formatted once here
 * so the preview and the persisted quote use identical rounding: money to cents
 * (half-up), comparison rate to ten decimal places, rates otherwise unrounded.
 */
export interface CalculationSummary {
  readonly contractRate: string | null;
  readonly commissionRate: string | null;
  readonly comparisonRate: string | null;
  readonly lenderFee: string;
  readonly originationFee: string;
  readonly monthlyFee: string;
  readonly upfrontFees: string;
  readonly netAmountFinanced: string;
  readonly amountFinanced: string;
  readonly monthlyPayment: string;
  readonly grossMonthlyPayment: string;
  readonly commission: string | null;
  readonly totalHiring: string;
}

export function summarizeCalculation(
  calculated: CalculatedQuote,
): CalculationSummary {
  const { result, fees } = calculated;
  return {
    contractRate: calculated.contractRate?.toString() ?? null,
    commissionRate: calculated.commissionRate?.toString() ?? null,
    comparisonRate:
      result.effectiveAnnualRate?.decimal().toDecimalPlaces(10).toString() ??
      null,
    lenderFee: fees.lenderFee.toFixed(2),
    originationFee: fees.originationFee.toFixed(2),
    monthlyFee: fees.monthlyFee.toFixed(2),
    upfrontFees: fees.upfrontFees.toFixed(2),
    netAmountFinanced: result.netAmountFinanced.toFixed(2),
    amountFinanced: result.amountFinanced.toFixed(2),
    monthlyPayment: result.monthlyPayment.toFixed(2),
    grossMonthlyPayment: result.grossMonthlyPayment.toFixed(2),
    commission: 'commission' in result ? result.commission.toFixed(2) : null,
    totalHiring: result.totalHiring.toFixed(2),
  };
}

/**
 * Amortisation rows for display, in cents. Daily-interest rows carry their own adjusted
 * dates; monthly-model rows are dated from `settlementDate` when one is given.
 */
export function scheduleFor(
  calculated: CalculatedQuote,
  settlementDate?: string,
): ScheduleRowDto[] {
  const timing = calculated.input.timing ?? 'arrears';
  return generateSchedule(calculated.input).map((row) => ({
    paymentNumber: row.period,
    ...(row.dueDate !== undefined
      ? { paymentDate: row.dueDate }
      : settlementDate !== undefined
        ? { paymentDate: monthlyDueDate(settlementDate, row.period, timing) }
        : {}),
    openingBalanceDollars: row.openingBalance.toFixed(2),
    interestDollars: row.interest.toFixed(2),
    principalDollars: row.principal.toFixed(2),
    feesDollars: row.fee.toFixed(2),
    paymentDollars: row.payment.toFixed(2),
    closingBalanceDollars: row.closingBalance.toFixed(2),
  }));
}
