import type { DisplayOptions, QuoteDto } from '@swyft/contracts';
import {
  formatMoney,
  formatRate,
  formatResidual,
  formatTerm,
} from '../../../shared/format';
import { repaymentParts } from '../../../shared/frequencies';
import { exportGroupKey } from '../../../shared/quote-export';
import { commissionDisplay } from './quote-log';
import { commissionBasis, paymentTimingLabel } from './signature-labels';

interface Row {
  readonly label: string;
  readonly cell: (quote: QuoteDto) => React.ReactNode;
  readonly when?: boolean;
}

/** Same grouping as the email: only quotes for the same amount and asset are compared. */
function groupQuotes(quotes: readonly QuoteDto[]) {
  const groups = new Map<string, QuoteDto[]>();
  for (const quote of quotes) {
    const key = exportGroupKey(quote);
    groups.set(key, [...(groups.get(key) ?? []), quote]);
  }
  return [...groups.values()];
}

/**
 * Side-by-side comparison: one column per quote, one row per attribute, in a fixed
 * order so lenders line up. It presents figures only; it does not rank lenders.
 */
export function QuoteCompare({
  quotes,
  display,
}: {
  readonly quotes: readonly QuoteDto[];
  readonly display: DisplayOptions;
}): React.JSX.Element {
  const rows: readonly Row[] = [
    {
      label: 'Repayments',
      cell: (quote) => (
        <>
          {repaymentParts(quote, display).map((part) => (
            <span key={part.frequency} className="block">
              <strong>{formatMoney(part.amount)}</strong> {part.frequency}
            </span>
          ))}
          <span className="muted small block">
            {Number(quote.monthlyFee) > 0
              ? `incl. ${formatMoney(quote.monthlyFee)} monthly fee`
              : 'no monthly fees'}
          </span>
        </>
      ),
    },
    {
      label: 'Payment type',
      cell: (quote) => paymentTimingLabel(quote),
    },
    { label: 'Term', cell: (quote) => formatTerm(quote.termMonths) },
    {
      label: 'Residual',
      cell: (quote) => formatResidual(quote.balloon, quote.financeAmount),
    },
    {
      label: 'Base rate',
      when: display.showBaseRate,
      cell: (quote) => formatRate(quote.baseRate),
    },
    {
      label: 'Contract rate',
      when:
        display.showBaseRate &&
        quotes.some((quote) => quote.contractRate !== null),
      cell: (quote) =>
        quote.contractRate === null ? '—' : formatRate(quote.contractRate),
    },
    {
      label: 'Comparison rate',
      when: display.showComparisonRate,
      cell: (quote) =>
        quote.comparisonRate === null ? '—' : formatRate(quote.comparisonRate),
    },
    { label: 'Lender fees', cell: (quote) => formatMoney(quote.lenderFee) },
    {
      label: 'Origination fee',
      cell: (quote) => formatMoney(quote.originationFee),
    },
    {
      label: 'Payable at settlement',
      cell: (quote) => formatMoney(quote.upfrontFees),
    },
    { label: 'Monthly fee', cell: (quote) => formatMoney(quote.monthlyFee) },
    {
      label: 'Amount financed',
      cell: (quote) => formatMoney(quote.amountFinanced),
    },
    {
      label: 'Broker commission',
      when: display.showCommission,
      cell: (quote) => (
        <>
          <strong>{commissionDisplay(quote)}</strong>
          <span className="muted small block">
            {commissionBasis(quote.commissionModel)}
          </span>
        </>
      ),
    },
    {
      label: 'Total hiring',
      when: display.showTotalHiring,
      cell: (quote) => formatMoney(quote.totalHiring),
    },
  ];
  const visible = rows.filter((row) => row.when !== false);

  return (
    <div className="compare">
      {groupQuotes(quotes).map((group) => {
        const first = group[0];
        if (!first) return null;
        return (
          <section key={first.id} className="compare-group">
            <h3>
              {formatMoney(first.financeAmount)} ·{' '}
              {first.assetDescription.trim() || 'Asset not specified'}
            </h3>
            <div className="table-scroll">
              <table className="data-table compare-table">
                <thead>
                  <tr>
                    <th scope="col" className="sticky-col">
                      <span className="visually-hidden">Attribute</span>
                    </th>
                    {group.map((quote, index) => (
                      <th scope="col" key={quote.id}>
                        <span className="muted small block">
                          Option {index + 1}
                        </span>
                        {quote.lenderName}
                        <span className="muted small block">
                          {quote.feeSignatureName}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <tr key={row.label}>
                      <th scope="row" className="sticky-col">
                        {row.label}
                      </th>
                      {group.map((quote) => (
                        <td key={quote.id}>{row.cell(quote)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
