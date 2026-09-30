import { Decimal } from 'decimal.js';
import type { DisplayOptions, QuoteDto } from '@swyft/contracts';
import {
  formatMoney,
  formatMoneyForEmail,
  formatRate,
  formatRateCompact,
  formatResidual,
  formatTerm,
} from './format';
import { formatRepayments } from './frequencies';

/**
 * Email-ready quote export (brief: "Email-Ready Quote Export"). Quotes are grouped by
 * finance amount and asset; each group has a 2×2 header table, then one 2×3 option table
 * per quote with footer lines that follow the display toggles. The model is rendered as
 * escaped HTML with inline styles only (email editors drop stylesheets) and as plain
 * text. It is pure so Main (clipboard) and the Renderer (preview) share it.
 */

export interface ExportLine {
  readonly label: string;
  readonly value: string;
}

/** One quote in the email: its Term/Repayments/Residual table plus footer lines. */
export interface ExportOption {
  readonly quoteId: string;
  readonly rows: readonly ExportLine[];
  readonly footer: readonly ExportLine[];
}

/** Quotes sharing a finance amount and asset, under one header table. */
export interface ExportGroup {
  readonly header: readonly ExportLine[];
  readonly options: readonly ExportOption[];
}

/** The export model plus the two clipboard formats built from it. */
export interface QuoteExport {
  readonly groups: readonly ExportGroup[];
  readonly html: string;
  readonly text: string;
}

const noAsset = 'Not specified';

/** Plain single-line text: whitespace (including newlines) collapses for both formats. */
function assetLabel(description: string): string {
  const collapsed = description.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? noAsset : collapsed;
}

function commissionText(quote: QuoteDto): string | undefined {
  if (quote.commission === null) return undefined;
  const amount = formatMoneyForEmail(quote.commission);
  return quote.commissionRate === null
    ? amount
    : `${amount} (${formatRateCompact(quote.commissionRate)})`;
}

function optionFor(quote: QuoteDto, display: DisplayOptions): ExportOption {
  const footer: ExportLine[] = [
    { label: 'Lender Fee', value: formatMoneyForEmail(quote.lenderFee) },
    {
      label: 'Origination Fee',
      value: new Decimal(quote.originationFee).isZero()
        ? '$ waived'
        : formatMoneyForEmail(quote.originationFee),
    },
  ];
  if (!new Decimal(quote.upfrontFees).isZero())
    footer.push({
      label: 'Fees payable at settlement',
      value: formatMoneyForEmail(quote.upfrontFees),
    });
  if (display.showComparisonRate && quote.comparisonRate !== null)
    footer.push({
      label: 'Comparison rate',
      value: formatRate(quote.comparisonRate),
    });
  if (display.showBaseRate) {
    footer.push({ label: 'Base rate', value: formatRate(quote.baseRate) });
    // Commission-overs lenders charge the client the contract rate, not the base rate.
    if (quote.contractRate !== null)
      footer.push({
        label: 'Contract rate',
        value: formatRate(quote.contractRate),
      });
  }
  const commission = commissionText(quote);
  if (display.showCommission && commission !== undefined)
    footer.push({ label: 'Commissions', value: commission });
  if (display.showTotalHiring)
    footer.push({
      label: 'Total Hiring Installments',
      value: formatMoney(quote.totalHiring),
    });
  return {
    quoteId: quote.id,
    rows: [
      { label: 'Term', value: formatTerm(quote.termMonths) },
      { label: 'Repayments', value: formatRepayments(quote, display) },
      {
        label: 'Residual',
        value: formatResidual(quote.balloon, quote.financeAmount),
      },
    ],
    footer,
  };
}

/** Quotes with the same key share one Finance Amount / Asset header. */
export function exportGroupKey(quote: QuoteDto): string {
  return JSON.stringify([
    new Decimal(quote.financeAmount).toFixed(2),
    assetLabel(quote.assetDescription),
  ]);
}

/** Groups in first-seen order; options keep the order the quotes were given in. */
export function buildExportGroups(
  quotes: readonly QuoteDto[],
  display: DisplayOptions,
): readonly ExportGroup[] {
  const groups = new Map<
    string,
    { header: ExportLine[]; options: ExportOption[] }
  >();
  for (const quote of quotes) {
    const amount = new Decimal(quote.financeAmount).toFixed(2);
    const asset = assetLabel(quote.assetDescription);
    const key = exportGroupKey(quote);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        header: [
          // Brief header style: "$ 50,000.00" (always with cents).
          {
            label: 'Finance Amount',
            value: `$ ${formatMoney(amount).slice(1)}`,
          },
          { label: 'Asset', value: asset },
        ],
        options: [],
      };
      groups.set(key, group);
    }
    group.options.push(optionFor(quote, display));
  }
  return [...groups.values()];
}

const htmlEscapes: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => htmlEscapes[character] ?? '');
}

const font =
  'font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2933;';
const tableStyle =
  'border-collapse:collapse;border:1px solid #9aa5b1;margin:0 0 4px 0;min-width:420px;';
const cellStyle = `border:1px solid #9aa5b1;padding:6px 10px;${font}`;
const labelStyle = `${cellStyle}text-align:left;background-color:#eef2f6;width:150px;`;

function tableHtml(lines: readonly ExportLine[], bold: boolean): string {
  const weight = bold ? 'font-weight:bold;' : 'font-weight:normal;';
  const rows = lines
    .map(
      (line) =>
        `<tr><th scope="row" style="${labelStyle}${weight}">${escapeHtml(line.label)}</th>` +
        `<td style="${cellStyle}${weight}">${escapeHtml(line.value)}</td></tr>`,
    )
    .join('');
  return `<table cellpadding="0" cellspacing="0" border="1" style="${tableStyle}"><tbody>${rows}</tbody></table>`;
}

function footerHtml(lines: readonly ExportLine[]): string {
  return lines
    .map(
      (line) =>
        `<p style="margin:2px 0;${font}"><strong>${escapeHtml(line.label)}:</strong> ${escapeHtml(line.value)}</p>`,
    )
    .join('');
}

/** Email-safe HTML: inline styles only, bordered tables, all text escaped. */
export function renderExportHtml(groups: readonly ExportGroup[]): string {
  const body = groups
    .map((group) => {
      const options = group.options
        .map(
          (option) =>
            `<div style="margin:12px 0 0 0;">${tableHtml(option.rows, false)}${footerHtml(option.footer)}</div>`,
        )
        .join('');
      return `<div style="margin:0 0 24px 0;">${tableHtml(group.header, true)}${options}</div>`;
    })
    .join('');
  return `<div style="${font}">${body}</div>`;
}

/** Plain-text version for editors that do not accept HTML. */
export function renderExportText(groups: readonly ExportGroup[]): string {
  const line = (item: ExportLine) => `${item.label}: ${item.value}`;
  return groups
    .map((group) => {
      const header = group.header.map(line).join('\n');
      const options = group.options
        .map((option, index) =>
          [
            `Option ${index + 1}`,
            ...option.rows.map(line),
            ...option.footer.map(line),
          ].join('\n'),
        )
        .join('\n\n');
      return `${header}\n\n${options}`;
    })
    .join('\n\n----------------------------------------\n\n');
}

/** Builds the client email for the selected quotes, honouring the display options. */
export function buildQuoteExport(
  quotes: readonly QuoteDto[],
  display: DisplayOptions,
): QuoteExport {
  const groups = buildExportGroups(quotes, display);
  return {
    groups,
    html: renderExportHtml(groups),
    text: renderExportText(groups),
  };
}
