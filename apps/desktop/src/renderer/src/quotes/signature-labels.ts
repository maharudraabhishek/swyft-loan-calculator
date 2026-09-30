import type { FeeSignatureDto } from '@swyft/contracts';
import { formatMoney, formatRateCompact } from '../../../shared/format';

/** Broker-facing names for the brief's four commission models. */
export const commissionModelLabels: Record<
  FeeSignatureDto['commissionModel'],
  string
> = {
  capitalised: 'Capitalised brokerage',
  overs: 'Commission overs',
  loaded: 'Loaded commission',
  daily_interest: 'Daily interest, rate-adjusted commission',
};

const timingLabels: Record<FeeSignatureDto['paymentTiming'], string> = {
  advance: 'Advance',
  arrears: 'Arrears',
};

/**
 * Payment timing as a broker should read it. For monthly lenders the stored timing is
 * the brief's Advance/Arrears. Daily-interest lenders are stored as `arrears` because
 * each repayment pays the interest accrued since the previous date, but when repayments
 * start is set by the first repayment date (an advance-style start is a first repayment
 * days after settlement), so "Arrears" alone would mislead.
 */
export function paymentTimingLabel(item: {
  readonly paymentTiming: FeeSignatureDto['paymentTiming'];
  readonly interestMethod: FeeSignatureDto['interestMethod'];
}): string {
  return item.interestMethod === 'daily'
    ? 'From 1st repayment date'
    : timingLabels[item.paymentTiming];
}

/** Broker-facing names of the lender fee types. */
export const feeLabels = {
  establishment: 'Lender fee',
  ppsrRegistration: 'PPSR registration',
  ppsrSearch: 'PPSR search',
  privateSale: 'Private sale fee',
} as const;

/** A lender fee type (key of {@link feeLabels}). */
export type LenderFeeKind = keyof typeof feeLabels;
/** Fee types in display order. */
export const lenderFeeKinds = Object.keys(feeLabels) as LenderFeeKind[];

/** "Westpac — Dealer" for a fee signature or a saved quote. */
export function signatureTitle(
  item:
    | { readonly lenderName: string; readonly name: string }
    | { readonly lenderName: string; readonly feeSignatureName: string },
): string {
  return `${item.lenderName} — ${'name' in item ? item.name : item.feeSignatureName}`;
}

/** One-line fee summary, e.g. "Lender fee $550 · PPSR registration $6 · $8.00 monthly fee". */
export function feeSummary(signature: FeeSignatureDto): string {
  const parts: string[] = [];
  for (const kind of lenderFeeKinds) {
    const fee = signature.fees[kind];
    if (fee === undefined) continue;
    const max = 'maxAmount' in fee ? fee.maxAmount : undefined;
    parts.push(
      max === undefined
        ? `${feeLabels[kind]} ${formatMoney(fee.amount)}`
        : `${feeLabels[kind]} ${formatMoney(fee.amount)}–${formatMoney(max)} (rises with origination)`,
    );
  }
  parts.push(
    Number(signature.monthlyFee) > 0
      ? `${formatMoney(signature.monthlyFee)} monthly fee`
      : 'no monthly fee',
  );
  if (Number(signature.slidingFee) > 0)
    parts.push(`${formatMoney(signature.slidingFee)} first-payment fee`);
  if (signature.roundPaymentUpToDollar === true)
    parts.push('repayments rounded up to whole dollars');
  return parts.join(' · ');
}

/** Commission terms in broker language, e.g. "4% standard, up to 6%". */
export function commissionSummary(signature: FeeSignatureDto): string {
  if (signature.commissionModel === 'overs') {
    const share =
      signature.oversShare === null
        ? ''
        : `${formatRateCompact(signature.oversShare)} of the rate overs`;
    const floor =
      signature.baseCommission === null
        ? ''
        : `, minimum ${formatMoney(signature.baseCommission)}`;
    return `${share}${floor} (incl. GST)`;
  }
  const parts: string[] = [];
  if (signature.defaultCommissionRate !== null)
    parts.push(
      `${formatRateCompact(signature.defaultCommissionRate)} standard`,
    );
  if (signature.maxCommissionRate !== null)
    parts.push(`up to ${formatRateCompact(signature.maxCommissionRate)}`);
  if (
    signature.commissionModel === 'daily_interest' &&
    signature.rateMarkupFactor
  )
    parts.push(
      `adds ${formatRateCompact(signature.rateMarkupFactor)} × commission to the rate`,
    );
  return parts.length > 0 ? parts.join(', ') : 'Enter the commission per quote';
}

/** What the saved commission figure represents, so earnings compare like-for-like. */
export function commissionBasis(
  model: FeeSignatureDto['commissionModel'],
): string {
  switch (model) {
    case 'capitalised':
      return 'ex GST; lender adds 10% GST';
    case 'overs':
      return 'incl. GST, from rate overs';
    case 'loaded':
      return '% of NAF, serviced by the rate';
    case 'daily_interest':
      return '% of NAF, capitalised';
  }
}
