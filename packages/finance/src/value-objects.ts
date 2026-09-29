import { Decimal } from './decimal.js';
import { QuoteValidationError } from './errors.js';

function parseDecimal(value: string | Decimal, unit: string): Decimal {
  try {
    const decimal = new Decimal(value);
    if (decimal.isFinite()) return decimal;
  } catch {
    // Decimal.js may reject malformed numeric strings before isFinite can run.
  }
  throw new QuoteValidationError(`${unit} must be a finite decimal`);
}

/** Decimal dollar amount; arithmetic is exact to the configured Decimal precision. */
export class Money {
  private constructor(private readonly value: Decimal) {}

  static from(value: string | Decimal): Money {
    return new Money(parseDecimal(value, 'Money'));
  }

  static zero(): Money {
    return Money.from('0');
  }

  decimal(): Decimal {
    return this.value;
  }

  /** Round only at a lender-specified boundary or when presenting a payment. */
  roundCents(): Money {
    return Money.from(this.value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
  }

  toFixed(decimalPlaces = 2): string {
    return this.value.toFixed(decimalPlaces, Decimal.ROUND_HALF_UP);
  }

  toString(): string {
    return this.value.toString();
  }
}

/** Annual simple interest fraction, so 0.085 means 8.5% per year. */
export class AnnualRate {
  private constructor(private readonly value: Decimal) {}

  static from(value: string | Decimal): AnnualRate {
    const decimal = parseDecimal(value, 'Annual rate');
    if (decimal.isNegative() || decimal.greaterThan(1)) {
      throw new QuoteValidationError(
        'Annual rate must be a fraction from 0 to 1',
      );
    }
    return new AnnualRate(decimal);
  }

  decimal(): Decimal {
    return this.value;
  }

  toString(): string {
    return this.value.toString();
  }
}

/** Dimensionless proportion from 0 to 1, e.g. 0.04 means a 4% commission. */
export class Fraction {
  private constructor(private readonly value: Decimal) {}

  static from(value: string | Decimal): Fraction {
    const decimal = parseDecimal(value, 'Fraction');
    if (decimal.isNegative() || decimal.greaterThan(1)) {
      throw new QuoteValidationError('Fraction must be a value from 0 to 1');
    }
    return new Fraction(decimal);
  }

  decimal(): Decimal {
    return this.value;
  }

  toString(): string {
    return this.value.toString();
  }
}
