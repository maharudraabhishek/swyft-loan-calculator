import { useEffect, useMemo, useState } from 'react';
import type { ApiFailure, DisplayOptions, QuoteDto } from '@swyft/contracts';
import { buildExportGroups } from '../../../shared/quote-export';
import { useBridge } from '../lib/bridge';
import { ErrorNotice } from '../ui/notice';

type CopyState =
  | { readonly status: 'idle' }
  | { readonly status: 'copying' }
  | { readonly status: 'copied'; readonly count: number }
  | { readonly status: 'failed'; readonly error: ApiFailure };

/**
 * The client email: an on-screen preview built from the same export model Main uses for
 * the clipboard, and the copy action. Main regenerates and escapes the HTML itself.
 */
export function ClientEmail({
  quotes,
  display,
}: {
  readonly quotes: readonly QuoteDto[];
  readonly display: DisplayOptions;
}): React.JSX.Element {
  const bridge = useBridge();
  const [state, setState] = useState<CopyState>({ status: 'idle' });
  const groups = useMemo(
    () => buildExportGroups(quotes, display),
    [quotes, display],
  );

  // "Copied" describes what is on the clipboard; any change to the content clears it.
  const contentKey = JSON.stringify([quotes.map((quote) => quote.id), display]);
  useEffect(() => setState({ status: 'idle' }), [contentKey]);

  const copy = async () => {
    setState({ status: 'copying' });
    const result = await bridge.quotes.copyExport({ quotes, display });
    setState(
      result.ok
        ? { status: 'copied', count: result.data.quoteCount }
        : { status: 'failed', error: result.error },
    );
  };

  if (quotes.length === 0)
    return (
      <p className="empty-state">
        Tick at least one saved quote under <strong>Saved quotes</strong> to
        include it in the client email.
      </p>
    );

  return (
    <div className="client-email">
      <div className="email-actions">
        <button
          type="button"
          className="button primary"
          disabled={state.status === 'copying'}
          onClick={() => void copy()}
        >
          {state.status === 'copying' ? 'Copying…' : 'Copy quote to clipboard'}
        </button>
        <span role="status" aria-live="polite" className="small">
          {state.status === 'copied' && (
            <span className="success">
              Copied {state.count} {state.count === 1 ? 'quote' : 'quotes'} as
              formatted tables and plain text — paste into Gmail or Outlook.
            </span>
          )}
        </span>
      </div>
      {state.status === 'failed' && (
        <ErrorNotice error={state.error} context="Nothing was copied." />
      )}
      <p className="muted small">
        {display.showCommission
          ? 'Commissions are shown. Turn off “Commissions” for client-facing emails.'
          : 'Commissions are hidden from this email.'}
      </p>
      <div className="email-preview" aria-label="Client email preview">
        {groups.map((group, groupIndex) => (
          <div key={groupIndex} className="email-group">
            <table className="email-table strong">
              <tbody>
                {group.header.map((line) => (
                  <tr key={line.label}>
                    <th scope="row">{line.label}</th>
                    <td>{line.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {group.options.map((option) => (
              <div key={option.quoteId} className="email-option">
                <table className="email-table">
                  <tbody>
                    {option.rows.map((line) => (
                      <tr key={line.label}>
                        <th scope="row">{line.label}</th>
                        <td>{line.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {option.footer.map((line) => (
                  <p key={line.label} className="email-footer">
                    <strong>{line.label}:</strong> {line.value}
                  </p>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
