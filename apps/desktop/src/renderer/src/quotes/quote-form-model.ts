import {
  quoteCreateSchema,
  type FeeSignatureDto,
  type QuoteCreateDto,
} from '@swyft/contracts';
import { fractionToPercent, percentToFraction } from '../../../shared/format';
import {
  feeLabels,
  lenderFeeKinds,
  type LenderFeeKind,
} from './signature-labels';

/**
 * The quote builder's form: what the broker typed, in their units (dollars, percent,
 * months). It is converted to the shared `QuoteCreateDto` only through
 * `toQuoteRequest`, which validates with the same zod schema the API uses. Values are
 * never silently corrected.
 */
export interface QuoteFormValues {
  readonly assetDescription: string;
  readonly financeAmount: string;
  readonly termMonths: string;
  /** Percent, e.g. "8.5". */
  readonly baseRate: string;
  /** Percent; blank means "use the lender's standard commission". */
  readonly commissionRate: string;
  /** Percent; overs lenders only. */
  readonly contractRate: string;
  readonly balloon: string;
  readonly originationFee: string;
  readonly originationFinanced: boolean;
  readonly feeFinancing: Readonly<Partial<Record<LenderFeeKind, boolean>>>;
  readonly settlementDate: string;
  readonly firstRepaymentDate: string;
}

/** Text inputs of the quote form, named as in the request. */
export type QuoteFormField = Exclude<
  keyof QuoteFormValues,
  'feeFinancing' | 'originationFinanced'
>;
/** Messages to show next to inputs (`form` = not tied to one input). */
export type FieldErrors = Partial<Record<QuoteFormField | 'form', string>>;

/** A lender fee the broker can choose to finance or pay at settlement. */
export interface FeeToggle {
  readonly kind: LenderFeeKind;
  readonly label: string;
  readonly amount: string;
  readonly maxAmount?: string;
  readonly financedByDefault: boolean;
}

/** Which inputs a signature needs; presentation only — rules live in @swyft/quoting. */
export interface FieldPlan {
  readonly commission: 'rate' | 'overs';
  readonly needsDates: boolean;
  readonly baseRateLabel: string;
  readonly defaultCommissionPercent?: string;
  readonly maxCommissionPercent?: string;
  readonly maxOrigination?: string;
  readonly fees: readonly FeeToggle[];
}

/** Which inputs, labels and fee toggles the form shows for this signature. */
export function planFor(signature: FeeSignatureDto): FieldPlan {
  const fees: FeeToggle[] = [];
  for (const kind of lenderFeeKinds) {
    const fee = signature.fees[kind];
    if (fee === undefined) continue;
    const maxAmount = 'maxAmount' in fee ? fee.maxAmount : undefined;
    fees.push({
      kind,
      label: feeLabels[kind],
      amount: fee.amount,
      ...(maxAmount !== undefined && { maxAmount }),
      financedByDefault: fee.financed,
    });
  }
  return {
    commission: signature.commissionModel === 'overs' ? 'overs' : 'rate',
    needsDates: signature.commissionModel === 'daily_interest',
    baseRateLabel:
      signature.commissionModel === 'loaded'
        ? 'Financier (base) rate'
        : 'Base rate',
    ...(signature.defaultCommissionRate !== null && {
      defaultCommissionPercent: fractionToPercent(
        signature.defaultCommissionRate,
      ),
    }),
    ...(signature.maxCommissionRate !== null && {
      maxCommissionPercent: fractionToPercent(signature.maxCommissionRate),
    }),
    ...(signature.maxBrokerOrigination !== null && {
      maxOrigination: signature.maxBrokerOrigination,
    }),
    fees,
  };
}

function isoDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Sensible starting values; dates default to today and one month later. */
export function initialFormValues(today = new Date()): QuoteFormValues {
  const next = new Date(today);
  next.setMonth(next.getMonth() + 1);
  return {
    assetDescription: '',
    financeAmount: '',
    termMonths: '60',
    baseRate: '',
    commissionRate: '',
    contractRate: '',
    balloon: '',
    originationFee: '',
    originationFinanced: true,
    feeFinancing: {},
    settlementDate: isoDate(today),
    firstRepaymentDate: isoDate(next),
  };
}

/** When the lender changes, lender-specific choices reset; deal facts stay. */
export function valuesForSignature(
  values: QuoteFormValues,
  signature: FeeSignatureDto,
): QuoteFormValues {
  return {
    ...values,
    commissionRate:
      signature.defaultCommissionRate === null
        ? ''
        : fractionToPercent(signature.defaultCommissionRate),
    contractRate:
      signature.commissionModel === 'overs' ? values.contractRate : '',
    feeFinancing: {},
  };
}

/** Accepts what brokers type ("$30,000", "8.5%") without changing its value. */
function cleanNumber(text: string): string {
  return text.replace(/[\s,$%]/g, '');
}

const decimalText = /^\d+(\.\d+)?$/;

function percentField(
  text: string,
  field: QuoteFormField,
  errors: FieldErrors,
): string | undefined {
  const cleaned = cleanNumber(text);
  if (cleaned === '') return undefined;
  if (!decimalText.test(cleaned) || Number(cleaned) > 100) {
    errors[field] = 'Enter a percentage from 0 to 100, e.g. 8.5';
    return undefined;
  }
  return percentToFraction(cleaned);
}

/** Schema messages phrased for the fields as the broker sees them. */
const friendlyMessages: Partial<Record<QuoteFormField, string>> = {
  // The shared money schema allows at most $999,999,999.99 (nine whole-dollar digits).
  financeAmount:
    'Enter an amount greater than zero and under $1 billion, e.g. 30000',
  termMonths: 'Enter a term from 1 to 600 whole months',
  balloon: 'Enter a dollar amount such as 5000 (or leave blank for none)',
  originationFee: 'Enter a dollar amount such as 990 (or leave blank)',
  baseRate: 'Enter a percentage from 0 to 100, e.g. 8.5',
  commissionRate: 'Enter a percentage from 0 to 100, e.g. 4',
  contractRate: 'Enter a percentage from 0 to 100, e.g. 10.5',
  settlementDate: 'Choose a valid date',
  firstRepaymentDate: 'Choose a valid date',
  assetDescription: 'Use at most 200 characters without control characters',
};

const formFields = new Set<string>([
  'assetDescription',
  'financeAmount',
  'termMonths',
  'baseRate',
  'commissionRate',
  'contractRate',
  'balloon',
  'originationFee',
  'settlementDate',
  'firstRepaymentDate',
]);

/** Maps request-level field errors (preview or API) onto form fields. */
export function toFieldErrors(
  fields: Readonly<Record<string, string>>,
): FieldErrors {
  const errors: FieldErrors = {};
  for (const [key, message] of Object.entries(fields)) {
    if (formFields.has(key)) errors[key as QuoteFormField] = message;
    else errors.form ??= message;
  }
  return errors;
}

/** The request to send, or the problems that stop it being sent. */
export type RequestResult =
  | { readonly ok: true; readonly request: QuoteCreateDto }
  | { readonly ok: false; readonly errors: FieldErrors };

/**
 * Builds the exact request a save will send, validated by the shared API schema.
 * Irrelevant fields for the signature are omitted rather than sent.
 */
export function toQuoteRequest(
  values: QuoteFormValues,
  signature: FeeSignatureDto,
): RequestResult {
  const plan = planFor(signature);
  const errors: FieldErrors = {};

  const financeAmount = cleanNumber(values.financeAmount);
  if (financeAmount === '') errors.financeAmount = 'Enter the finance amount';
  const baseRate = percentField(values.baseRate, 'baseRate', errors);
  if (values.baseRate.trim() === '')
    errors.baseRate = `Enter the ${plan.baseRateLabel.toLowerCase()}`;
  const term = cleanNumber(values.termMonths);
  if (!/^\d+$/.test(term))
    errors.termMonths = 'Enter a term from 1 to 600 whole months';

  const commissionRate =
    plan.commission === 'rate'
      ? percentField(values.commissionRate, 'commissionRate', errors)
      : undefined;
  const contractRate =
    plan.commission === 'overs'
      ? percentField(values.contractRate, 'contractRate', errors)
      : undefined;
  if (plan.commission === 'overs' && values.contractRate.trim() === '')
    errors.contractRate = 'Enter the contract (customer) rate';

  if (plan.needsDates) {
    if (values.settlementDate === '')
      errors.settlementDate = 'Choose the settlement date';
    if (values.firstRepaymentDate === '')
      errors.firstRepaymentDate = 'Choose the first repayment date';
    // Date order is an engine rule; the preview reports it on this field.
  }

  const feeFinancing = Object.fromEntries(
    plan.fees
      .map((fee) => [fee.kind, values.feeFinancing[fee.kind]] as const)
      .filter(([, financed]) => financed !== undefined),
  );
  const candidate = {
    feeSignatureId: signature.id,
    assetDescription: values.assetDescription.trim(),
    financeAmount,
    termMonths: Number(term),
    ...(baseRate !== undefined && { baseRate }),
    ...(commissionRate !== undefined && { commissionRate }),
    ...(contractRate !== undefined && { contractRate }),
    balloon: cleanNumber(values.balloon) || '0',
    originationFee: cleanNumber(values.originationFee) || '0',
    originationFinanced: values.originationFinanced,
    feeFinancing,
    ...(plan.needsDates &&
      values.settlementDate !== '' && {
        settlementDate: values.settlementDate,
      }),
    ...(plan.needsDates &&
      values.firstRepaymentDate !== '' && {
        firstRepaymentDate: values.firstRepaymentDate,
      }),
  };
  const parsed = quoteCreateSchema.safeParse(candidate);
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && formFields.has(key))
        errors[key as QuoteFormField] ??=
          friendlyMessages[key as QuoteFormField] ?? issue.message;
      else errors.form ??= 'Some values are not valid.';
    }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  // Send the pre-default input shape; the server applies the same defaults.
  return { ok: true, request: candidate as QuoteCreateDto };
}
