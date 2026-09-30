import { AnnualRate, Fraction, type Money } from '@swyft/finance';
import { calculateFromSignature, composeQuote } from './compose.js';
import {
  QuoteCompositionError,
  type FeeSignature,
  type QuoteRequest,
} from './fee-signature.js';

/**
 * Target commission calculator (brief nice-to-have: "reverse calculate required rate").
 *
 * - Commission overs: the lowest contract rate, on a 0.01% grid above the base rate, whose
 *   overs commission reaches the target. A target at or below the lender's base commission
 *   needs no dial-up (as in SPG's Branded calculator).
 * - Capitalised, loaded and daily-interest models: commission % = target / NAF, rounded up
 *   to 0.01% so the target is always reached. Daily interest also reports the resulting
 *   contract rate (base + commission % × markup).
 *
 * Every reported commission is recalculated with the same composition and engine as a
 * saved quote, so the figure shown is exactly what the quote will produce.
 */
export type TargetCommissionSolution =
  | {
      readonly kind: 'contract-rate';
      readonly contractRate: AnnualRate;
      readonly commission: Money;
      /** True when the lender's base commission already meets the target. */
      readonly metByBaseCommission: boolean;
    }
  | {
      readonly kind: 'commission-rate';
      readonly commissionRate: Fraction;
      readonly commission: Money;
      /** Daily-interest lenders only: the contract rate this commission produces. */
      readonly contractRate?: AnnualRate;
    };

const step = Fraction.from('0.0001').decimal(); // 0.01% in fraction units

function commissionOf(signature: FeeSignature, request: QuoteRequest): Money {
  const { result } = calculateFromSignature(signature, request);
  if (!('commission' in result))
    throw new QuoteCompositionError(
      'targetCommission',
      'This lender does not report a commission.',
    );
  return result.commission;
}

function solveContractRate(
  signature: FeeSignature,
  request: QuoteRequest,
  target: Money,
): TargetCommissionSolution {
  const base = request.baseRate.decimal();
  const at = (steps: number) =>
    commissionOf(signature, {
      ...request,
      contractRate: AnnualRate.from(base.plus(step.mul(steps))),
    });
  const atBase = at(0);
  if (atBase.decimal().greaterThanOrEqualTo(target.decimal()))
    return {
      kind: 'contract-rate',
      contractRate: request.baseRate,
      commission: atBase,
      metByBaseCommission: true,
    };
  // Commission never decreases as the contract rate rises; search the 0.01% grid up to 100%.
  let low = 0;
  let high = Math.floor(
    AnnualRate.from('1').decimal().minus(base).div(step).toNumber(),
  );
  if (at(high).decimal().lessThan(target.decimal()))
    throw new QuoteCompositionError(
      'targetCommission',
      'This commission cannot be reached with any contract rate.',
    );
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (at(middle).decimal().greaterThanOrEqualTo(target.decimal()))
      high = middle;
    else low = middle;
  }
  return {
    kind: 'contract-rate',
    contractRate: AnnualRate.from(base.plus(step.mul(high))),
    commission: at(high),
    metByBaseCommission: false,
  };
}

function solveCommissionRate(
  signature: FeeSignature,
  request: QuoteRequest,
  target: Money,
): TargetCommissionSolution {
  // NAF (finance amount + financed fees) does not depend on the commission rate.
  const { input } = composeQuote(signature, {
    ...request,
    commissionRate: Fraction.from('0'),
  });
  if (!('financedFees' in input) || !('financeAmount' in input))
    throw new QuoteCompositionError(
      'targetCommission',
      'This lender does not support a target commission.',
    );
  const naf = input.financeAmount.decimal().plus(input.financedFees.decimal());
  if (naf.isZero())
    throw new QuoteCompositionError(
      'financeAmount',
      'Enter the finance amount first.',
    );
  const rate = target.decimal().div(naf).div(step).ceil().mul(step);
  if (rate.greaterThan(1))
    throw new QuoteCompositionError(
      'targetCommission',
      'This commission is more than the amount financed.',
    );
  const commissionRate = Fraction.from(rate);
  const max = signature.maxCommissionRate;
  if (max !== undefined && rate.greaterThan(max.decimal()))
    throw new QuoteCompositionError(
      'targetCommission',
      `This needs ${rate.mul(100).toFixed(2)}% commission; this lender allows at most ${max.decimal().mul(100).toString()}%.`,
    );
  const { result } = calculateFromSignature(signature, {
    ...request,
    commissionRate,
  });
  if (!('commission' in result))
    throw new QuoteCompositionError(
      'targetCommission',
      'This lender does not report a commission.',
    );
  return {
    kind: 'commission-rate',
    commissionRate,
    commission: result.commission,
    ...(signature.commissionModel === 'daily_interest' &&
      result.effectiveAnnualRate && {
        contractRate: result.effectiveAnnualRate,
      }),
  };
}

/** The broker's current commission choice is what is being solved for, so drop it. */
function withoutCommissionChoice(request: QuoteRequest): QuoteRequest {
  const copy: { -readonly [K in keyof QuoteRequest]?: QuoteRequest[K] } = {
    ...request,
  };
  delete copy.commissionRate;
  delete copy.contractRate;
  return copy as QuoteRequest;
}

/**
 * Finds the rate that earns at least `target` commission for this signature and loan.
 * The broker's current commission or contract rate in `request` is ignored (it is what
 * is being solved for). Throws QuoteCompositionError, naming the field to highlight,
 * when the target cannot be met: it is negative or above the amount financed, it needs
 * more than the lender's commission cap, no contract rate reaches it, or the finance
 * amount is missing.
 */
export function solveTargetCommission(
  signature: FeeSignature,
  request: QuoteRequest,
  target: Money,
): TargetCommissionSolution {
  if (target.decimal().isNegative())
    throw new QuoteCompositionError(
      'targetCommission',
      'Enter a commission of $0 or more.',
    );
  const rest = withoutCommissionChoice(request);
  return signature.commissionModel === 'overs'
    ? solveContractRate(signature, rest, target)
    : solveCommissionRate(signature, rest, target);
}
