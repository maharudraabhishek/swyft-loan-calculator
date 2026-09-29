import { Decimal } from './decimal.js';
import type { PaymentTiming } from './types.js';

const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const TWELVE = new Decimal(12);

/** Level repayment with a residual due after the final regular instalment. */
export function monthlyPayment(
  principal: Decimal,
  annualRate: Decimal,
  termMonths: number,
  balloon: Decimal,
  timing: PaymentTiming,
): Decimal {
  if (termMonths < 1 || !Number.isSafeInteger(termMonths))
    throw new RangeError('Term must be whole months');
  if (balloon.isNegative() || balloon.greaterThan(principal))
    throw new RangeError('Invalid balloon');
  if (annualRate.isNegative()) throw new RangeError('Negative interest rate');

  const monthlyRate = annualRate.div(TWELVE);
  if (monthlyRate.isZero()) return principal.minus(balloon).div(termMonths);

  const discount = ONE.plus(monthlyRate).pow(termMonths);
  const arrears = principal
    .minus(balloon.div(discount))
    .mul(monthlyRate)
    .div(ONE.minus(ONE.div(discount)));
  return timing === 'advance' ? arrears.div(ONE.plus(monthlyRate)) : arrears;
}

/** Find the annual fraction producing the lender payment on the uncapitalised NAF. */
export function solveAnnualRate(
  targetPayment: Decimal,
  principal: Decimal,
  termMonths: number,
  balloon: Decimal,
  timing: PaymentTiming,
): Decimal {
  const lowerPayment = monthlyPayment(
    principal,
    ZERO,
    termMonths,
    balloon,
    timing,
  );
  if (targetPayment.lessThan(lowerPayment))
    throw new RangeError('Payment implies a negative annual rate');
  if (targetPayment.equals(lowerPayment)) return ZERO;

  let low = ZERO;
  let high = ONE;
  if (
    targetPayment.greaterThan(
      monthlyPayment(principal, high, termMonths, balloon, timing),
    )
  ) {
    throw new RangeError(
      'Payment implies an annual rate above the supported 100% bound',
    );
  }

  // Bisection has no local minima and converges to sub-cent PMT error well before 100 steps.
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const mid = low.plus(high).div(2);
    const payment = monthlyPayment(principal, mid, termMonths, balloon, timing);
    if (payment.lessThan(targetPayment)) low = mid;
    else high = mid;
  }
  return low.plus(high).div(2);
}
