import { readFileSync } from 'node:fs';
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { AnnualRate, Fraction, Money, generateSchedule } from '../src/index.js';

const reference = readFileSync(
  new URL(
    '../../../tests/fixtures/upstream/autopay/test-case-1-84month.csv',
    import.meta.url,
  ),
  'utf8',
);

const failedPaymentReference = readFileSync(
  new URL(
    '../../../tests/fixtures/upstream/autopay/test-case-2-60month.csv',
    import.meta.url,
  ),
  'utf8',
);

const pepperReferences = [
  'test-case-1-w-e.csv',
  'test-case-2-h-y-c-pty-ltd.csv',
  'test-case-3-g-i-i-pty-ltd.csv',
] as const;

function capture(csv: string, pattern: RegExp): string {
  const value = pattern.exec(csv)?.[1];
  if (!value) throw new Error(`Missing reference field: ${pattern.source}`);
  return value.replaceAll(',', '');
}

function firstScheduleRow(csv: string): readonly string[] {
  const row = /^1,([^\r\n]+)/m.exec(csv)?.[1];
  if (!row) throw new Error('Missing first reference schedule row');
  return ['1', ...row.split(',')];
}

function percentFraction(percent: string): Decimal {
  return new Decimal(percent).div(100);
}

function autopayExpectedRows(
  csv: string,
  termMonths: number,
): readonly string[][] {
  const lines = csv.split(/\r?\n/);
  const header = lines.findIndex((line) =>
    line.startsWith('Seq No,Date,Opening Balance,'),
  );
  if (header < 0) throw new Error('Autopay schedule header is absent');
  const rows = lines
    .slice(header + 1)
    .filter((line) => /^\d+,/.test(line))
    .map((line) => line.split(','));
  if (rows.length !== termMonths || rows.some((row) => row.length !== 10)) {
    throw new Error(`Expected ${termMonths} Autopay reference rows`);
  }
  return rows;
}

describe('official reference schedule where inputs are sufficient', () => {
  it.each(pepperReferences)('checks advance timing in Pepper %s', (file) => {
    const csv = readFileSync(
      new URL(
        `../../../tests/fixtures/upstream/pepper/${file}`,
        import.meta.url,
      ),
      'utf8',
    );
    const naf = capture(
      csv,
      /# NAF \(Net Amount Financed\): \$([\d,]+\.\d{2})/,
    );
    const financeAmount = capture(csv, /# Finance Amount: \$([\d,]+\.\d{2})/);
    const commission = capture(
      csv,
      /# Commission: [\d.]+% = \$([\d,]+\.\d{2})/,
    );
    const rate = capture(csv, /# Base Rate: ([\d.]+)% p\.a\./);
    const first = firstScheduleRow(csv);
    const financedFees = new Decimal(naf).minus(financeAmount);
    const schedule = generateSchedule({
      model: 'pepper',
      financeAmount: Money.from(financeAmount),
      financedFees: Money.from(financedFees),
      financierRate: AnnualRate.from(percentFraction(rate)),
      commissionRate: Fraction.from(new Decimal(commission).div(naf)),
      termMonths: 60,
      timing: 'advance',
    });

    // All three CSVs put the first instalment at settlement, before interest accrues.
    expect(schedule[0]?.openingBalance.toFixed()).toBe(naf);
    expect(first[3]).toBe('0.00');
    expect(schedule[0]?.interest.toFixed()).toBe(first[3]);
    expect(schedule[0]?.principal.toFixed()).toBe(
      schedule[0]?.payment.toFixed(),
    );
    const csvRows = csv.split(/\r?\n/).filter((line) => /^\d+,/.test(line));
    expect(csvRows).toHaveLength(60);
    for (const line of csvRows) {
      const row = line.split(',');
      expect(new Decimal(row[2] ?? '0').plus(row[3] ?? '0').toFixed(2)).toBe(
        row[4],
      );
    }
  });

  it('matches Traditional first-period interest using each CSV opening balance', () => {
    const csv = readFileSync(
      new URL(
        '../../../tests/fixtures/upstream/traditional/traditional-test-cases.csv',
        import.meta.url,
      ),
      'utf8',
    );
    const cases = csv.split(/^# TEST CASE \d+:/m).slice(1);
    expect(cases).toHaveLength(3);
    for (const referenceCase of cases) {
      if (!referenceCase) throw new Error('Missing Traditional reference case');
      const naf = capture(
        referenceCase,
        /# NAF \(Net Amount Financed\): \$([\d,]+\.\d{2})/,
      );
      const financeAmount = capture(
        referenceCase,
        /# Finance Amount: \$([\d,]+\.\d{2})/,
      );
      const commission = capture(
        referenceCase,
        /# Commission: [\d.]+% = \$([\d,]+\.\d{2})/,
      );
      const rate = capture(referenceCase, /# Base Rate: ([\d.]+)% p\.a\./);
      const term = Number(capture(referenceCase, /# Term: (\d+) months/));
      const balloon =
        referenceCase
          .match(/# Balloon: \$([\d,]+\.\d{2})/)?.[1]
          ?.replaceAll(',', '') ?? '0';
      const first = firstScheduleRow(referenceCase);
      // The CSV commission dollars, not its inconsistent printed percentage,
      // determine its opening balance. Compare only accrual before PMT diverges.
      const schedule = generateSchedule({
        model: 'capitalised',
        financeAmount: Money.from(financeAmount),
        financedFees: Money.from(new Decimal(naf).minus(financeAmount)),
        baseRate: AnnualRate.from(percentFraction(rate)),
        commissionRate: Fraction.from(new Decimal(commission).div(naf)),
        termMonths: term,
        balloon: Money.from(balloon),
        timing: 'arrears',
      });
      expect(schedule[0]?.openingBalance.toFixed()).toBe(first[1]);
      expect(schedule[0]?.interest.toFixed()).toBe(first[2]);
      const rows = referenceCase
        .split(/\r?\n/)
        .filter((line) => /^\d+,/.test(line));
      expect(rows).toHaveLength(term);
      let previousClosing: string | undefined;
      for (const line of rows) {
        const row = line.split(',');
        const opening = new Decimal(row[1] ?? '0');
        const interest = new Decimal(row[2] ?? '0');
        const principal = new Decimal(row[3] ?? '0');
        const payment = new Decimal(row[4] ?? '0');
        const closing = new Decimal(row[5] ?? '0');
        // Four supplied rows differ by one cent from their stated monthly-rate accrual.
        expect(
          opening
            .mul(percentFraction(rate))
            .div(12)
            .toDecimalPlaces(2)
            .minus(interest)
            .abs()
            .lessThanOrEqualTo('0.01'),
        ).toBe(true);
        expect(interest.plus(principal).toFixed(2)).toBe(payment.toFixed(2));
        expect(opening.minus(principal).toFixed(2)).toBe(closing.toFixed(2));
        if (previousClosing) expect(opening.toFixed(2)).toBe(previousClosing);
        previousClosing = closing.toFixed(2);
      }
    }
  });

  it('matches all 84 Autopay rows within the official cent tolerance using the interest-implied settlement date', () => {
    const actual = generateSchedule({
      model: 'autopay',
      mode: 'contract-terms',
      startingPrincipal: Money.from('60219.70'),
      annualRate: AnnualRate.from('0.1215'),
      // CSV marks 14 August as approximate; its $180.41 first interest implies nine inclusive days.
      termMonths: 84,
      settlementDate: '2025-08-13',
      firstRepaymentDate: '2025-08-21',
      monthlyFee: Money.from('12.50'),
      slidingFee: Money.from('12.50'),
      adjustBusinessDays: true,
    });
    expect(actual).toHaveLength(84);
    for (const [index, expected] of autopayExpectedRows(
      reference,
      84,
    ).entries()) {
      const row = actual[index];
      if (!row || !expected) throw new Error('Missing comparison row');
      const [day, month, year] = (expected[1] ?? '').split('/');
      expect(row.dueDate).toBe(`${year}-${month}-${day}`);
      // CSV row 44 closing/row 45 opening differ by one cent; retain official tolerance.
      for (const [amount, column] of [
        [row.openingBalance, 2],
        [row.interest, 3],
        [row.principal, 4],
        [row.payment, 5],
        [row.closingBalance, 8],
      ] as const) {
        expect(
          amount
            .decimal()
            .minus(expected[column] ?? '')
            .abs()
            .lessThanOrEqualTo('0.01'),
          `period ${row.period}, column ${column}`,
        ).toBe(true);
      }
      expect(row.fee.toFixed()).toBe(
        Money.from(expected[6] ?? '0')
          .decimal()
          .plus(expected[7] ?? '0')
          .toFixed(2),
      );
      if (index === 1) expect(row.days).toBe(32);
    }
  });

  it('matches the regular payment and all 60 dates/fees without inventing failed-payment history', () => {
    const actual = generateSchedule({
      model: 'autopay',
      mode: 'contract-terms',
      startingPrincipal: Money.from('85704.86'),
      annualRate: AnnualRate.from('0.0895'),
      termMonths: 60,
      settlementDate: '2025-05-31',
      firstRepaymentDate: '2025-06-06',
      monthlyFee: Money.from('12.50'),
      slidingFee: Money.from('12.50'),
      adjustBusinessDays: true,
    });
    const expectedRows = autopayExpectedRows(failedPaymentReference, 60);
    expect(actual).toHaveLength(60);
    expect(actual[0]?.payment.toFixed()).toBe(expectedRows[0]?.[5]);
    // These modeled balances use the actual-day payment and normative 365 basis.
    expect(actual[0]?.openingBalance.toFixed()).toBe('85704.86');
    expect(actual[0]?.interest.toFixed()).toBe('147.11');
    expect(actual[0]?.closingBalance.toFixed()).toBe('84084.55');
    expect(actual[1]?.openingBalance.toFixed()).toBe('84084.55');
    // A failed first payment changes subsequent balances; the CSV omits the needed history.
    for (const [index, expected] of expectedRows.entries()) {
      const row = actual[index];
      if (!row || !expected) throw new Error('Missing comparison row');
      const [day, month, year] = (expected[1] ?? '').split('/');
      expect(row.dueDate).toBe(`${year}-${month}-${day}`);
      expect(row.fee.toFixed()).toBe(
        Money.from(expected[6] ?? '0')
          .decimal()
          .plus(expected[7] ?? '0')
          .toFixed(2),
      );
    }
  });
});
