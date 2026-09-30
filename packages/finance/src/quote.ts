import { Decimal } from './decimal.js';
import {
  amortizeDaily,
  amortizeMonthly,
  sumInstalments,
} from './amortization.js';
import { createDailyRepaymentPlan } from './daily.js';
import { monthlyPayment, solveAnnualRate } from './math.js';
import type {
  AutopayInput,
  AutopayOriginationInput,
  AutopayOriginationResult,
  AutopayResult,
  BrandedInput,
  BrandedResult,
  CapitalisedInput,
  CapitalisedResult,
  PepperInput,
  PepperResult,
  QuoteInput,
  QuoteResult,
} from './types.js';
import { AnnualRate, Fraction, Money } from './value-objects.js';

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

function requireNonnegative(name: string, money: Money): Decimal {
  if (!(money instanceof Money) || money.decimal().isNegative()) {
    throw new RangeError(`${name} must be nonnegative Money`);
  }
  return money.decimal();
}

function optionalNonnegative(name: string, money?: Money): Decimal {
  return money ? requireNonnegative(name, money) : ZERO;
}

function requireRate(name: string, rate: AnnualRate): Decimal {
  if (!(rate instanceof AnnualRate))
    throw new TypeError(`${name} must be AnnualRate`);
  return rate.decimal();
}

function requireFraction(name: string, fraction: Fraction): Decimal {
  if (!(fraction instanceof Fraction))
    throw new TypeError(`${name} must be Fraction`);
  return fraction.decimal();
}

function validateCommon(input: QuoteInput): void {
  if (
    !Number.isSafeInteger(input.termMonths) ||
    input.termMonths < 1 ||
    input.termMonths > 600
  ) {
    throw new RangeError('Term must be an integer from 1 to 600 months');
  }
  if (
    input.timing !== undefined &&
    input.timing !== 'advance' &&
    input.timing !== 'arrears'
  ) {
    throw new RangeError('Invalid payment timing');
  }
  if (input.model === 'autopay' && input.timing === 'advance') {
    throw new RangeError('Autopay daily accrual requires arrears timing');
  }
  if (
    input.paymentRounding !== undefined &&
    input.paymentRounding !== 'cent' &&
    input.paymentRounding !== 'dollar-up'
  ) {
    throw new RangeError('Invalid payment rounding');
  }
  optionalNonnegative('balloon', input.balloon);
  optionalNonnegative('monthly fee', input.monthlyFee);
  optionalNonnegative('upfront fees', input.upfrontFees);
}

/** Brief's hiring total uses displayed cent PMT; account/sliding fees are separate. */
function totalHiring(input: QuoteInput, payment: Money): Money {
  return Money.from(
    payment
      .decimal()
      .mul(input.termMonths)
      .plus(input.balloon?.decimal() ?? ZERO)
      .plus(input.upfrontFees?.decimal() ?? ZERO),
  ).roundCents();
}

const isDollarUp = (input: QuoteInput) => input.paymentRounding === 'dollar-up';

/**
 * The repayment actually charged: the formula payment rounded to the cent, then — for
 * whole-dollar lenders — up to the next dollar (a payment already in whole dollars
 * stays as it is).
 */
function chargedPayment(payment: Decimal, input: QuoteInput): Money {
  const cents = Money.from(payment).roundCents();
  return isDollarUp(input)
    ? Money.from(cents.decimal().toDecimalPlaces(0, Decimal.ROUND_UP))
    : cents;
}

/**
 * Whole-dollar lenders: total hiring from the instalments actually charged (the last
 * one is smaller), plus the balloon and the fees paid at settlement.
 */
function hiringFromInstalments(input: QuoteInput, paid: Decimal): Money {
  return Money.from(
    paid
      .plus(input.balloon?.decimal() ?? ZERO)
      .plus(input.upfrontFees?.decimal() ?? ZERO),
  ).roundCents();
}

function calculateCapitalised(input: CapitalisedInput): QuoteResult {
  const naf = requireNonnegative('finance amount', input.financeAmount).plus(
    requireNonnegative('financed fees', input.financedFees),
  );
  const commission = naf.mul(
    requireFraction('commission rate', input.commissionRate),
  );
  const funded = naf.plus(commission);
  const balloon = optionalNonnegative('balloon', input.balloon);
  const timing = input.timing ?? 'advance';
  const baseRate = requireRate('base rate', input.baseRate);
  const payment = monthlyPayment(
    funded,
    baseRate,
    input.termMonths,
    balloon,
    timing,
  );
  const charged = chargedPayment(payment, input);
  // Comparison rate: the rate on NAF alone that produces the payment. Cent lenders use
  // the full-precision payment (as the reference calculator does); whole-dollar lenders
  // use the payment actually charged.
  const effectiveRate = solveAnnualRate(
    isDollarUp(input) ? charged.decimal() : payment,
    naf,
    input.termMonths,
    balloon,
    timing,
  );
  let hiring = totalHiring(input, charged);
  // The reference calculator totals the unrounded PMT, then rounds the display.
  let totalPaid = payment.mul(input.termMonths);
  if (isDollarUp(input)) {
    totalPaid = sumInstalments(
      amortizeMonthly({
        startingBalance: funded,
        monthlyRate: baseRate.div(12),
        termMonths: input.termMonths,
        payment: charged.decimal(),
        balloon,
        timing,
      }),
    );
    hiring = hiringFromInstalments(input, totalPaid);
  }
  return {
    model: 'capitalised',
    monthlyPayment: charged,
    totalHiring: hiring,
    grossMonthlyPayment: Money.from(
      charged
        .decimal()
        .plus(optionalNonnegative('monthly fee', input.monthlyFee)),
    ),
    netAmountFinanced: Money.from(naf),
    amountFinanced: Money.from(funded),
    commission: Money.from(commission).roundCents(),
    brokerReceives: Money.from(commission.mul('1.10')).roundCents(),
    effectiveAnnualRate: AnnualRate.from(effectiveRate),
    totalInterest: Money.from(
      totalPaid.plus(balloon).minus(funded),
    ).roundCents(),
  };
}

function calculateBranded(input: BrandedInput): QuoteResult {
  const naf = requireNonnegative('finance amount', input.financeAmount).plus(
    requireNonnegative('financed fees', input.financedFees),
  );
  const baseRate = requireRate('base rate', input.baseRate);
  const contractRate = requireRate('contract rate', input.contractRate);
  if (contractRate.lessThan(baseRate))
    throw new RangeError('Contract rate cannot be below base rate');
  const balloon = optionalNonnegative('balloon', input.balloon);
  const timing = input.timing ?? 'arrears';
  const instalment = (rate: Decimal, basis: 'advance' | 'arrears') =>
    Money.from(
      monthlyPayment(naf, rate, input.termMonths, balloon, basis),
    ).roundCents();
  const basePayment = instalment(baseRate, timing);
  const finalPayment = instalment(contractRate, timing);
  // Overs always come from standard (arrears) PMTs, whatever the repayment timing: the
  // brief's overs formula uses plain PMT(NAF, Rate, Term, Balloon), and its three Branded
  // contracts (advance repayments) state commissions equal to arrears-basis overs.
  // Instalments are cent-rounded as in the central JSON case ($939.51); the contracts'
  // unrounded basis differs by up to $0.44.
  const baseHiring = instalment(baseRate, 'arrears')
    .decimal()
    .mul(input.termMonths);
  const finalHiring = instalment(contractRate, 'arrears')
    .decimal()
    .mul(input.termMonths);
  const difference = finalHiring.minus(baseHiring);
  const oversShare = input.oversShare
    ? requireFraction('overs share', input.oversShare)
    : new Decimal('0.75');
  const gstRate = input.gstRate
    ? requireFraction('GST rate', input.gstRate)
    : new Decimal('0.10');
  const oversBeforeGst = difference.mul(oversShare);
  const oversWithGst = oversBeforeGst.mul(ONE.plus(gstRate));
  const baseCommission = optionalNonnegative(
    'base commission',
    input.baseCommission ?? Money.from('110'),
  );
  const commission = Decimal.max(baseCommission, oversWithGst);
  // Commission above comes from the formula instalments; a whole-dollar lender only
  // changes what the customer is charged.
  const charged = chargedPayment(finalPayment.decimal(), input);
  const hiring = isDollarUp(input)
    ? hiringFromInstalments(
        input,
        sumInstalments(
          amortizeMonthly({
            startingBalance: naf,
            monthlyRate: contractRate.div(12),
            termMonths: input.termMonths,
            payment: charged.decimal(),
            balloon,
            timing,
          }),
        ),
      )
    : totalHiring(input, finalPayment);
  return {
    model: 'branded',
    monthlyPayment: charged,
    totalHiring: hiring,
    grossMonthlyPayment: Money.from(
      charged
        .decimal()
        .plus(optionalNonnegative('monthly fee', input.monthlyFee)),
    ),
    netAmountFinanced: Money.from(naf),
    amountFinanced: Money.from(naf),
    commission: Money.from(commission).roundCents(),
    effectiveAnnualRate: input.contractRate,
    baseNetPayment: basePayment,
    baseTotalHiring: Money.from(baseHiring),
    finalTotalHiring: Money.from(finalHiring),
    hiringDifference: Money.from(difference),
    oversBeforeGst: Money.from(oversBeforeGst).roundCents(),
    oversWithGst: Money.from(oversWithGst).roundCents(),
  };
}

function calculatePepper(input: PepperInput): QuoteResult {
  const naf = requireNonnegative('finance amount', input.financeAmount).plus(
    requireNonnegative('financed fees', input.financedFees),
  );
  if (naf.isZero()) throw new RangeError('Pepper NAF must be positive');
  const upfrontFees = optionalNonnegative('upfront fees', input.upfrontFees);
  const financierRate = requireRate('financier rate', input.financierRate);
  const commission = naf.mul(
    requireFraction('commission rate', input.commissionRate),
  );
  const factor = input.loadingFactor
    ? requireFraction('loading factor', input.loadingFactor)
    : new Decimal('0.4');
  // Reference formula: NAF/(NAF+commission) × (1 - 0.4 × financier annual fraction).
  const loading = naf
    .div(naf.plus(commission))
    .mul(ONE.minus(factor.mul(financierRate)));
  const funded = naf.plus(loading.mul(commission));
  const balloon = optionalNonnegative('balloon', input.balloon);
  const timing = input.timing ?? 'advance';
  const payment = monthlyPayment(
    funded,
    financierRate,
    input.termMonths,
    balloon,
    timing,
  );
  const charged = chargedPayment(payment, input);
  // Customer rate: the rate on NAF that produces the payment (whole-dollar lenders: the
  // payment actually charged). Pepper's schedule amortises NAF at this rate.
  const effectiveRate = solveAnnualRate(
    isDollarUp(input) ? charged.decimal() : payment,
    naf,
    input.termMonths,
    balloon,
    timing,
  );
  const hiring = isDollarUp(input)
    ? hiringFromInstalments(
        input,
        sumInstalments(
          amortizeMonthly({
            startingBalance: naf,
            monthlyRate: effectiveRate.div(12),
            termMonths: input.termMonths,
            payment: charged.decimal(),
            balloon,
            timing,
          }),
        ),
      )
    : totalHiring(input, charged);
  return {
    model: 'pepper',
    monthlyPayment: charged,
    totalHiring: hiring,
    grossMonthlyPayment: Money.from(
      charged
        .decimal()
        .plus(optionalNonnegative('monthly fee', input.monthlyFee)),
    ),
    netAmountFinanced: Money.from(naf),
    amountFinanced: Money.from(funded),
    commission: Money.from(commission).roundCents(),
    effectiveAnnualRate: AnnualRate.from(effectiveRate),
    loading: Fraction.from(loading),
    upfrontFees: Money.from(upfrontFees),
  };
}

function calculateAutopay(input: AutopayInput): QuoteResult {
  const netAmountFinanced =
    input.mode === 'contract-terms'
      ? requireNonnegative('starting principal', input.startingPrincipal)
      : requireNonnegative('finance amount', input.financeAmount).plus(
          requireNonnegative('financed fees', input.financedFees),
        );
  const commission =
    input.mode === 'origination'
      ? netAmountFinanced.mul(
          requireFraction('commission rate', input.commissionRate),
        )
      : undefined;
  const principal =
    commission === undefined
      ? netAmountFinanced
      : netAmountFinanced.plus(commission);
  const annualRate =
    input.mode === 'contract-terms'
      ? requireRate('annual rate', input.annualRate)
      : requireRate('base rate', input.baseRate).plus(
          requireFraction('commission rate', input.commissionRate).mul(
            input.rateMarkupFactor === undefined
              ? new Decimal('0.4')
              : requireFraction('rate markup factor', input.rateMarkupFactor),
          ),
        );
  const effectiveAnnualRate = AnnualRate.from(annualRate);
  const balloon = optionalNonnegative('balloon', input.balloon);
  const { periods, dailyRate, payment } = createDailyRepaymentPlan(
    input,
    principal,
    annualRate,
    balloon,
  );
  const firstPeriod = periods[0];
  if (!firstPeriod) throw new RangeError('A repayment period is required');
  const days = firstPeriod.days;
  const firstInterest = principal.mul(dailyRate).mul(days);
  const charged = chargedPayment(payment, input);
  const monthlyFee = optionalNonnegative('monthly fee', input.monthlyFee);
  optionalNonnegative('sliding fee', input.slidingFee);
  const hiring = isDollarUp(input)
    ? hiringFromInstalments(
        input,
        sumInstalments(
          amortizeDaily({
            periods,
            dailyRate,
            startingBalance: principal,
            payment: charged.decimal(),
            balloon,
            settleFinalInstalment: true,
          }),
        ),
      )
    : totalHiring(input, charged);
  const commonResult = {
    model: 'autopay',
    monthlyPayment: charged,
    totalHiring: hiring,
    grossMonthlyPayment: Money.from(charged.decimal().plus(monthlyFee)),
    netAmountFinanced: Money.from(netAmountFinanced),
    amountFinanced: Money.from(principal),
    effectiveAnnualRate,
    firstPaymentInterest: Money.from(firstInterest).roundCents(),
    firstPaymentDays: days,
  } as const;
  if (input.mode === 'origination') {
    if (commission === undefined)
      throw new Error('Origination commission was not calculated');
    return {
      ...commonResult,
      mode: 'origination',
      commission: Money.from(commission).roundCents(),
    };
  }
  return { ...commonResult, mode: 'contract-terms' };
}

/**
 * Calculates one lender quote. The input's `model` picks the commission model:
 * `capitalised` (Traditional/Westpac/Metro/Firstmac), `branded` (commission overs),
 * `pepper` (loaded commission) or `autopay` (daily interest with a rate adjustment).
 *
 * Pure and deterministic: inputs are validated domain objects (Money, AnnualRate,
 * Fraction), all arithmetic uses 40-digit decimals, and only the final payment,
 * commission and totals are rounded to the cent. Invalid inputs throw a RangeError.
 */
export function calculateQuote(input: CapitalisedInput): CapitalisedResult;
export function calculateQuote(input: BrandedInput): BrandedResult;
export function calculateQuote(input: PepperInput): PepperResult;
export function calculateQuote(
  input: AutopayOriginationInput,
): AutopayOriginationResult;
export function calculateQuote(input: AutopayInput): AutopayResult;
export function calculateQuote(input: QuoteInput): QuoteResult;
export function calculateQuote(input: QuoteInput): QuoteResult {
  validateCommon(input);
  switch (input.model) {
    case 'capitalised':
      return calculateCapitalised(input);
    case 'branded':
      return calculateBranded(input);
    case 'pepper':
      return calculatePepper(input);
    case 'autopay':
      return calculateAutopay(input);
  }
}
