import { Fragment, useEffect, useId, useRef, useState } from 'react';
import type { ApiFailure, DisplayOptions, QuoteDto } from '@swyft/contracts';
import {
  formatDate,
  formatMoney,
  formatRate,
  formatRateCompact,
  formatResidual,
  formatTerm,
} from '../../../shared/format';
import { repaymentParts } from '../../../shared/frequencies';
import { useBridge } from '../lib/bridge';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { ErrorNotice } from '../ui/notice';
import {
  commissionBasis,
  signatureTitle,
  paymentTimingLabel,
} from './signature-labels';

function Repayments({
  quote,
  display,
}: {
  readonly quote: QuoteDto;
  readonly display: DisplayOptions;
}): React.JSX.Element {
  const parts = repaymentParts(quote, display);
  return (
    <span className="repayments">
      {parts.map((part, index) => (
        <span key={part.frequency} className="repayment-line">
          {index > 0 && <span className="or">or </span>}
          <strong>{formatMoney(part.amount)}</strong> {part.frequency}
        </span>
      ))}
      <span className="muted small">
        {Number(quote.monthlyFee) > 0
          ? `incl. ${formatMoney(quote.monthlyFee)} monthly fee`
          : 'no monthly fees'}
      </span>
    </span>
  );
}

export function commissionDisplay(quote: QuoteDto): string {
  if (quote.commission === null) return '—';
  return quote.commissionRate === null
    ? formatMoney(quote.commission)
    : `${formatMoney(quote.commission)} (${formatRateCompact(quote.commissionRate)})`;
}

type NotesState =
  | { readonly status: 'idle' }
  | { readonly status: 'saving' }
  | { readonly status: 'saved' }
  | { readonly status: 'failed'; readonly error: ApiFailure };

/**
 * Notes are the only editable part of a saved quote. The unsaved draft is owned by the
 * deal workspace (not this editor), so collapsing a row, switching layout or tab, or a
 * background reload never discards or overwrites what the broker typed.
 */
function NotesEditor({
  quote,
  draft,
  onDraftChange,
  onSaved,
  autoFocus,
}: {
  readonly quote: QuoteDto;
  /** `undefined` means no unsaved edit: the server value is shown. */
  readonly draft: string | undefined;
  readonly onDraftChange: (draft: string | undefined) => void;
  readonly onSaved: (quote: QuoteDto) => void;
  readonly autoFocus: boolean;
}): React.JSX.Element {
  const bridge = useBridge();
  const id = useId();
  const [state, setState] = useState<NotesState>({ status: 'idle' });
  const value = draft ?? quote.notes;
  const dirty = draft !== undefined && draft !== quote.notes;
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const save = async () => {
    setState({ status: 'saving' });
    const result = await bridge.quotes.updateNotes(quote.id, value);
    if (result.ok) {
      setState({ status: 'saved' });
      onSaved(result.data);
      onDraftChange(undefined);
    } else setState({ status: 'failed', error: result.error });
  };

  return (
    <div className="notes-editor">
      <label htmlFor={id}>Notes</label>
      <textarea
        id={id}
        ref={ref}
        rows={3}
        maxLength={2000}
        value={value}
        // Locked while saving so text typed mid-save cannot be lost when the draft clears.
        readOnly={state.status === 'saving'}
        onChange={(event) => {
          onDraftChange(event.target.value);
          if (state.status !== 'saving') setState({ status: 'idle' });
        }}
        placeholder="Add a note for this quote (visible only to you)"
      />
      <div className="notes-actions">
        <button
          type="button"
          className="button secondary small"
          disabled={!dirty || state.status === 'saving'}
          onClick={() => void save()}
        >
          {state.status === 'saving' ? 'Saving…' : 'Save note'}
        </button>
        {dirty && state.status !== 'saving' && (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              onDraftChange(undefined);
              setState({ status: 'idle' });
            }}
          >
            Discard changes
          </button>
        )}
        <span role="status" aria-live="polite" className="small">
          {state.status === 'saved' && !dirty && (
            <span className="success">Note saved</span>
          )}
          {dirty && state.status === 'idle' && (
            <span className="muted">Unsaved changes</span>
          )}
        </span>
      </div>
      {state.status === 'failed' && (
        <ErrorNotice
          error={state.error}
          context="The note was not saved."
          onRetry={() => void save()}
        />
      )}
    </div>
  );
}

function Detail({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * The deal's quote log (brief: "Quotes Log Table"). Essential columns stay visible at
 * every width; secondary columns collapse on narrow windows and every value remains in
 * the expandable detail row, so nothing required is lost to horizontal scrolling.
 */
export function QuoteLog({
  quotes,
  display,
  selected,
  onToggleSelected,
  onQuoteChanged,
  onQuoteDeleted,
  drafts,
  onDraftsChange,
}: {
  readonly quotes: readonly QuoteDto[];
  readonly display: DisplayOptions;
  readonly selected: ReadonlySet<string>;
  readonly onToggleSelected: (quoteId: string) => void;
  readonly onQuoteChanged: (quote: QuoteDto) => void;
  readonly onQuoteDeleted: (quoteId: string) => void;
  /** Unsaved note drafts by quote ID, owned by the deal workspace. */
  readonly drafts: Readonly<Record<string, string>>;
  readonly onDraftsChange: (
    change: (
      current: Readonly<Record<string, string>>,
    ) => Readonly<Record<string, string>>,
  ) => void;
}): React.JSX.Element {
  const bridge = useBridge();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [focusNotes, setFocusNotes] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState<QuoteDto>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<ApiFailure>();

  const toggle = (id: string, notes = false) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id) && !notes) next.delete(id);
      else next.add(id);
      return next;
    });
    setFocusNotes(notes ? id : undefined);
  };

  const remove = async (quote: QuoteDto) => {
    setDeleting(true);
    setDeleteError(undefined);
    const result = await bridge.quotes.remove(quote.id);
    setDeleting(false);
    // A quote already gone on the server is gone either way.
    if (result.ok || result.error.kind === 'not-found') {
      setConfirmDelete(undefined);
      onQuoteDeleted(quote.id);
    } else setDeleteError(result.error);
  };

  const optional = {
    base: display.showBaseRate,
    comparison: display.showComparisonRate,
    commission: display.showCommission,
    hiring: display.showTotalHiring,
  };
  const columnCount = 9 + Object.values(optional).filter(Boolean).length + 5;

  return (
    <div className="log-container">
      <table className="data-table quote-log">
        <caption className="visually-hidden">
          Saved quotes for this deal, oldest first
        </caption>
        <thead>
          <tr>
            <th scope="col" className="col-select">
              <span className="visually-hidden">Include in client email</span>
            </th>
            <th scope="col" className="col-secondary">
              Date added
            </th>
            <th scope="col">Lender</th>
            <th scope="col" className="num col-tertiary">
              Finance amount
            </th>
            <th scope="col" className="col-tertiary">
              Asset
            </th>
            <th scope="col" className="num">
              Term
            </th>
            <th scope="col">Payment</th>
            <th scope="col">Type</th>
            <th scope="col" className="num">
              Residual
            </th>
            {optional.base && (
              <th scope="col" className="num">
                Base rate
              </th>
            )}
            {optional.comparison && (
              <th scope="col" className="num">
                Comparison
              </th>
            )}
            <th scope="col" className="num col-secondary">
              Lender fee
            </th>
            <th scope="col" className="num col-secondary">
              Origination
            </th>
            <th scope="col" className="num col-secondary">
              Monthly fee
            </th>
            {optional.commission && (
              <th scope="col" className="num">
                Commission
              </th>
            )}
            {optional.hiring && (
              <th scope="col" className="num">
                Total hiring
              </th>
            )}
            <th scope="col" className="col-tertiary">
              Notes
            </th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {quotes.map((quote) => {
            const open = expanded.has(quote.id);
            const title = signatureTitle(quote);
            return (
              <Fragment key={quote.id}>
                <tr className={open ? 'expanded' : undefined}>
                  <td className="col-select">
                    <input
                      type="checkbox"
                      aria-label={`Include ${title} in client email`}
                      checked={selected.has(quote.id)}
                      onChange={() => onToggleSelected(quote.id)}
                    />
                  </td>
                  <td className="col-secondary nowrap">
                    {formatDate(quote.createdAt)}
                  </td>
                  <td>
                    <strong>{quote.lenderName}</strong>
                    <span className="muted small block">
                      {quote.feeSignatureName}
                    </span>
                  </td>
                  <td className="num col-tertiary">
                    {formatMoney(quote.financeAmount)}
                  </td>
                  <td className="col-tertiary">
                    {quote.assetDescription || '—'}
                  </td>
                  <td className="num nowrap">{quote.termMonths} mo</td>
                  <td>
                    <Repayments quote={quote} display={display} />
                  </td>
                  <td>{paymentTimingLabel(quote)}</td>
                  <td className="num">
                    {formatResidual(quote.balloon, quote.financeAmount)}
                  </td>
                  {optional.base && (
                    <td className="num">{formatRate(quote.baseRate)}</td>
                  )}
                  {optional.comparison && (
                    <td className="num">
                      {quote.comparisonRate === null
                        ? '—'
                        : formatRate(quote.comparisonRate)}
                    </td>
                  )}
                  <td className="num col-secondary">
                    {formatMoney(quote.lenderFee)}
                  </td>
                  <td className="num col-secondary">
                    {formatMoney(quote.originationFee)}
                  </td>
                  <td className="num col-secondary">
                    {formatMoney(quote.monthlyFee)}
                  </td>
                  {optional.commission && (
                    <td className="num">{commissionDisplay(quote)}</td>
                  )}
                  {optional.hiring && (
                    <td className="num">{formatMoney(quote.totalHiring)}</td>
                  )}
                  <td className="col-tertiary notes-cell">
                    <button
                      type="button"
                      className="link-button"
                      aria-label={`Edit notes for ${title}`}
                      onClick={() => toggle(quote.id, true)}
                    >
                      {drafts[quote.id] !== undefined &&
                      drafts[quote.id] !== quote.notes
                        ? 'Unsaved note…'
                        : quote.notes.trim() === ''
                          ? 'Add note'
                          : quote.notes}
                    </button>
                  </td>
                  <td className="actions nowrap">
                    <button
                      type="button"
                      className="icon-button"
                      aria-expanded={open}
                      aria-label={`${open ? 'Hide' : 'Show'} details for ${title}`}
                      onClick={() => toggle(quote.id)}
                    >
                      {open ? '▾' : '▸'}
                    </button>
                    <button
                      type="button"
                      className="icon-button danger"
                      aria-label={`Delete quote ${title}`}
                      onClick={() => {
                        setDeleteError(undefined);
                        setConfirmDelete(quote);
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
                {open && (
                  <tr className="detail-row">
                    <td colSpan={columnCount}>
                      <div className="detail-grid">
                        <dl className="details">
                          <Detail
                            label="Date added"
                            value={formatDate(quote.createdAt)}
                          />
                          <Detail
                            label="Finance amount"
                            value={formatMoney(quote.financeAmount)}
                          />
                          <Detail
                            label="Asset"
                            value={quote.assetDescription || '—'}
                          />
                          <Detail
                            label="Term"
                            value={formatTerm(quote.termMonths)}
                          />
                          <Detail
                            label="Payment type"
                            value={paymentTimingLabel(quote)}
                          />
                          <Detail
                            label="Interest"
                            value={
                              quote.interestMethod === 'daily'
                                ? 'Daily (actual/365)'
                                : 'Monthly'
                            }
                          />
                          <Detail
                            label="Residual"
                            value={formatResidual(
                              quote.balloon,
                              quote.financeAmount,
                            )}
                          />
                          <Detail
                            label="Base rate"
                            value={formatRate(quote.baseRate)}
                          />
                          {quote.contractRate !== null && (
                            <Detail
                              label="Contract rate"
                              value={formatRate(quote.contractRate)}
                            />
                          )}
                          <Detail
                            label="Comparison rate"
                            value={
                              quote.comparisonRate === null
                                ? '—'
                                : formatRate(quote.comparisonRate)
                            }
                          />
                          <Detail
                            label="Lender fee"
                            value={formatMoney(quote.lenderFee)}
                          />
                          <Detail
                            label="Origination fee"
                            value={formatMoney(quote.originationFee)}
                          />
                          <Detail
                            label="Payable at settlement"
                            value={formatMoney(quote.upfrontFees)}
                          />
                          <Detail
                            label="Monthly fee"
                            value={formatMoney(quote.monthlyFee)}
                          />
                          <Detail
                            label="Net amount financed"
                            value={formatMoney(quote.netAmountFinanced)}
                          />
                          <Detail
                            label="Amount financed"
                            value={formatMoney(quote.amountFinanced)}
                          />
                          <Detail
                            label="Commission"
                            value={`${commissionDisplay(quote)} · ${commissionBasis(quote.commissionModel)}`}
                          />
                          <Detail
                            label="Total hiring"
                            value={formatMoney(quote.totalHiring)}
                          />
                        </dl>
                        <NotesEditor
                          quote={quote}
                          draft={drafts[quote.id]}
                          onDraftChange={(draft) =>
                            onDraftsChange((current) => {
                              const next = { ...current };
                              if (draft === undefined) delete next[quote.id];
                              else next[quote.id] = draft;
                              return next;
                            })
                          }
                          onSaved={onQuoteChanged}
                          autoFocus={focusNotes === quote.id}
                        />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {confirmDelete && (
        <ConfirmDialog
          title="Delete this quote?"
          confirmLabel="Delete quote"
          busy={deleting}
          onCancel={() => setConfirmDelete(undefined)}
          onConfirm={() => void remove(confirmDelete)}
        >
          <p>
            {signatureTitle(confirmDelete)} —{' '}
            {formatMoney(confirmDelete.grossMonthlyPayment)}/month over{' '}
            {formatTerm(confirmDelete.termMonths)}. This cannot be undone.
          </p>
          {deleteError && (
            <ErrorNotice error={deleteError} context="Not deleted." />
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
