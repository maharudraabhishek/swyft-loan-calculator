import type { AnnualRate, Fraction, Money } from './value-objects.js';

/**
 * When instalments fall: `advance` pays the first one at settlement (so the payment is
 * the arrears payment ÷ (1 + i)); `arrears` pays it one period after settlement.
 */
export type PaymentTiming = 'advance' | 'arrears';

/**
 * How the repayment is rounded (brief, "Rounding Rules"):
 * - `cent` (default): the formula payment rounded half-up to the cent.
 * - `dollar-up`: that cent payment rounded up to the next whole dollar, for lenders that
 *   charge whole-dollar instalments. The final instalment is then reduced so the loan
 *   closes exactly, and rates and totals are based on the amounts actually charged.
 */
export type PaymentRounding = 'cent' | 'dollar-up';

interface CommonInput {
  readonly termMonths: number;
  readonly timing?: PaymentTiming;
  readonly balloon?: Money;
  readonly monthlyFee?: Money;
  readonly upfrontFees?: Money;
  readonly paymentRounding?: PaymentRounding;
}

/** Commission is capitalised; payment is calculated on NAF plus commission. */
export interface CapitalisedInput extends CommonInput {
  readonly model: 'capitalised';
  readonly financeAmount: Money;
  readonly financedFees: Money;
  readonly baseRate: AnnualRate;
  readonly commissionRate: Fraction;
}

/** Broker receives the larger of base commission and grossed-up rate overs. */
export interface BrandedInput extends CommonInput {
  readonly model: 'branded';
  readonly financeAmount: Money;
  readonly financedFees: Money;
  readonly baseRate: AnnualRate;
  readonly contractRate: AnnualRate;
  readonly baseCommission?: Money;
  readonly oversShare?: Fraction;
  readonly gstRate?: Fraction;
}

/** Pepper funds a rate-adjusted fraction of the nominal commission. */
export interface PepperInput extends CommonInput {
  readonly model: 'pepper';
  readonly financeAmount: Money;
  readonly financedFees: Money;
  readonly financierRate: AnnualRate;
  readonly commissionRate: Fraction;
  readonly loadingFactor?: Fraction;
}

interface AutopayCommonInput extends CommonInput {
  readonly model: 'autopay';
  readonly settlementDate: string;
  readonly firstRepaymentDate: string;
  readonly slidingFee?: Money;
  readonly adjustBusinessDays?: boolean;
}

/** Contract terms can be tested when the source does not disclose its original commission. */
export interface AutopayContractTermsInput extends AutopayCommonInput {
  readonly mode: 'contract-terms';
  readonly startingPrincipal: Money;
  readonly annualRate: AnnualRate;
}

/** Origination derives contract rate and capitalised commission from user inputs. */
export interface AutopayOriginationInput extends AutopayCommonInput {
  readonly mode: 'origination';
  readonly financeAmount: Money;
  readonly financedFees: Money;
  readonly baseRate: AnnualRate;
  readonly commissionRate: Fraction;
  readonly rateMarkupFactor?: Fraction;
}

/** Either form of an Autopay/MoneyMe (daily interest) quote. */
export type AutopayInput = AutopayContractTermsInput | AutopayOriginationInput;

/** Input for any of the four commission models; `model` selects which. */
export type QuoteInput =
  CapitalisedInput | BrandedInput | PepperInput | AutopayInput;

interface CommonResult {
  /** The instalment charged, before the monthly account fee (see {@link PaymentRounding}). */
  readonly monthlyPayment: Money;
  /** Instalment plus the monthly account fee: what the customer pays each month. */
  readonly grossMonthlyPayment: Money;
  /**
   * What the customer pays in instalments, balloon and fees paid at settlement:
   * payment × term + balloon + upfront fees (whole-dollar lenders: the instalments
   * actually charged, including the smaller final one). Excludes account and sliding
   * fees, which are shown separately.
   */
  readonly totalHiring: Money;
  /** NAF: finance amount plus the fees the customer chose to finance. */
  readonly netAmountFinanced: Money;
  /** The balance interest is charged on (NAF plus any capitalised commission). */
  readonly amountFinanced: Money;
  /**
   * Traditional and Pepper: the comparison (customer) rate, i.e. the rate on NAF alone
   * that produces the payment. Branded: the contract rate. Autopay: the contract rate.
   */
  readonly effectiveAnnualRate?: AnnualRate;
}

/** Traditional capitalised brokerage: commission = % of NAF, added to the loan. */
export interface CapitalisedResult extends CommonResult {
  readonly model: 'capitalised';
  /** GST is paid by the lender on top of the capitalised, GST-exclusive commission. */
  readonly brokerReceives: Money;
  readonly commission: Money;
  readonly totalInterest: Money;
}

/** Commission overs: the broker earns from the contract rate above the base rate. */
export interface BrandedResult extends CommonResult {
  readonly model: 'branded';
  readonly commission: Money;
  /** Instalment at the base rate with the quote's payment timing. */
  readonly baseNetPayment: Money;
  /** Overs basis: arrears PMT × term at the base / contract rate (equals repayments × term only for arrears quotes). */
  readonly baseTotalHiring: Money;
  readonly finalTotalHiring: Money;
  readonly hiringDifference: Money;
  readonly oversBeforeGst: Money;
  readonly oversWithGst: Money;
}

/** Loaded commission: part of the commission (the loading) is added to the loan. */
export interface PepperResult extends CommonResult {
  readonly model: 'pepper';
  readonly commission: Money;
  readonly loading: Fraction;
  readonly upfrontFees: Money;
}

interface AutopayCommonResult extends CommonResult {
  readonly model: 'autopay';
  readonly firstPaymentInterest: Money;
  readonly firstPaymentDays: number;
}

/** Autopay quote from stated contract terms (starting principal and rate). */
export interface AutopayContractTermsResult extends AutopayCommonResult {
  readonly mode: 'contract-terms';
}

/** Autopay quote originated in the app: rate adjusted and commission capitalised. */
export interface AutopayOriginationResult extends AutopayCommonResult {
  readonly mode: 'origination';
  readonly commission: Money;
}

/** Result of either Autopay input form. */
export type AutopayResult =
  AutopayContractTermsResult | AutopayOriginationResult;

/** Result of {@link calculateQuote}; narrow on `model` for model-specific figures. */
export type QuoteResult =
  CapitalisedResult | BrandedResult | PepperResult | AutopayResult;

/** Payment excludes account/sliding fees; dueDate and days exist for daily schedules. */
export interface ScheduleRow {
  readonly period: number;
  readonly dueDate?: string;
  readonly days?: number;
  readonly openingBalance: Money;
  readonly payment: Money;
  readonly interest: Money;
  readonly principal: Money;
  readonly fee: Money;
  readonly closingBalance: Money;
}
