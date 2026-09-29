import type { AnnualRate, Fraction, Money } from './value-objects.js';

export type PaymentTiming = 'advance' | 'arrears';

interface CommonInput {
  readonly termMonths: number;
  readonly timing?: PaymentTiming;
  readonly balloon?: Money;
  readonly monthlyFee?: Money;
  readonly upfrontFees?: Money;
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

export type AutopayInput = AutopayContractTermsInput | AutopayOriginationInput;

export type QuoteInput =
  CapitalisedInput | BrandedInput | PepperInput | AutopayInput;

interface CommonResult {
  readonly monthlyPayment: Money;
  readonly grossMonthlyPayment: Money;
  /** Quoted cent PMT × term + balloon + upfront fees; excludes account/sliding fees. */
  readonly totalHiring: Money;
  readonly netAmountFinanced: Money;
  readonly amountFinanced: Money;
  readonly effectiveAnnualRate?: AnnualRate;
}

export interface CapitalisedResult extends CommonResult {
  readonly model: 'capitalised';
  /** GST is paid by the lender on top of the capitalised, GST-exclusive commission. */
  readonly brokerReceives: Money;
  readonly commission: Money;
  readonly totalInterest: Money;
}

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

export interface AutopayContractTermsResult extends AutopayCommonResult {
  readonly mode: 'contract-terms';
}

export interface AutopayOriginationResult extends AutopayCommonResult {
  readonly mode: 'origination';
  readonly commission: Money;
}

export type AutopayResult =
  AutopayContractTermsResult | AutopayOriginationResult;

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
