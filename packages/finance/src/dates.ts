// Snapshot of the reference calculator's NSW dates. Its supported policy covers 2025–2030 only.
const NSW_REFERENCE_HOLIDAYS = new Set([
  '2025-01-01',
  '2025-01-27',
  '2025-04-18',
  '2025-04-19',
  '2025-04-21',
  '2025-04-25',
  '2025-06-09',
  '2025-08-04',
  '2025-10-06',
  '2025-12-25',
  '2025-12-26',
  '2026-01-01',
  '2026-01-26',
  '2026-04-03',
  '2026-04-04',
  '2026-04-06',
  '2026-04-25',
  '2026-06-08',
  '2026-08-03',
  '2026-10-05',
  '2026-12-25',
  '2026-12-28',
  '2027-01-01',
  '2027-01-26',
  '2027-03-26',
  '2027-03-27',
  '2027-03-29',
  '2027-04-26',
  '2027-06-14',
  '2027-08-02',
  '2027-10-04',
  '2027-12-27',
  '2027-12-28',
  '2028-01-03',
  '2028-01-26',
  '2028-04-14',
  '2028-04-15',
  '2028-04-17',
  '2028-04-25',
  '2028-06-12',
  '2028-08-07',
  '2028-10-02',
  '2028-12-25',
  '2028-12-26',
  '2029-01-01',
  '2029-01-26',
  '2029-03-30',
  '2029-03-31',
  '2029-04-02',
  '2029-04-25',
  '2029-06-11',
  '2029-08-06',
  '2029-10-01',
  '2029-12-25',
  '2029-12-26',
  '2030-01-01',
  '2030-01-28',
  '2030-04-19',
  '2030-04-20',
  '2030-04-22',
  '2030-04-25',
  '2030-06-10',
  '2030-08-05',
  '2030-10-07',
  '2030-12-25',
  '2030-12-26',
]);

// The published reference stops at 2030. Standard statewide/financial-institution
// rules project 2031-2032 to cover the supplied 84-month schedule; ad-hoc holidays
// require a future calendar-policy revision.
function projectedHolidays(year: number): readonly string[] {
  const holidays: Date[] = [];
  const add = (month: number, day: number): Date => {
    const date = new Date(Date.UTC(year, month - 1, day));
    holidays.push(date);
    return date;
  };
  const followingMonday = (date: Date): void => {
    const weekday = date.getUTCDay();
    if (weekday === 6 || weekday === 0) {
      holidays.push(
        new Date(date.getTime() + (weekday === 6 ? 2 : 1) * 86_400_000),
      );
    }
  };
  const nthMonday = (month: number, nth: number): void => {
    const first = new Date(Date.UTC(year, month - 1, 1));
    add(month, 1 + ((8 - first.getUTCDay()) % 7) + (nth - 1) * 7);
  };
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const easterOrdinal = h + l - 7 * m + 114;
  const easter = new Date(
    Date.UTC(
      year,
      Math.floor(easterOrdinal / 31) - 1,
      (easterOrdinal % 31) + 1,
    ),
  );
  for (const offset of [-2, -1, 1])
    holidays.push(new Date(easter.getTime() + offset * 86_400_000));
  followingMonday(add(1, 1));
  followingMonday(add(1, 26));
  followingMonday(add(4, 25));
  nthMonday(6, 2); // King's Birthday
  nthMonday(8, 1); // Financial institution bank holiday
  nthMonday(10, 1); // Labour Day
  const christmas = add(12, 25);
  const boxing = add(12, 26);
  if (christmas.getUTCDay() === 6 || christmas.getUTCDay() === 0) {
    add(12, 27);
  }
  if (boxing.getUTCDay() === 6 || boxing.getUTCDay() === 0) {
    add(12, christmas.getUTCDay() === 6 ? 28 : 27);
  }
  return holidays.map(isoDate);
}

const NSW_PROJECTED_HOLIDAYS = new Set([
  ...projectedHolidays(2031),
  ...projectedHolidays(2032),
]);

/** Parses a `YYYY-MM-DD` calendar date as UTC midnight; rejects impossible dates such as 2026-02-30. */
export function parseDate(isoDate: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate))
    throw new RangeError('Date must be ISO YYYY-MM-DD');
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== isoDate
  ) {
    throw new RangeError('Invalid calendar date');
  }
  return date;
}

/** Formats a UTC date as `YYYY-MM-DD`. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

/** The due-day anchor is retained even after an individual payment is shifted. */
export function addMonthsOnAnchor(
  date: Date,
  monthOffset: number,
  anchorDay: number,
): Date {
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + monthOffset, 1),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(anchorDay, lastDay));
  return target;
}

/**
 * Due date of a monthly-model repayment (1-based `period`). Advance: the first payment is
 * on the settlement date; arrears: one month after it. Later payments keep the settlement
 * day (clamped to shorter months) and are not moved off weekends, as in the Pepper
 * contract schedules (60 dates each, weekend dates retained). Daily-interest schedules
 * carry their own business-day-adjusted dates instead.
 */
export function monthlyDueDate(
  settlementDate: string,
  period: number,
  timing: 'advance' | 'arrears',
): string {
  if (!Number.isSafeInteger(period) || period < 1)
    throw new RangeError('Period must be a positive whole number');
  const settlement = parseDate(settlementDate);
  return isoDate(
    addMonthsOnAnchor(
      settlement,
      timing === 'advance' ? period - 1 : period,
      settlement.getUTCDate(),
    ),
  );
}

/**
 * Moves a due date forward past weekends and NSW public holidays (the Autopay/MoneyMe
 * lender is in Sydney). With `adjust` false the date is returned unchanged. Holidays are
 * known for 2025–2032; dates outside that range throw rather than guess.
 */
export function nextBusinessDay(date: Date, adjust: boolean): Date {
  const due = new Date(date.getTime());
  if (!adjust) return due;
  if (due.getUTCFullYear() < 2025 || due.getUTCFullYear() > 2032) {
    throw new RangeError('NSW holiday policy supports 2025–2032');
  }
  while (
    due.getUTCDay() === 0 ||
    due.getUTCDay() === 6 ||
    NSW_REFERENCE_HOLIDAYS.has(isoDate(due)) ||
    NSW_PROJECTED_HOLIDAYS.has(isoDate(due))
  ) {
    due.setUTCDate(due.getUTCDate() + 1);
    if (due.getUTCFullYear() > 2032) {
      throw new RangeError('NSW holiday policy ends in 2032');
    }
  }
  return due;
}
