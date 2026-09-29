import { Decimal as DecimalLibrary } from 'decimal.js';

/** Owned precision policy prevents other packages from changing finance arithmetic. */
export const Decimal = DecimalLibrary.clone({
  precision: 40,
  rounding: DecimalLibrary.ROUND_HALF_UP,
});
export type Decimal = DecimalLibrary;
