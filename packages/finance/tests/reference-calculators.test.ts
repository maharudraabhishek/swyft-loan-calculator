import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { AnnualRate, Fraction, Money, calculateQuote } from '../src/index.js';

interface Element {
  value: string;
  checked: boolean;
  textContent: string;
  innerHTML: string;
  addEventListener(): void;
  appendChild(): void;
}

/** Execute the pinned upstream calculator verbatim; this adapter supplies only DOM values. */
function calculateHtml(
  file: string,
  inputs: Readonly<Record<string, string | boolean>>,
): Map<string, Element> {
  const html = readFileSync(
    new URL(`../../../tests/fixtures/upstream/${file}`, import.meta.url),
    'utf8',
  );
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error(`No calculator script in ${file}`);
  const elements = new Map<string, Element>();
  const getElementById = (id: string): Element => {
    let element = elements.get(id);
    if (!element) {
      const value = inputs[id];
      element = {
        value: typeof value === 'string' ? value : '0',
        checked: value === true,
        textContent: '',
        innerHTML: '',
        addEventListener() {},
        appendChild() {},
      };
      elements.set(id, element);
    }
    return element;
  };
  // Only immutable local reference scripts are executed. No Node APIs are exposed.
  runInNewContext(
    script,
    {
      document: {
        getElementById,
        querySelectorAll: () => [],
        createElement: () => ({ innerHTML: '' }),
      },
    },
    { timeout: 1000 },
  );
  return elements;
}

function moneyOutput(elements: Map<string, Element>, id: string): string {
  const value = elements.get(id)?.textContent;
  if (!value) throw new Error(`Missing HTML output ${id}`);
  return value.replace(/[$,]/g, '');
}

describe('unmodified upstream HTML calculator execution', () => {
  it('matches daily first interest while replacing the HTML approximate PMT with an actual-day solve', () => {
    const quote = calculateQuote({
      model: 'autopay',
      mode: 'contract-terms',
      startingPrincipal: Money.from('85704.86'),
      annualRate: AnnualRate.from('0.0895'),
      termMonths: 60,
      settlementDate: '2025-05-31',
      firstRepaymentDate: '2025-06-06',
    });
    // Starting principal already includes commission; adding it again would change the contract.
    const html = calculateHtml(
      'autopay/autopay-daily-interest-calculator.html',
      {
        financeAmount: '85704.86',
        annualRate: '8.95',
        termMonths: '60',
        settlementDate: '2025-05-31',
        firstRepaymentDate: '2025-06-06',
        adjustForHolidays: true,
      },
    );
    // The upstream HTML explicitly labels its monthly-annuity PMT an approximation.
    expect(moneyOutput(html, 'paymentResult')).toBe('1777.01');
    expect(quote.monthlyPayment.toFixed()).toBe('1767.42');
    expect(quote.firstPaymentInterest.toFixed()).toBe(
      moneyOutput(html, 'firstInterestResult'),
    );
  });

  it('matches the Traditional HTML with the basic Westpac input', () => {
    const quote = calculateQuote({
      model: 'capitalised',
      financeAmount: Money.from('30000'),
      financedFees: Money.from('495'),
      baseRate: AnnualRate.from('0.085'),
      commissionRate: Fraction.from('0.04'),
      termMonths: 60,
      timing: 'advance',
    });
    const html = calculateHtml('traditional/traditional-quoting-tool.html', {
      financeAmount: '30000',
      establishmentFee: '495',
      establishmentFinanced: true,
      baseRate: '8.5',
      commissionRate: '4',
      termMonths: '60',
      paymentTiming: 'advance',
    });
    expect(quote.monthlyPayment.toFixed()).toBe(
      moneyOutput(html, 'paymentResult'),
    );
    expect(quote.totalInterest.toFixed()).toBe(
      moneyOutput(html, 'totalInterestResult'),
    );
  });
  it.each(['advance', 'arrears'] as const)(
    'matches Traditional %s across balloon and fee configurations',
    (timing) => {
      for (const balloon of ['0', '13500']) {
        const input = {
          model: 'capitalised',
          financeAmount: Money.from('45000'),
          financedFees: Money.from('495'),
          upfrontFees: Money.from('790'),
          baseRate: AnnualRate.from('0.0795'),
          commissionRate: Fraction.from('0.04'),
          termMonths: 48,
          timing,
          balloon: Money.from(balloon),
          monthlyFee: Money.from('8'),
        } as const;
        const quote = calculateQuote(input);
        const html = calculateHtml(
          'traditional/traditional-quoting-tool.html',
          {
            financeAmount: '45000',
            establishmentFee: '495',
            establishmentFinanced: true,
            originationFee: '790',
            originationFinanced: false,
            baseRate: '7.95',
            commissionRate: '4',
            termMonths: '48',
            paymentTiming: timing,
            balloonPercent: balloon === '0' ? '0' : '30',
            monthlyFee: '8',
          },
        );
        expect(quote.monthlyPayment.toFixed()).toBe(
          moneyOutput(html, 'paymentResult'),
        );
        expect(quote.grossMonthlyPayment.toFixed()).toBe(
          moneyOutput(html, 'grossPaymentResult'),
        );
        expect(quote.amountFinanced.toFixed()).toBe(
          moneyOutput(html, 'totalFinancedResult'),
        );
        expect(quote.totalInterest.toFixed()).toBe(
          moneyOutput(html, 'totalInterestResult'),
        );
        expect(
          quote.effectiveAnnualRate?.decimal().mul(100).toFixed(2) + '%',
        ).toBe(html.get('comparisonRateResult')?.textContent);
      }
    },
  );

  it.each(['790', '1297'])(
    'matches Pepper loading with $%s financed fees',
    (fees) => {
      const naf = Money.from('34400').decimal().plus(fees);
      const commission = naf.mul('0.02');
      const quote = calculateQuote({
        model: 'pepper',
        financeAmount: Money.from('34400'),
        financedFees: Money.from(fees),
        financierRate: AnnualRate.from('0.1229'),
        commissionRate: Fraction.from('0.02'),
        termMonths: 60,
        timing: 'advance',
      });
      const html = calculateHtml('pepper/pepper-calculator.html', {
        financeAmount: '34400',
        originationFee: '790',
        originationFinanced: true,
        establishmentFee: '499',
        establishmentFinanced: fees === '1297',
        ppsrReg: '6',
        ppsrRegFinanced: fees === '1297',
        ppsrSearch: '2',
        ppsrSearchFinanced: fees === '1297',
        financierRate: '12.29',
        commissionDollar: commission.toString(),
        termMonths: '60',
        paymentTiming: 'advance',
      });
      expect(quote.amountFinanced.toFixed()).toBe(
        moneyOutput(html, 'amountFinancedResult'),
      );
      expect(quote.monthlyPayment.toFixed()).toBe(
        moneyOutput(html, 'paymentResult'),
      );
      expect(
        quote.effectiveAnnualRate?.decimal().mul(100).toFixed(2) + '%',
      ).toBe(html.get('customerRateResult')?.textContent);
    },
  );
});
