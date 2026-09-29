import type {
  AnnualRate,
  Fraction,
  Money,
  PaymentTiming,
} from '@swyft/finance';

/** Commission models named by the brief; each maps to one finance-engine model. */
export type CommissionModel =
  'capitalised' | 'overs' | 'loaded' | 'daily_interest';

export type InterestMethod = 'monthly' | 'daily';

export const lenderFeeKinds = [
  'establishment',
  'ppsrRegistration',
  'ppsrSearch',
  'privateSale',
] as const;

export type LenderFeeKind = (typeof lenderFeeKinds)[number];

/** A lender-charged fee with its default financing. */
export interface LenderFee {
  readonly amount: Money;
  readonly financed: boolean;
  /**
   * Establishment only: the lender fee rises dollar-for-dollar with the broker's
   * origination fee from `amount` up to this cap (Autopay, Metro).
   */
  readonly maxAmount?: Money;
}

/**
 * A lender product preset ("fee signature"): fee structure and calculation method.
 * Rates and fractions are annual/decimal fractions (0.04 = 4%).
 */
export interface FeeSignature {
  readonly id: string;
  readonly version: number;
  readonly lenderName: string;
  readonly name: string;
  readonly commissionModel: CommissionModel;
  readonly interestMethod: InterestMethod;
  readonly paymentTiming: PaymentTiming;
  readonly defaultCommissionRate?: Fraction;
  readonly maxCommissionRate?: Fraction;
  readonly baseCommission?: Money;
  readonly oversShare?: Fraction;
  readonly gstRate?: Fraction;
  readonly loadingFactor?: Fraction;
  readonly rateMarkupFactor?: Fraction;
  readonly monthlyFee: Money;
  readonly slidingFee: Money;
  readonly maxBrokerOrigination?: Money;
  readonly fees: Readonly<Partial<Record<LenderFeeKind, LenderFee>>>;
}

/** The broker's choices for one quote. The server never accepts calculated amounts. */
export interface QuoteRequest {
  readonly financeAmount: Money;
  readonly termMonths: number;
  readonly baseRate: AnnualRate;
  /** Required for overs; must not be below the base rate. */
  readonly contractRate?: AnnualRate;
  /** Capitalised, loaded and daily models; falls back to the signature default. */
  readonly commissionRate?: Fraction;
  readonly balloon: Money;
  readonly originationFee: Money;
  readonly originationFinanced: boolean;
  readonly feeFinancing: Readonly<Partial<Record<LenderFeeKind, boolean>>>;
  /** Daily-interest lenders only (ISO dates). */
  readonly settlementDate?: string;
  readonly firstRepaymentDate?: string;
}

/** An input that is valid in form but not for this fee signature. */
export class QuoteCompositionError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'QuoteCompositionError';
  }
}

/**
 * Checks that a signature carries exactly the parameters its commission model needs.
 * The database enforces the same rule with CHECK constraints.
 */
export function feeSignatureProblems(
  signature: Omit<FeeSignature, 'id' | 'version' | 'lenderName'>,
): readonly string[] {
  const problems: string[] = [];
  const requires = (
    model: CommissionModel,
    present: boolean,
    field: string,
  ): void => {
    if ((signature.commissionModel === model) !== present)
      problems.push(
        present
          ? `${field} applies only to the ${model} model`
          : `${field} is required for the ${model} model`,
      );
  };
  requires('overs', signature.baseCommission !== undefined, 'baseCommission');
  requires('overs', signature.oversShare !== undefined, 'oversShare');
  requires('overs', signature.gstRate !== undefined, 'gstRate');
  requires('loaded', signature.loadingFactor !== undefined, 'loadingFactor');
  requires(
    'daily_interest',
    signature.rateMarkupFactor !== undefined,
    'rateMarkupFactor',
  );
  const daily = signature.commissionModel === 'daily_interest';
  if (daily !== (signature.interestMethod === 'daily'))
    problems.push('Only the daily_interest model uses daily interest');
  if (daily && signature.paymentTiming !== 'arrears')
    problems.push('Daily interest accrues in arrears');
  if (
    signature.defaultCommissionRate !== undefined &&
    signature.maxCommissionRate !== undefined &&
    signature.defaultCommissionRate
      .decimal()
      .greaterThan(signature.maxCommissionRate.decimal())
  )
    problems.push('defaultCommissionRate exceeds maxCommissionRate');
  for (const kind of lenderFeeKinds) {
    const fee = signature.fees[kind];
    if (fee?.maxAmount === undefined) continue;
    if (kind !== 'establishment')
      problems.push(`${kind} cannot have a dynamic maximum`);
    else if (fee.maxAmount.decimal().lessThan(fee.amount.decimal()))
      problems.push('establishment maxAmount is below its amount');
  }
  return problems;
}
