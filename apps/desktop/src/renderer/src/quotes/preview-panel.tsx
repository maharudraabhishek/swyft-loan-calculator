import type {
  DisplayOptions,
  FeeSignatureDto,
  QuotePreviewDto,
} from '@swyft/contracts';
import { formatDate, formatMoney, formatRate } from '../../../shared/format';
import { monthlyFeeNote, repaymentParts } from '../../../shared/frequencies';
import { commissionBasis } from './signature-labels';

export type PreviewState =
  | { readonly status: 'incomplete' }
  | { readonly status: 'calculating' }
  | { readonly status: 'ready'; readonly preview: QuotePreviewDto }
  | { readonly status: 'error'; readonly message: string };

function Figure({
  label,
  value,
  note,
}: {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
}): React.JSX.Element {
  return (
    <div className="figure">
      <dt>{label}</dt>
      <dd>
        {value}
        {note && <span className="figure-note"> {note}</span>}
      </dd>
    </div>
  );
}

/**
 * The local, unsaved calculation. Labelled as a preview so it is never mistaken for a
 * saved quote; saved figures always come back from the API.
 */
export function PreviewPanel({
  state,
  signature,
  display,
}: {
  readonly state: PreviewState;
  readonly signature: FeeSignatureDto | undefined;
  readonly display: DisplayOptions;
}): React.JSX.Element {
  return (
    <section className="preview-panel" aria-labelledby="preview-heading">
      <div className="preview-heading">
        <h3 id="preview-heading">Preview</h3>
        <span className="badge neutral">Not saved</span>
      </div>
      <div aria-live="polite" aria-busy={state.status === 'calculating'}>
        {state.status === 'incomplete' && (
          <p className="muted">
            Choose a lender and enter the finance amount, term and rates to see
            the repayment.
          </p>
        )}
        {state.status === 'calculating' && (
          <p className="muted">Calculating…</p>
        )}
        {state.status === 'error' && (
          <p className="field-error">{state.message}</p>
        )}
        {state.status === 'ready' && signature && (
          <PreviewFigures
            preview={state.preview}
            signature={signature}
            display={display}
          />
        )}
      </div>
    </section>
  );
}

function PreviewFigures({
  preview,
  signature,
  display,
}: {
  readonly preview: QuotePreviewDto;
  readonly signature: FeeSignatureDto;
  readonly display: DisplayOptions;
}): React.JSX.Element {
  const parts = repaymentParts(preview, display);
  return (
    <>
      <div className="repayment-headline">
        {parts.map((part, index) => (
          <p key={part.frequency} className={index === 0 ? 'primary' : ''}>
            <strong>{formatMoney(part.amount)}</strong>{' '}
            <span className="muted">{part.frequency}</span>
          </p>
        ))}
        <p className="muted small">{monthlyFeeNote(preview.monthlyFee)}</p>
      </div>
      <dl className="figures">
        {preview.comparisonRate !== null && (
          <Figure
            label="Comparison rate"
            value={formatRate(preview.comparisonRate)}
          />
        )}
        {preview.contractRate !== null && (
          <Figure
            label="Contract rate"
            value={formatRate(preview.contractRate)}
          />
        )}
        <Figure label="Total hiring" value={formatMoney(preview.totalHiring)} />
        {preview.commission !== null && (
          <Figure
            label="Commission"
            value={formatMoney(preview.commission)}
            note={`(${commissionBasis(signature.commissionModel)})`}
          />
        )}
        <Figure
          label="Net amount financed"
          value={formatMoney(preview.netAmountFinanced)}
        />
        <Figure
          label="Amount financed"
          value={formatMoney(preview.amountFinanced)}
        />
        <Figure label="Lender fees" value={formatMoney(preview.lenderFee)} />
        <Figure
          label="Origination fee"
          value={formatMoney(preview.originationFee)}
        />
        {Number(preview.upfrontFees) > 0 && (
          <Figure
            label="Payable at settlement"
            value={formatMoney(preview.upfrontFees)}
          />
        )}
        <Figure
          label="Instalment before fees"
          value={formatMoney(preview.monthlyPayment)}
          note="per month"
        />
      </dl>
      <details className="schedule">
        <summary>
          Repayment schedule ({preview.schedule.length} payments)
        </summary>
        <div className="table-scroll">
          <table className="data-table compact">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Date</th>
                <th scope="col" className="num">
                  Opening
                </th>
                <th scope="col" className="num">
                  Interest
                </th>
                <th scope="col" className="num">
                  Principal
                </th>
                <th scope="col" className="num">
                  Fees
                </th>
                <th scope="col" className="num">
                  Closing
                </th>
              </tr>
            </thead>
            <tbody>
              {preview.schedule.map((row) => (
                <tr key={row.paymentNumber}>
                  <td>{row.paymentNumber}</td>
                  <td>{row.paymentDate ? formatDate(row.paymentDate) : '—'}</td>
                  <td className="num">
                    {formatMoney(row.openingBalanceDollars)}
                  </td>
                  <td className="num">{formatMoney(row.interestDollars)}</td>
                  <td className="num">{formatMoney(row.principalDollars)}</td>
                  <td className="num">{formatMoney(row.feesDollars)}</td>
                  <td className="num">
                    {formatMoney(row.closingBalanceDollars)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
