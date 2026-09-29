import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { AnnualRate, Fraction, Money, calculateQuote } from '../src/index.js';

/**
 * Cross-checks the engine against SPG's four HTML calculators (`resources/`), run verbatim,
 * over a grid of amounts, terms, rates, balloons, timings and fee financing. Every field
 * both produce must be identical, except three documented differences:
 * - Branded commission: SPG's HTML uses unrounded instalments, while `test-cases.json`
 *   ($939.51) requires cent-rounded ones (the engine follows the test file; arrears
 *   differences stay under $1). For advance loans the engine uses the arrears basis shown
 *   by the Branded contracts.
 * - Autopay payment: SPG's HTML approximates it; the engine solves it over actual days and
 *   matches the lender schedules ($1,767.42, $1,060.74).
 */

const scripts = new Map<string, string>();

function spg(
  file: string,
  inputs: Readonly<Record<string, string | boolean>>,
): (id: string) => string {
  let script = scripts.get(file);
  if (script === undefined) {
    script = /<script>([\s\S]*?)<\/script>/.exec(
      readFileSync(
        new URL(`../../../tests/fixtures/upstream/${file}`, import.meta.url),
        'utf8',
      ),
    )?.[1];
    if (!script) throw new Error(`No calculator script in ${file}`);
    scripts.set(file, script);
  }
  const fields = new Map<
    string,
    { value: string; checked: boolean; textContent: string }
  >();
  const getElementById = (id: string) => {
    let field = fields.get(id);
    if (!field) {
      const value = inputs[id];
      field = {
        value: typeof value === 'string' ? value : '0',
        checked: value === true,
        textContent: '',
        ...{
          innerHTML: '',
          style: {},
          addEventListener() {},
          appendChild() {},
        },
      };
      fields.set(id, field);
    }
    return field;
  };
  // Only the pinned local reference scripts run here; no Node APIs are exposed to them.
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

const percent = (rate: { toString(): string } | undefined): string =>
  `${new Decimal(rate?.toString() ?? '0').mul(100).toFixed(2)}%`;

const grid = (() => {
  const cases: {
    amount: string;
    term: number;
    rate: string;
    balloonPercent: string;
    timing: 'advance' | 'arrears';
    financed: boolean;
  }[] = [];
  for (const amount of ['15000', '52345.67', '143000'])
    for (const term of [12, 60, 84])
      for (const rate of ['4.99', '12.34'])
        for (const balloonPercent of ['0', '20'])
          for (const timing of ['advance', 'arrears'] as const)
            for (const financed of [true, false])
              cases.push({
                amount,
                term,
                rate,
                balloonPercent,
                timing,
                financed,
              });
  return cases;
})();

const label = (c: (typeof grid)[number]) =>
  `${c.amount} ${c.term}m ${c.rate}% balloon ${c.balloonPercent}% ${c.timing} fees ${c.financed ? 'financed' : 'upfront'}`;

describe('engine vs SPG’s HTML calculators over an input grid', () => {
  it(`Traditional: every displayed figure identical (${grid.length} combinations)`, () => {
    for (const c of grid) {
      const fees = new Decimal('753.25'); // establishment 495 + origination 250 + PPSR 8.25
      const html = spg('traditional/traditional-quoting-tool.html', {
        financeAmount: c.amount,
        termMonths: String(c.term),
        baseRate: c.rate,
        commissionRate: '4',
        balloonPercent: c.balloonPercent,
        paymentTiming: c.timing,
        establishmentFee: '495',
        originationFee: '250',
        ppsrFee: '8.25',
        monthlyFee: '8',
        establishmentFinanced: c.financed,
        originationFinanced: c.financed,
        ppsrFinanced: c.financed,
      });
      const q = calculateQuote({
        model: 'capitalised',
        financeAmount: Money.from(c.amount),
        financedFees: Money.from(c.financed ? fees : new Decimal(0)),
        upfrontFees: Money.from(c.financed ? new Decimal(0) : fees),
        monthlyFee: Money.from('8'),
        baseRate: AnnualRate.from(new Decimal(c.rate).div(100)),
        commissionRate: Fraction.from('0.04'),
        termMonths: c.term,
        balloon: Money.from(
          new Decimal(c.amount).mul(c.balloonPercent).div(100),
        ),
        timing: c.timing,
      });
      expect(
        [
          html('nafResult'),
          html('commissionResult'),
          html('totalFinancedResult'),
          html('paymentResult'),
          html('grossPaymentResult'),
          html('comparisonRateResult'),
          html('totalInterestResult'),
        ],
        label(c),
      ).toEqual([
        q.netAmountFinanced.toFixed(),
        q.commission.toFixed(),
        q.amountFinanced.toFixed(),
        q.monthlyPayment.toFixed(),
        q.grossMonthlyPayment.toFixed(),
        percent(q.effectiveAnnualRate),
        q.totalInterest.toFixed(),
      ]);
    }
  });

  it(`Pepper: every displayed figure identical (${grid.length} combinations)`, () => {
    for (const c of grid) {
      const fees = new Decimal('1297'); // origination 790 + establishment 499 + PPSR 6 + search 2
      const naf = new Decimal(c.amount).plus(c.financed ? fees : 0);
      const commission = naf.mul('0.03').toFixed(2);
      const html = spg('pepper/pepper-calculator.html', {
        financeAmount: c.amount,
        termMonths: String(c.term),
        financierRate: c.rate,
        commissionDollar: commission,
        balloonPercent: c.balloonPercent,
        paymentTiming: c.timing,
        originationFee: '790',
        establishmentFee: '499',
        ppsrReg: '6',
        ppsrSearch: '2',
        originationFinanced: c.financed,
        establishmentFinanced: c.financed,
        ppsrRegFinanced: c.financed,
        ppsrSearchFinanced: c.financed,
      });
      const q = calculateQuote({
        model: 'pepper',
        financeAmount: Money.from(c.amount),
        financedFees: Money.from(c.financed ? fees : new Decimal(0)),
        upfrontFees: Money.from(c.financed ? new Decimal(0) : fees),
        financierRate: AnnualRate.from(new Decimal(c.rate).div(100)),
        commissionRate: Fraction.from(new Decimal(commission).div(naf)),
        termMonths: c.term,
        balloon: Money.from(
          new Decimal(c.amount).mul(c.balloonPercent).div(100),
        ),
        timing: c.timing,
      });
      expect(
        [
          html('nafResult'),
          html('commissionResult'),
          html('loadingResult'),
          html('amountFinancedResult'),
          html('paymentResult'),
          html('customerRateResult'),
          html('upfrontFeesResult'),
        ],
        label(c),
      ).toEqual([
        q.netAmountFinanced.toFixed(),
        q.commission.toFixed(),
        new Decimal(q.loading.toString()).toFixed(4),
        q.amountFinanced.toFixed(),
        q.monthlyPayment.toFixed(),
        percent(q.effectiveAnnualRate),
        q.upfrontFees.toFixed(),
      ]);
    }
  });

  it(`Branded: payments identical; commission differs only as documented (${grid.length} combinations)`, () => {
    for (const c of grid) {
      const fees = new Decimal('1546'); // establishment 550 + origination 990 + PPSR 6
      const contract = new Decimal(c.rate).plus('1.5');
      const html = spg('branded/branded-calculator.html', {
        financeAmount: c.amount,
        termMonths: String(c.term),
        baseRate: c.rate,
        contractRate: contract.toString(),
        balloonPercent: c.balloonPercent,
        paymentTiming: c.timing,
        monthlyFee: '8',
        establishmentFee: '550',
        originationFee: '990',
        ppsrFee: '6',
        establishmentFinanced: c.financed,
        originationFinanced: c.financed,
        ppsrFinanced: c.financed,
      });
      const q = calculateQuote({
        model: 'branded',
        financeAmount: Money.from(c.amount),
        financedFees: Money.from(c.financed ? fees : new Decimal(0)),
        upfrontFees: Money.from(c.financed ? new Decimal(0) : fees),
        monthlyFee: Money.from('8'),
        baseRate: AnnualRate.from(new Decimal(c.rate).div(100)),
        contractRate: AnnualRate.from(contract.div(100)),
        termMonths: c.term,
        balloon: Money.from(
          new Decimal(c.amount).mul(c.balloonPercent).div(100),
        ),
        timing: c.timing,
      });
      expect(
        [
          html('nafResult'),
          html('basePaymentResult'),
          html('finalPaymentResult'),
          html('grossPaymentResult'),
        ],
        label(c),
      ).toEqual([
        q.netAmountFinanced.toFixed(),
        q.baseNetPayment.toFixed(),
        q.monthlyPayment.toFixed(),
        q.grossMonthlyPayment.toFixed(),
      ]);
      if (c.timing === 'arrears')
        expect(
          new Decimal(html('commissionResult'))
            .minus(q.commission.toFixed())
            .abs()
            .lessThan(1),
          label(c),
        ).toBe(true);
    }
  });

  it(`Autopay: NAF, commission, starting principal and first interest identical (${grid.length / 2} combinations)`, () => {
    for (const c of grid.filter((item) => item.timing === 'arrears')) {
      const naf = new Decimal(c.amount).plus(c.financed ? 550 : 0);
      const html = spg('autopay/autopay-daily-interest-calculator.html', {
        financeAmount: c.amount,
        termMonths: String(c.term),
        annualRate: c.rate,
        commissionRate: '4',
        balloonPercent: c.balloonPercent,
        monthlyFee: '12.5',
        slidingFee: '12.5',
        establishmentFee: '350',
        originationFee: '200',
        establishmentFinanced: c.financed,
        originationFinanced: c.financed,
        settlementDate: '2025-05-31',
        firstRepaymentDate: '2025-06-30',
        adjustForHolidays: true,
      });
      const q = calculateQuote({
        model: 'autopay',
        mode: 'contract-terms',
        startingPrincipal: Money.from(naf.mul('1.04')),
        annualRate: AnnualRate.from(new Decimal(c.rate).div(100)),
        termMonths: c.term,
        balloon: Money.from(
          new Decimal(c.amount).mul(c.balloonPercent).div(100),
        ),
        settlementDate: '2025-05-31',
        firstRepaymentDate: '2025-06-30',
        monthlyFee: Money.from('12.5'),
        slidingFee: Money.from('12.5'),
        adjustBusinessDays: true,
      });
      expect(
        [
          html('nafResult'),
          html('commissionResult'),
          html('principalResult'),
          html('firstInterestResult'),
        ],
        label(c),
      ).toEqual([
        naf.toFixed(2),
        naf.mul('0.04').toFixed(2),
        q.amountFinanced.toFixed(),
        q.firstPaymentInterest.toFixed(),
      ]);
    }
  });
});
