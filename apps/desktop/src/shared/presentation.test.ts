import { defaultDisplayOptions, type DisplayOptions } from '@swyft/contracts';
import { describe, expect, it } from 'vitest';
import { quoteFixture } from '../test-support/fixtures';
import {
  formatDate,
  formatMoney,
  formatMoneyForEmail,
  formatRate,
  formatRateCompact,
  formatResidual,
  formatTerm,
  fractionToPercent,
  percentToFraction,
} from './format';
import {
  convertMonthlyAmount,
  formatRepayments,
  monthlyFeeNote,
  selectedFrequencies,
} from './frequencies';
import { buildQuoteExport, escapeHtml } from './quote-export';

const allFrequencies: DisplayOptions = {
  ...defaultDisplayOptions,
  frequencies: { monthly: true, fortnightly: true, weekly: true },
};

describe('formatting', () => {
  it('formats AUD with grouping and half-up cents', () => {
    expect(formatMoney('39040.8')).toBe('$39,040.80');
    expect(formatMoney('1234567.005')).toBe('$1,234,567.01');
    expect(formatMoney('0')).toBe('$0.00');
    expect(formatMoney('-12.5')).toBe('-$12.50');
  });

  it('uses the brief email money style without misstating cents', () => {
    expect(formatMoneyForEmail('500.00')).toBe('$ 500');
    expect(formatMoneyForEmail('2020')).toBe('$ 2,020');
    expect(formatMoneyForEmail('283.25')).toBe('$ 283.25');
  });

  it('formats annual fractions as percentages', () => {
    expect(formatRate('0.085')).toBe('8.50%');
    expect(formatRate('0.1018123456')).toBe('10.18%');
    expect(formatRateCompact('0.04')).toBe('4%');
    expect(formatRateCompact('0.0408')).toBe('4.08%');
  });

  it('converts entered percentages to exact fractions and back', () => {
    expect(percentToFraction('8.5')).toBe('0.085');
    expect(percentToFraction('12.34')).toBe('0.1234');
    expect(fractionToPercent('0.0408')).toBe('4.08');
  });

  it('writes NIL for no residual and shows the share otherwise', () => {
    expect(formatResidual('0.00', '50000')).toBe('NIL');
    expect(formatResidual('22500', '75000')).toBe('$22,500.00 (30%)');
  });

  it('formats terms and dates', () => {
    expect(formatTerm(60)).toBe('60 months');
    expect(formatTerm(1)).toBe('1 month');
    expect(formatDate('2026-09-29')).toMatch(/^29 Sept? 2026$/);
    expect(formatDate('not a date')).toBe('not a date');
  });
});

describe('payment frequencies', () => {
  it('matches the brief example: $650.68 monthly', () => {
    expect(convertMonthlyAmount('650.68', 'monthly')).toBe('650.68');
    expect(convertMonthlyAmount('650.68', 'fortnightly')).toBe('300.31');
    expect(convertMonthlyAmount('650.68', 'weekly')).toBe('150.16');
  });

  it('builds the OR string with the monthly fee note on every part', () => {
    expect(formatRepayments(quoteFixture(), allFrequencies)).toBe(
      '$650.68 (monthly) (no monthly fees) OR $300.31 (fortnightly) (no monthly fees) OR $150.16 (weekly) (no monthly fees)',
    );
    const withFee = quoteFixture({
      monthlyPayment: '428.46',
      grossMonthlyPayment: '436.46',
      monthlyFee: '8.00',
    });
    expect(
      formatRepayments(withFee, {
        ...defaultDisplayOptions,
        frequencies: { monthly: true, fortnightly: false, weekly: true },
      }),
    ).toBe(
      '$436.46 (monthly) (incl. $8.00 monthly fee) OR $100.72 (weekly) (incl. $8.00 monthly fee)',
    );
    expect(monthlyFeeNote('12.5')).toBe('(incl. $12.50 monthly fee)');
  });

  it('never shows an empty payment string', () => {
    expect(
      selectedFrequencies({
        ...defaultDisplayOptions,
        frequencies: { monthly: false, fortnightly: false, weekly: false },
      }),
    ).toEqual(['monthly']);
  });
});

describe('email export', () => {
  const second = quoteFixture({
    id: '10000000-0000-4000-8000-000000000002',
    lenderName: 'Branded',
    termMonths: 48,
    commission: '735.02',
    commissionRate: null,
    balloon: '9000.00',
  });
  const otherAsset = quoteFixture({
    id: '10000000-0000-4000-8000-000000000003',
    assetDescription: 'Caravan',
  });

  it('groups options under one finance amount and asset header', () => {
    const { groups, text } = buildQuoteExport(
      [quoteFixture(), otherAsset, second],
      defaultDisplayOptions,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]?.header).toEqual([
      { label: 'Finance Amount', value: '$ 30,000.00' },
      { label: 'Asset', value: 'New Vehicle' },
    ]);
    expect(groups[0]?.options.map((option) => option.quoteId)).toEqual([
      quoteFixture().id,
      second.id,
    ]);
    expect(groups[0]?.options[1]?.rows).toEqual([
      { label: 'Term', value: '48 months' },
      {
        label: 'Repayments',
        value: '$650.68 (monthly) (no monthly fees)',
      },
      { label: 'Residual', value: '$9,000.00 (30%)' },
    ]);
    expect(text).toContain('Finance Amount: $ 30,000.00\nAsset: New Vehicle');
    expect(text).toContain('Asset: Caravan');
  });

  it('reproduces the brief’s Land Rover Defender example exactly', () => {
    const defender = quoteFixture({
      financeAmount: '50000.00',
      assetDescription: 'New Land Rover Defender',
      termMonths: 60,
      monthlyPayment: '1031.55',
      grossMonthlyPayment: '1031.55',
      monthlyFee: '0.00',
      balloon: '0.00',
      lenderFee: '500.00',
      originationFee: '0.00',
      upfrontFees: '0.00',
      comparisonRate: '0.0862',
      baseRate: '0.069',
      contractRate: null,
      commission: '2020.00',
      commissionRate: '0.04',
    });
    const { groups, text } = buildQuoteExport([defender, defender], {
      frequencies: { monthly: true, fortnightly: true, weekly: false },
      showBaseRate: true,
      showComparisonRate: true,
      showCommission: true,
      showTotalHiring: false,
    });
    // Header table (2 × 2), then stacked quote options under the same header.
    expect(groups).toHaveLength(1);
    expect(groups[0]?.header).toEqual([
      { label: 'Finance Amount', value: '$ 50,000.00' },
      { label: 'Asset', value: 'New Land Rover Defender' },
    ]);
    expect(groups[0]?.options).toHaveLength(2);
    // Quote option table (2 × 3) and footer lines, as printed in the brief.
    expect(groups[0]?.options[0]?.rows).toEqual([
      { label: 'Term', value: '60 months' },
      {
        label: 'Repayments',
        value:
          '$1,031.55 (monthly) (no monthly fees) OR $476.10 (fortnightly) (no monthly fees)',
      },
      { label: 'Residual', value: 'NIL' },
    ]);
    expect(groups[0]?.options[0]?.footer).toEqual([
      { label: 'Lender Fee', value: '$ 500' },
      { label: 'Origination Fee', value: '$ waived' },
      { label: 'Comparison rate', value: '8.62%' },
      { label: 'Base rate', value: '6.90%' },
      { label: 'Commissions', value: '$ 2,020 (4%)' },
    ]);
    expect(text).toContain('Lender Fee: $ 500\nOrigination Fee: $ waived');
  });

  it('follows the display toggles in footer lines', () => {
    const shown = buildQuoteExport([quoteFixture()], {
      ...defaultDisplayOptions,
      showBaseRate: true,
      showComparisonRate: true,
      showCommission: true,
      showTotalHiring: true,
    });
    expect(shown.groups[0]?.options[0]?.footer).toEqual([
      { label: 'Lender Fee', value: '$ 495' },
      { label: 'Origination Fee', value: '$ waived' },
      { label: 'Comparison rate', value: '10.18%' },
      { label: 'Base rate', value: '8.50%' },
      { label: 'Commissions', value: '$ 1,219.80 (4%)' },
      { label: 'Total Hiring Installments', value: '$39,040.80' },
    ]);
    const hidden = buildQuoteExport([quoteFixture()], {
      ...defaultDisplayOptions,
      showBaseRate: false,
      showComparisonRate: false,
      showCommission: false,
      showTotalHiring: false,
    });
    expect(
      hidden.groups[0]?.options[0]?.footer.map((line) => line.label),
    ).toEqual(['Lender Fee', 'Origination Fee']);
    expect(hidden.html).not.toMatch(/Commission|Base rate|Comparison|Hiring/);
    expect(hidden.text).not.toMatch(/Commission|Base rate|Comparison|Hiring/);
  });

  it('adds the contract rate for commission-overs quotes under the base rate toggle', () => {
    const overs = quoteFixture({
      contractRate: '0.1004',
      commissionRate: null,
    });
    const footer = buildQuoteExport([overs], defaultDisplayOptions).groups[0]
      ?.options[0]?.footer;
    expect(footer).toContainEqual({ label: 'Contract rate', value: '10.04%' });
    const hidden = buildQuoteExport([overs], {
      ...defaultDisplayOptions,
      showBaseRate: false,
    }).groups[0]?.options[0]?.footer;
    expect(hidden?.some((line) => line.label === 'Contract rate')).toBe(false);
  });

  it('shows upfront fees and origination amounts', () => {
    const quote = quoteFixture({
      originationFee: '990.00',
      upfrontFees: '505.00',
    });
    const footer = buildQuoteExport([quote], defaultDisplayOptions).groups[0]
      ?.options[0]?.footer;
    expect(footer).toContainEqual({ label: 'Origination Fee', value: '$ 990' });
    expect(footer).toContainEqual({
      label: 'Fees payable at settlement',
      value: '$ 505',
    });
  });

  it('escapes user text so it cannot inject HTML', () => {
    const hostile = quoteFixture({
      assetDescription: '<img src=x onerror="alert(1)"> & "Ute"\n<script>',
    });
    const { html, text } = buildQuoteExport([hostile], defaultDisplayOptions);
    expect(html).not.toMatch(/<img|<script|onerror="/);
    expect(html).toContain(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;Ute&quot; &lt;script&gt;',
    );
    expect(text).toContain(
      'Asset: <img src=x onerror="alert(1)"> & "Ute" <script>',
    );
    expect(escapeHtml(`'`)).toBe('&#39;');
  });

  it('produces email-safe markup: tables, inline styles, no stylesheets', () => {
    const { html } = buildQuoteExport([quoteFixture()], defaultDisplayOptions);
    expect(html).toMatch(/^<div style="/);
    expect(html).toContain('<table');
    expect(html).toContain('border-collapse:collapse');
    expect(html).not.toMatch(/<style|<link|class=/);
  });

  it('labels a missing asset instead of leaving it blank', () => {
    const { groups } = buildQuoteExport(
      [quoteFixture({ assetDescription: '  ' })],
      defaultDisplayOptions,
    );
    expect(groups[0]?.header[1]).toEqual({
      label: 'Asset',
      value: 'Not specified',
    });
  });
});
