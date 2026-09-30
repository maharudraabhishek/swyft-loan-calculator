import { Decimal as DecimalLibrary } from 'decimal.js';

/** Owned precision policy prevents other packages from changing finance arithmetic. */
export const Decimal = DecimalLibrary.clone({
  precision: 40,
  rounding: DecimalLibrary.ROUND_HALF_UP,
});
/** Type of values produced by the package-owned {@link Decimal} constructor. */
export type Decimal = DecimalLibrary;
