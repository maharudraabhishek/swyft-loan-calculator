import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  AnnualRate,
  Fraction,
  Money,
  calculateQuote,
  generateSchedule,
} from '../src/index.js';

/**
 * Evidence for the five official `test-cases.json` cases the engine does not match
 * (`upstream-fixtures.test.ts` stays red for them; no fixture is edited). Each test runs
 * SPG's own, unmodified reference calculator or lender schedule and shows that SPG's
 * sources disagree with the expected value, while the engine agrees with SPG's calculator.
 */

const upstream = (file: string): string =>
  readFileSync(
    new URL(`../../../tests/fixtures/upstream/${file}`, import.meta.url),
    'utf8',
  );

interface Field {
  value: string;
  checked: boolean;
  textContent: string;
  innerHTML: string;
  addEventListener(): void;
  appendChild(): void;
}

/** Runs a pinned SPG calculator verbatim; the adapter only supplies DOM input values. */
function spgCalculator(
  file: string,
  inputs: Readonly<Record<string, string | boolean>>,
): (id: string) => string {
  const script = /<script>([\s\S]*?)<\/script>/.exec(upstream(file))?.[1];
  if (!script) throw new Error(`No calculator script in ${file}`);
  const fields = new Map<string, Field>();
  const getElementById = (id: string): Field => {
    let field = fields.get(id);
    if (!field) {
      const value = inputs[id];
      field = {
        value: typeof value === 'string' ? value : '0',
        checked: value === true,
        textContent: '',
        innerHTML: '',
        addEventListener() {},
        appendChild() {},
      };
      fields.set(id, field);
    }
    return field;
  };
  runInNewContext(
    script,
    {
      document: {
        getElementById,
        querySelectorAll: () => [],
        createElement: () => ({ innerHTML: '' }),
      },
    },
    { timeout: 2000 },
  );
  return (id) => (fields.get(id)?.textContent ?? '').replace(/[$,]/g, '');
}

const percent = (rate: AnnualRate | undefined): string =>
  `${new Decimal(rate?.toString() ?? '0').mul(100).toFixed(2)}%`;

describe('disputed official fixtures: SPG’s own calculators agree with the engine', () => {
  it('westpac-basic: SPG gives $646.10 / 10.25% / $7,051.27; the fixture’s $656.19 counts the $495 fee twice', () => {
    const spg = spgCalculator('traditional/traditional-quoting-tool.html', {
      financeAmount: '30000',
      termMonths: '60',
      baseRate: '8.5',
      commissionRate: '4',
      balloonPercent: '0',
      paymentTiming: 'advance',
      establishmentFee: '495',
      establishmentFinanced: true,
    });
    const quote = calculateQuote({
      model: 'capitalised',
      financeAmount: Money.from('30000'),
      financedFees: Money.from('495'),
      baseRate: AnnualRate.from('0.085'),
      commissionRate: Fraction.from('0.04'),
      termMonths: 60,
      timing: 'advance',
    });
    expect([
      spg('paymentResult'),
      spg('comparisonRateResult'),
      spg('totalInterestResult'),
    ]).toEqual(['646.10', '10.25%', '7051.27']);
    expect([
      quote.monthlyPayment.toFixed(),
      percent(quote.effectiveAnnualRate),
      quote.totalInterest.toFixed(),
    ]).toEqual(['646.10', '10.25%', '7051.27']);
    // Expected 656.19 is the advance payment on $32,209.80 = total financed + the fee again,
    // while the same fixture states total financed $31,714.80.
    const doubled = calculateQuote({
      model: 'capitalised',
      financeAmount: Money.from('30495'),
      financedFees: Money.from('495'),
      baseRate: AnnualRate.from('0.085'),
      commissionRate: Fraction.from('0'),
      termMonths: 60,
      timing: 'advance',
    });
    expect(
      new Decimal(doubled.amountFinanced.toString()).plus('1219.80').toFixed(2),
    ).toBe('32209.80');
    const onDoubled = calculateQuote({
      model: 'capitalised',
      financeAmount: Money.from('32209.80'),
      financedFees: Money.from('0'),
      baseRate: AnnualRate.from('0.085'),
      commissionRate: Fraction.from('0'),
      termMonths: 60,
      timing: 'advance',
    });
    expect(onDoubled.monthlyPayment.toFixed()).toBe('656.19');
  });

  it('westpac-with-balloon: SPG gives $914.16 / 9.63% for the fixture inputs (fixture: $844.22 / 8.78%)', () => {
    const spg = spgCalculator('traditional/traditional-quoting-tool.html', {
      financeAmount: '45000',
      termMonths: '48',
      baseRate: '7.95',
      commissionRate: '4',
      balloonPercent: '30',
      paymentTiming: 'arrears',
      establishmentFee: '495',
      establishmentFinanced: true,
    });
    const quote = calculateQuote({
      model: 'capitalised',
      financeAmount: Money.from('45000'),
      financedFees: Money.from('495'),
      baseRate: AnnualRate.from('0.0795'),
      commissionRate: Fraction.from('0.04'),
      termMonths: 48,
      balloon: Money.from('13500'),
      timing: 'arrears',
    });
    expect([
      spg('paymentResult'),
      spg('comparisonRateResult'),
      spg('balloonResult'),
    ]).toEqual(['914.16', '9.63%', '13500.00']);
    expect([
      quote.monthlyPayment.toFixed(),
      percent(quote.effectiveAnnualRate),
    ]).toEqual(['914.16', '9.63%']);
  });

  it('pepper cases: SPG gives amount financed $35,846.08 and $36,362.53 (fixture: $35,845.85, $36,352.85)', () => {
    const cases = [
      {
        fees: '790',
        commission: '703.80',
        spgFees: { originationFee: '790', originationFinanced: true },
        expected: ['35846.08', '794.50'],
      },
      {
        fees: '1297',
        commission: '713.94',
        spgFees: {
          originationFee: '790',
          originationFinanced: true,
          establishmentFee: '499',
          establishmentFinanced: true,
          ppsrReg: '6',
          ppsrRegFinanced: true,
          ppsrSearch: '2',
          ppsrSearchFinanced: true,
        },
        expected: ['36362.53', '805.95'],
      },
    ];
    for (const item of cases) {
      const spg = spgCalculator('pepper/pepper-calculator.html', {
        financeAmount: '34400',
        termMonths: '60',
        financierRate: '12.29',
        commissionDollar: item.commission,
        balloonPercent: '0',
        paymentTiming: 'advance',
        ...item.spgFees,
      });
      const quote = calculateQuote({
        model: 'pepper',
        financeAmount: Money.from('34400'),
        financedFees: Money.from(item.fees),
        financierRate: AnnualRate.from('0.1229'),
        commissionRate: Fraction.from('0.02'),
        termMonths: 60,
        timing: 'advance',
      });
      expect([spg('amountFinancedResult'), spg('paymentResult')]).toEqual(
        item.expected,
      );
      expect([
        quote.amountFinanced.toFixed(),
        quote.monthlyPayment.toFixed(),
      ]).toEqual(item.expected);
    }
  });

  it('autopay-daily-interest: SPG’s calculator gives first interest $147.11 (fixture: $147.01)', () => {
    const spg = spgCalculator(
      'autopay/autopay-daily-interest-calculator.html',
      {
        financeAmount: '85704.86',
        termMonths: '60',
        annualRate: '8.95',
        settlementDate: '2025-05-31',
        firstRepaymentDate: '2025-06-06',
        adjustForHolidays: true,
      },
    );
    const input = {
      model: 'autopay' as const,
      mode: 'contract-terms' as const,
      startingPrincipal: Money.from('85704.86'),
      annualRate: AnnualRate.from('0.0895'),
      termMonths: 60,
      settlementDate: '2025-05-31',
      firstRepaymentDate: '2025-06-06',
      adjustBusinessDays: true,
    };
    expect(spg('firstInterestResult')).toBe('147.11');
    expect(calculateQuote(input).firstPaymentInterest.toFixed()).toBe('147.11');
    expect(generateSchedule(input)[1]?.dueDate).toBe('2025-07-07');
  });
});

describe('SPG lender schedules explain the remaining differences', () => {
  const rows = (file: string) =>
    upstream(file)
      .split(/\r?\n/)
      .filter((line) => /^\d+,/.test(line))
      .map((line) => line.split(','));

  it('Autopay 60-month schedule: payment 1 failed, so row 2 (the fixture’s $495.29) is not derivable from the loan inputs', () => {
    const schedule = rows('autopay/test-case-2-60month.csv');
    expect(schedule[0]?.[9]).toBe('Failed');
    expect(schedule[0]?.[8]).toBe('84084.45'); // closing balance after payment 1
    expect(schedule[1]?.[2]).toBe('84219.20'); // opening balance of payment 2 differs
    expect(schedule[1]?.[3]).toBe('495.29');
  });

  it('the two Autopay schedules use different day counts although every SPG source says ÷365', () => {
    const matches = (
      file: string,
      rate: string,
      settlement: string,
      divisor: number,
    ) => {
      let previous = settlement;
      let count = 0;
      const data = rows(file);
      data.slice(0, -1).forEach((row, index) => {
        const [day, month, year] = (row[1] ?? '').split('/');
        const date = `${year}-${month}-${day}`;
        const days =
          Math.round((Date.parse(date) - Date.parse(previous)) / 86_400_000) +
          (index === 0 ? 1 : 0);
        previous = date;
        const interest = new Decimal(row[2] ?? '0')
          .mul(rate)
          .mul(days)
          .div(divisor)
          .toFixed(2, Decimal.ROUND_HALF_UP);
        if (interest === row[3]) count += 1;
      });
      return count;
    };
    // 84-month: 82 of 83 rows match actual/365 (row 1's settlement date is marked "approx").
    expect(
      matches('autopay/test-case-1-84month.csv', '0.1215', '2025-08-14', 365),
    ).toBe(82);
    expect(
      matches(
        'autopay/test-case-1-84month.csv',
        '0.1215',
        '2025-08-14',
        365.25,
      ),
    ).toBe(0);
    // 60-month: 58 of 59 rows match /365.25 (row 2 follows the failed payment); none match /365.
    expect(
      matches(
        'autopay/test-case-2-60month.csv',
        '0.0895',
        '2025-05-31',
        365.25,
      ),
    ).toBe(58);
    expect(
      matches('autopay/test-case-2-60month.csv', '0.0895', '2025-05-31', 365),
    ).toBe(0);
  });

  it('Traditional schedules: the stated payments do not repay their own loans at the stated rate', () => {
    const schedule = rows('traditional/traditional-test-cases.csv');
    const closing = schedule
      .filter((row) => row[0] === '60' || row[0] === '84')
      .map((row) => row[5]);
    // Case 1 (no balloon) leaves $538.15, case 2 leaves $22,912.86 against a $22,500 balloon,
    // case 3 (84 months, no balloon) leaves $616.63.
    expect(closing).toEqual(['538.15', '22912.86', '26461.64', '616.63']);
    // Interest in those rows is exactly 6.75% / 12 on the opening balance.
    expect(new Decimal('77631.95').mul('0.0675').div(12).toFixed(2)).toBe(
      '436.68',
    );
  });

  it('Pepper schedules: no constant-rate amortisation reproduces the CSV interest, although the brief says to use the comparison rate', () => {
    const csv = rows('pepper/test-case-1-w-e.csv'); // Pmt, Date, Principal, Interest, Payment
    const payment = new Decimal(csv[0]?.[4] ?? '0');
    // Principal sums to NAF, so the CSV starts from NAF $35,190 with the first payment at settlement.
    const principal = csv.reduce(
      (sum, row) => sum.plus(row[2] ?? '0'),
      new Decimal(0),
    );
    expect(principal.toFixed(2)).toBe('35189.73');
    // The brief's instruction (stated comparison rate 13.19% on the balance) gives row 2 = $378.05;
    // the CSV shows $371.56.
    expect(
      new Decimal('35190').minus(payment).mul('0.1319').div(12).toFixed(2),
    ).toBe('378.05');
    expect(csv[1]?.[3]).toBe('371.56');
    // Best constant annual rate from 5% to 15% (0.05% steps) matches at most 2 of 60 rows.
    let best = 0;
    for (let step = 0; step <= 200; step++) {
      const monthly = new Decimal('0.05')
        .plus(new Decimal(step).div(2000))
        .div(12);
      let balance = new Decimal('35190');
      let exact = 0;
      csv.forEach((row, index) => {
        const interest =
          index === 0
            ? new Decimal(0)
            : balance.mul(monthly).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        if (interest.toFixed(2) === row[3]) exact += 1;
        balance = balance.minus(payment.minus(interest));
      });
      best = Math.max(best, exact);
    }
    expect(best).toBeLessThanOrEqual(2);
  });
});
