import {
  Money,
  calculateQuote,
  type AnnualRate,
  type Fraction,
  type QuoteInput,
  type QuoteResult,
} from '@swyft/finance';
import {
  QuoteCompositionError,
  lenderFeeKinds,
  type FeeSignature,
  type QuoteRequest,
} from './fee-signature.js';

/** Recorded with every saved quote so a stored result can be traced to its engine. */
export const FINANCE_ENGINE_VERSION = 'finance-1.0.0';

/** Fees resolved from the signature and the broker's choices, in dollars. */
export interface ResolvedFees {
  /** All lender-charged fees (establishment incl. dynamic part, PPSR, search, private sale). */
  readonly lenderFee: Money;
  readonly originationFee: Money;
  readonly financedFees: Money;
  /** Fees payable at settlement; they enter total hiring. */
  readonly upfrontFees: Money;
  readonly monthlyFee: Money;
}

/**
 * A quote ready for the engine: the engine input plus the fee split and the rates that
 * were actually used (defaults applied), which are stored with a saved quote.
 */
export interface ComposedQuote {
  readonly input: QuoteInput;
  readonly fees: ResolvedFees;
  readonly commissionRate?: Fraction;
  readonly contractRate?: AnnualRate;
}

/** A composed quote together with the engine result. */
export interface CalculatedQuote extends ComposedQuote {
  readonly result: QuoteResult;
}

function sum(values: readonly Money[]): Money {
  return Money.from(
    values.reduce(
      (total, value) => total.plus(value.decimal()),
      Money.zero().decimal(),
    ),
  );
}

function resolveCommissionRate(
  signature: FeeSignature,
  request: QuoteRequest,
): Fraction {
  const rate = request.commissionRate ?? signature.defaultCommissionRate;
  if (rate === undefined)
    throw new QuoteCompositionError(
      'commissionRate',
      'A commission rate is required for this lender.',
    );
  if (
    signature.maxCommissionRate !== undefined &&
    rate.decimal().greaterThan(signature.maxCommissionRate.decimal())
  )
    throw new QuoteCompositionError(
      'commissionRate',
      `Commission cannot exceed ${signature.maxCommissionRate.decimal().mul(100).toString()}% for this lender.`,
    );
  return rate;
}

/**
 * Resolves lender fees. A dynamic establishment fee is `amount + origination`, capped
 * at `maxAmount` (brief: "Dynamic Lender Fee Structure", e.g. Autopay $350–$550).
 */
function resolveFees(
  signature: FeeSignature,
  request: QuoteRequest,
): ResolvedFees {
  if (
    signature.maxBrokerOrigination !== undefined &&
    request.originationFee
      .decimal()
      .greaterThan(signature.maxBrokerOrigination.decimal())
  )
    throw new QuoteCompositionError(
      'originationFee',
      `Origination cannot exceed $${signature.maxBrokerOrigination.toFixed(2)} for this lender.`,
    );

  const financed: Money[] = [];
  const upfront: Money[] = [];
  const lender: Money[] = [];
  for (const kind of lenderFeeKinds) {
    const fee = signature.fees[kind];
    // A private-sale fee belongs to a "Private" signature and always applies to it.
    if (fee === undefined) continue;
    let amount = fee.amount;
    if (fee.maxAmount !== undefined) {
      const grown = fee.amount.decimal().plus(request.originationFee.decimal());
      amount = Money.from(
        grown.greaterThan(fee.maxAmount.decimal())
          ? fee.maxAmount.decimal()
          : grown,
      );
    }
    lender.push(amount);
    const isFinanced = request.feeFinancing[kind] ?? fee.financed;
    (isFinanced ? financed : upfront).push(amount);
  }
  (request.originationFinanced ? financed : upfront).push(
    request.originationFee,
  );
  return {
    lenderFee: sum(lender),
    originationFee: request.originationFee,
    financedFees: sum(financed),
    upfrontFees: sum(upfront),
    monthlyFee: signature.monthlyFee,
  };
}

/**
 * Turns a fee signature and the broker's choices into a finance-engine input.
 * This is the single mapping used by server recalculation and desktop preview.
 */
export function composeQuote(
  signature: FeeSignature,
  request: QuoteRequest,
): ComposedQuote {
  const fees = resolveFees(signature, request);
  const common = {
    termMonths: request.termMonths,
    timing: signature.paymentTiming,
    balloon: request.balloon,
    monthlyFee: fees.monthlyFee,
    upfrontFees: fees.upfrontFees,
    financeAmount: request.financeAmount,
    financedFees: fees.financedFees,
    // Only whole-dollar lenders carry the option, so cent quotes (and their stored
    // calculation snapshots) are exactly as before.
    ...(signature.roundPaymentUpToDollar === true && {
      paymentRounding: 'dollar-up' as const,
    }),
  };
  if (signature.commissionModel !== 'overs' && request.contractRate)
    throw new QuoteCompositionError(
      'contractRate',
      'A contract rate applies only to commission-overs lenders.',
    );
  if (
    signature.commissionModel !== 'daily_interest' &&
    (request.settlementDate !== undefined ||
      request.firstRepaymentDate !== undefined)
  )
    throw new QuoteCompositionError(
      'settlementDate',
      'Payment dates apply only to daily-interest lenders.',
    );

  switch (signature.commissionModel) {
    case 'capitalised': {
      const commissionRate = resolveCommissionRate(signature, request);
      return {
        fees,
        commissionRate,
        input: {
          ...common,
          model: 'capitalised',
          baseRate: request.baseRate,
          commissionRate,
        },
      };
    }
    case 'overs': {
      if (request.commissionRate !== undefined)
        throw new QuoteCompositionError(
          'commissionRate',
          'Overs commission comes from the contract rate, not a commission rate.',
        );
      const contractRate = request.contractRate;
      if (contractRate === undefined)
        throw new QuoteCompositionError(
          'contractRate',
          'A contract rate is required for this lender.',
        );
      if (contractRate.decimal().lessThan(request.baseRate.decimal()))
        throw new QuoteCompositionError(
          'contractRate',
          'The contract rate cannot be below the base rate.',
        );
      return {
        fees,
        contractRate,
        input: {
          ...common,
          model: 'branded',
          baseRate: request.baseRate,
          contractRate,
          ...(signature.baseCommission && {
            baseCommission: signature.baseCommission,
          }),
          ...(signature.oversShare && { oversShare: signature.oversShare }),
          ...(signature.gstRate && { gstRate: signature.gstRate }),
        },
      };
    }
    case 'loaded': {
      const commissionRate = resolveCommissionRate(signature, request);
      return {
        fees,
        commissionRate,
        input: {
          ...common,
          model: 'pepper',
          financierRate: request.baseRate,
          commissionRate,
          ...(signature.loadingFactor && {
            loadingFactor: signature.loadingFactor,
          }),
        },
      };
    }
    case 'daily_interest': {
      const commissionRate = resolveCommissionRate(signature, request);
      if (!request.settlementDate || !request.firstRepaymentDate)
        throw new QuoteCompositionError(
          'settlementDate',
          'Settlement and first repayment dates are required for daily-interest lenders.',
        );
      return {
        fees,
        commissionRate,
        input: {
          ...common,
          model: 'autopay',
          mode: 'origination',
          baseRate: request.baseRate,
          commissionRate,
          settlementDate: request.settlementDate,
          firstRepaymentDate: request.firstRepaymentDate,
          slidingFee: signature.slidingFee,
          adjustBusinessDays: true,
          ...(signature.rateMarkupFactor && {
            rateMarkupFactor: signature.rateMarkupFactor,
          }),
        },
      };
    }
  }
}

/** Composes and calculates with the shared finance engine. */
export function calculateFromSignature(
  signature: FeeSignature,
  request: QuoteRequest,
): CalculatedQuote {
  const composed = composeQuote(signature, request);
  return { ...composed, result: calculateQuote(composed.input) };
}
