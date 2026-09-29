import { readFileSync } from 'node:fs';
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  AnnualRate,
  Fraction,
  Money,
  calculateQuote,
  generateSchedule,
  type QuoteInput,
  type QuoteResult,
} from '../src/index.js';

interface FixtureCase {
  readonly id: string;
  readonly lender: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly expected: Readonly<Record<string, unknown>>;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Expected object');
  return value as Readonly<Record<string, unknown>>;
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Expected string');
  return value;
}

function decimal(
  source: Readonly<Record<string, unknown>>,
  key: string,
  fallback?: string,
): string {
  const value = source[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TypeError(`Expected finite ${key}`);
  return value.toString();
}

function boolean(
  source: Readonly<Record<string, unknown>>,
  key: string,
  fallback: boolean,
): boolean {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean')
    throw new TypeError(`Expected boolean ${key}`);
  return value;
}

function termMonths(source: Readonly<Record<string, unknown>>): number {
  const value = source.term_months;
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new TypeError('Expected integer term_months');
  return value;
}

function money(
  source: Readonly<Record<string, unknown>>,
  key: string,
  fallback?: string,
): Money {
  return Money.from(decimal(source, key, fallback));
}

function optionalBalloon(source: Readonly<Record<string, unknown>>): Money {
  return money(source, 'balloon_dollars', '0');
}

function fee(
  source: Readonly<Record<string, unknown>>,
  key: string,
  financedKey: string,
  defaultFinanced: boolean,
): Decimal {
  return boolean(source, financedKey, defaultFinanced)
    ? new Decimal(decimal(source, key, '0'))
    : new Decimal(0);
}

function inputFromFixture(fixture: FixtureCase): QuoteInput {
  const source = fixture.inputs;
  switch (fixture.lender) {
    case 'westpac':
      return {
        model: 'capitalised',
        financeAmount: money(source, 'finance_amount'),
        financedFees: Money.from(
          fee(source, 'establishment_fee', 'fee_financed', true),
        ),
        baseRate: AnnualRate.from(decimal(source, 'base_rate_annual')),
        commissionRate: Fraction.from(decimal(source, 'commission_percent')),
        termMonths: termMonths(source),
        balloon: optionalBalloon(source),
        timing: text(source.payment_mode) === 'advance' ? 'advance' : 'arrears',
      };
    case 'branded':
      return {
        model: 'branded',
        financeAmount: money(source, 'finance_amount'),
        financedFees: Money.from(
          new Decimal(decimal(source, 'establishment_fee')).plus(
            decimal(source, 'ppsr_fee'),
          ),
        ),
        baseRate: AnnualRate.from(decimal(source, 'base_rate_annual')),
        contractRate: AnnualRate.from(decimal(source, 'contract_rate_annual')),
        termMonths: termMonths(source),
        monthlyFee: money(source, 'monthly_fee'),
        timing: 'arrears',
      };
    case 'pepper': {
      const origination = fee(
        source,
        'origination_fee',
        'origination_financed',
        true,
      );
      const establishment = fee(
        source,
        'establishment_fee',
        'establishment_financed',
        false,
      );
      const ppsrRegistration = fee(
        source,
        'ppsr_reg_fee',
        'ppsr_reg_financed',
        false,
      );
      const ppsrSearch = fee(
        source,
        'ppsr_search_fee',
        'ppsr_search_financed',
        false,
      );
      const financed = origination
        .plus(establishment)
        .plus(ppsrRegistration)
        .plus(ppsrSearch);
      // Unspecified PPSR fees take their amounts from lender-configs.json: $6 registration, $2 search.
      const upfront = new Decimal(decimal(source, 'establishment_fee', '499'))
        .minus(establishment)
        .plus(
          new Decimal(decimal(source, 'ppsr_reg_fee', '6')).minus(
            ppsrRegistration,
          ),
        )
        .plus(
          new Decimal(decimal(source, 'ppsr_search_fee', '2')).minus(
            ppsrSearch,
          ),
        );
      return {
        model: 'pepper',
        financeAmount: money(source, 'finance_amount'),
        financedFees: Money.from(financed),
        upfrontFees: Money.from(upfront),
        financierRate: AnnualRate.from(
          decimal(source, 'financier_rate_annual'),
        ),
        commissionRate: Fraction.from(decimal(source, 'commission_percent')),
        termMonths: termMonths(source),
        balloon: optionalBalloon(source),
        timing: text(source.payment_mode) === 'advance' ? 'advance' : 'arrears',
      };
    }
    case 'autopay':
      return {
        model: 'autopay',
        mode: 'contract-terms',
        startingPrincipal: money(source, 'starting_principal'),
        annualRate: AnnualRate.from(decimal(source, 'annual_rate')),
        termMonths: termMonths(source),
        settlementDate: text(source.settlement_date),
        firstRepaymentDate: text(source.first_repayment_date),
        monthlyFee: money(source, 'monthly_fee', '0'),
        slidingFee: money(source, 'sliding_fee', '0'),
        adjustBusinessDays: boolean(source, 'skip_weekends_holidays', true),
      };
    default:
      throw new RangeError(`Unknown lender ${fixture.lender}`);
  }
}

function actualFields(
  input: QuoteInput,
  quote: QuoteResult,
): Readonly<Record<string, string | number>> {
  const common: Record<string, string | number> = {
    NAF: quote.netAmountFinanced.toFixed(),
    amount_financed: quote.amountFinanced.toFixed(),
    total_financed: quote.amountFinanced.toFixed(),
    monthly_payment: quote.monthlyPayment.toFixed(),
    gross_payment: quote.grossMonthlyPayment.toFixed(),
  };
  switch (quote.model) {
    case 'capitalised':
      return {
        ...common,
        commission: quote.commission.toFixed(),
        comparison_rate: quote.effectiveAnnualRate?.toString() ?? '',
        total_interest: quote.totalInterest.toFixed(),
      };
    case 'branded':
      return {
        ...common,
        total_commission: quote.commission.toFixed(),
        net_payment: quote.monthlyPayment.toFixed(),
        base_net_payment: quote.baseNetPayment.toFixed(),
        final_net_payment: quote.monthlyPayment.toFixed(),
        base_total_hiring: quote.baseTotalHiring.toFixed(),
        final_total_hiring: quote.finalTotalHiring.toFixed(),
        total_hiring: quote.finalTotalHiring.toFixed(),
        hiring_difference: quote.hiringDifference.toFixed(),
        overs_commission: quote.oversWithGst.toFixed(),
        overs_75_percent: quote.oversBeforeGst.toFixed(),
        overs_with_gst: quote.oversWithGst.toFixed(),
      };
    case 'pepper':
      return {
        ...common,
        commission: quote.commission.toFixed(),
        loading_factor: quote.loading.toString(),
        customer_rate: quote.effectiveAnnualRate?.toString() ?? '',
        upfront_fees: quote.upfrontFees.toFixed(),
      };
    case 'autopay': {
      const rows = generateSchedule(input);
      return {
        ...common,
        first_payment_interest: quote.firstPaymentInterest.toFixed(),
        first_payment_days: quote.firstPaymentDays,
        second_payment_date: rows[1]?.dueDate ?? '',
        second_payment_days: rows[1]?.days ?? -1,
        second_payment_interest: rows[1]?.interest.toFixed() ?? '',
      };
    }
  }
}

const fixtureFile: unknown = JSON.parse(
  readFileSync(
    new URL(
      '../../../tests/fixtures/upstream/test-cases.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const casesValue = record(fixtureFile).test_cases;
if (!Array.isArray(casesValue))
  throw new TypeError('Expected test_cases array');
const cases: readonly FixtureCase[] = casesValue.map((value: unknown) => {
  const parsed = record(value);
  return {
    id: text(parsed.id),
    lender: text(parsed.lender),
    inputs: record(parsed.inputs),
    expected: record(parsed.expected),
  };
});

describe('immutable official central JSON fixtures', () => {
  it('contains all eight supplied cases', () => {
    expect(cases).toHaveLength(8);
  });

  it.each(cases)('$id', (fixture) => {
    const input = inputFromFixture(fixture);
    const actual = actualFields(input, calculateQuote(input));
    const differences: string[] = [];
    for (const [field, expectedValue] of Object.entries(fixture.expected)) {
      const actualValue = actual[field];
      if (actualValue === undefined) {
        differences.push(`${field}: no calculated field`);
      } else if (typeof expectedValue === 'string') {
        if (actualValue !== expectedValue)
          differences.push(
            `${field}: expected ${expectedValue}, got ${actualValue}`,
          );
      } else if (typeof expectedValue === 'number') {
        const tolerance =
          field.includes('rate') || field === 'loading_factor'
            ? new Decimal('0.001')
            : field.includes('days')
              ? new Decimal(0)
              : new Decimal('0.01');
        if (
          new Decimal(actualValue)
            .minus(expectedValue)
            .abs()
            .greaterThan(tolerance)
        ) {
          differences.push(
            `${field}: expected ${expectedValue}, got ${actualValue} (tol ${tolerance})`,
          );
        }
      } else {
        differences.push(`${field}: unexpected fixture type`);
      }
    }
    expect(differences).toEqual([]);
  });
});
