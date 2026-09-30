import { useCallback, useRef, useState } from 'react';
import type {
  ApiFailure,
  ApiResult,
  DealDto,
  DisplayOptions,
  FeeSignatureDto,
  LenderDto,
  QuoteDto,
} from '@swyft/contracts';
import { useBridge } from '../lib/bridge';
import { useResource } from '../lib/use-resource';
import { ClientEmail } from '../quotes/client-email';
import { DisplayToolbar } from '../quotes/display-toolbar';
import { QuoteBuilder } from '../quotes/quote-builder';
import { QuoteCompare } from '../quotes/quote-compare';
import { QuoteLog } from '../quotes/quote-log';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { ErrorNotice, LoadingRows } from '../ui/notice';

type Tab = 'build' | 'saved' | 'email';
type SavedLayout = 'list' | 'compare';

const noQuotes = async (): Promise<ApiResult<readonly QuoteDto[]>> => ({
  ok: true,
  data: [],
});

/**
 * The quote calculator and, when a deal is chosen, that deal's workspace: build quotes,
 * review and compare what is saved, and prepare the client email. The calculator works
 * without a deal (brief: "Core Calculator"); a deal is where "Add quote to log" saves
 * (brief: Deal → Quote Log → Quote). Saved quotes are server data; changes appear only
 * after the API confirms.
 */
export function DealWorkspace({
  deal,
  signatures,
  lenders,
  display,
  onDisplayChange,
  onDealChanged,
  onDealCreated,
  onDealDeleted,
}: {
  /** The deal quotes are saved to; `undefined` until the broker chooses or names one. */
  readonly deal: DealDto | undefined;
  readonly signatures: readonly FeeSignatureDto[];
  readonly lenders: readonly LenderDto[];
  readonly display: DisplayOptions;
  readonly onDisplayChange: (next: DisplayOptions) => void;
  readonly onDealChanged: (deal: DealDto) => void;
  /** A deal named from the calculator while adding a quote. */
  readonly onDealCreated: (deal: DealDto) => void;
  readonly onDealDeleted: (dealId: string) => void;
}): React.JSX.Element {
  const bridge = useBridge();
  const [tab, setTab] = useState<Tab>('build');
  const [layout, setLayout] = useState<SavedLayout>('list');
  const dealId = deal?.id;
  /** The open deal now, for saves that finish after the broker switched deals. */
  const openDealId = useRef(dealId);
  openDealId.current = dealId;
  const load = useCallback(
    () => (dealId ? bridge.quotes.list(dealId) : noQuotes()),
    [bridge, dealId],
  );
  const { resource, reload, update } = useResource(load, dealId ?? 'none');
  const quotes = resource.data ?? [];
  /** Quotes excluded from the client email; new quotes are included by default. */
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [noteDrafts, setNoteDrafts] = useState<
    Readonly<Record<string, string>>
  >({});
  const [renaming, setRenaming] = useState(false);
  const [confirm, setConfirm] = useState<'clear' | 'delete-deal'>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<ApiFailure>();

  // Per-deal state resets while rendering the new deal (not in an effect, which could
  // run after the broker's next click); the builder keeps what is being typed.
  const [stateDealId, setStateDealId] = useState(dealId);
  if (stateDealId !== dealId) {
    setStateDealId(dealId);
    if (!dealId) setTab('build');
    setExcluded(new Set());
    setNoteDrafts({});
    setRenaming(false);
    setConfirm(undefined);
    setActionError(undefined);
  }

  const selected = new Set(
    quotes.filter((q) => !excluded.has(q.id)).map((q) => q.id),
  );
  const selectedQuotes = quotes.filter((quote) => selected.has(quote.id));

  const knownCount = resource.data ? quotes.length : (deal?.quoteCount ?? 0);

  const countChanged = (target: DealDto, quoteCount: number) =>
    onDealChanged({
      ...target,
      quoteCount,
      updatedAt: new Date().toISOString(),
    });

  const onSaved = (quote: QuoteDto, target: DealDto) => {
    if (target.id === openDealId.current) {
      update((current) => [...current, quote]);
      countChanged(target, knownCount + 1);
    } else {
      // A deal just named from the calculator, or one the broker has since left: its
      // quote log is loaded from the server when it is opened.
      countChanged(target, target.quoteCount + 1);
    }
  };

  const onDeleted = (quoteId: string) => {
    update((current) => current.filter((quote) => quote.id !== quoteId));
    if (deal) countChanged(deal, Math.max(0, knownCount - 1));
  };

  const runConfirmed = async () => {
    if (!deal) return;
    setBusy(true);
    setActionError(undefined);
    if (confirm === 'clear') {
      const result = await bridge.quotes.clear(deal.id);
      setBusy(false);
      if (!result.ok) return setActionError(result.error);
      update(() => []);
      countChanged(deal, 0);
    } else {
      const result = await bridge.deals.remove(deal.id);
      setBusy(false);
      if (!result.ok && result.error.kind !== 'not-found')
        return setActionError(result.error);
      onDealDeleted(deal.id);
    }
    setConfirm(undefined);
  };

  const tabs: ReadonlyArray<readonly [Tab, string]> = [
    ['build', 'Quote builder'],
    ['saved', deal ? `Quote log (${knownCount})` : 'Quote log'],
    ['email', 'Client email'],
  ];
  // The quote log and the client email belong to a deal.
  const available = (id: Tab) => id === 'build' || deal !== undefined;

  return (
    <div className="workspace">
      <header className="workspace-header">
        {!deal ? (
          <div>
            <p className="eyebrow">Quote calculator</p>
            <h2>New quote</h2>
            <p className="muted small">
              Enter the loan details and choose a lender to see the repayment.
              To keep quotes, open a deal from the list or name one when you add
              a quote to the log.
            </p>
          </div>
        ) : renaming ? (
          <RenameDeal
            deal={deal}
            onCancel={() => setRenaming(false)}
            onRenamed={(renamed) => {
              setRenaming(false);
              onDealChanged(renamed);
            }}
          />
        ) : (
          <>
            <div>
              <p className="eyebrow">Deal</p>
              <h2>{deal.name}</h2>
            </div>
            <div className="header-actions">
              <button
                type="button"
                className="button secondary small"
                onClick={() => setRenaming(true)}
              >
                Rename
              </button>
              <button
                type="button"
                className="button secondary small danger-text"
                onClick={() => {
                  setActionError(undefined);
                  setConfirm('delete-deal');
                }}
              >
                Delete deal
              </button>
            </div>
          </>
        )}
      </header>

      <div role="tablist" aria-label="Deal workspace" className="tabs">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            id={`tab-${id}`}
            role="tab"
            type="button"
            aria-selected={tab === id}
            // Only the selected tab's panel is rendered for Quote log / Client email.
            aria-controls={tab === id ? `panel-${id}` : undefined}
            tabIndex={tab === id ? 0 : -1}
            className="tab"
            disabled={!available(id)}
            title={
              available(id)
                ? undefined
                : 'Open or name a deal to keep a quote log'
            }
            onClick={() => setTab(id)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')
                return;
              const index = tabs.findIndex(([key]) => key === id);
              const step = event.key === 'ArrowRight' ? 1 : -1;
              const next = tabs[(index + step + tabs.length) % tabs.length];
              if (next && available(next[0])) {
                setTab(next[0]);
                document.getElementById(`tab-${next[0]}`)?.focus();
              }
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* The builder stays mounted while hidden so an in-progress quote survives a
          look at the saved quotes. */}
      <div
        id="panel-build"
        role="tabpanel"
        aria-labelledby="tab-build"
        className="tab-panel"
        hidden={tab !== 'build'}
      >
        <QuoteBuilder
          deal={deal}
          signatures={signatures}
          lenders={lenders}
          display={display}
          onSaved={onSaved}
          onDealCreated={onDealCreated}
          onViewSaved={() => setTab('saved')}
        />
      </div>

      <div
        id={`panel-${tab === 'build' ? 'saved' : tab}`}
        role="tabpanel"
        aria-labelledby={`tab-${tab === 'build' ? 'saved' : tab}`}
        className="tab-panel"
        hidden={tab === 'build'}
      >
        {tab !== 'build' && (
          <>
            {resource.status === 'error' && (
              <ErrorNotice
                error={resource.error}
                context={
                  resource.data
                    ? 'Showing the last loaded quotes; they may be out of date.'
                    : 'The quote log could not be loaded.'
                }
                onRetry={reload}
              />
            )}
            {resource.status === 'loading' && !resource.data && (
              <LoadingRows label="Loading saved quotes…" />
            )}
            {resource.data && quotes.length === 0 && (
              <p className="empty-state">
                No quotes saved for this deal yet. Build one in the{' '}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setTab('build')}
                >
                  Quote builder
                </button>{' '}
                and choose <strong>Add quote to log</strong>.
              </p>
            )}
            {resource.data && quotes.length > 0 && (
              <>
                <DisplayToolbar display={display} onChange={onDisplayChange} />
                {tab === 'saved' && (
                  <>
                    <div className="saved-toolbar">
                      <div
                        role="group"
                        aria-label="Layout"
                        className="segmented"
                      >
                        <button
                          type="button"
                          aria-pressed={layout === 'list'}
                          onClick={() => setLayout('list')}
                        >
                          Table
                        </button>
                        <button
                          type="button"
                          aria-pressed={layout === 'compare'}
                          onClick={() => setLayout('compare')}
                        >
                          Compare side by side
                        </button>
                      </div>
                      <button
                        type="button"
                        className="button secondary small danger-text"
                        onClick={() => {
                          setActionError(undefined);
                          setConfirm('clear');
                        }}
                      >
                        Clear all quotes
                      </button>
                    </div>
                    {layout === 'list' ? (
                      <QuoteLog
                        quotes={quotes}
                        display={display}
                        selected={selected}
                        onToggleSelected={(id) =>
                          setExcluded((current) => {
                            const next = new Set(current);
                            if (next.has(id)) next.delete(id);
                            else next.add(id);
                            return next;
                          })
                        }
                        onQuoteChanged={(changed) =>
                          update((current) =>
                            current.map((quote) =>
                              quote.id === changed.id ? changed : quote,
                            ),
                          )
                        }
                        onQuoteDeleted={onDeleted}
                        drafts={noteDrafts}
                        onDraftsChange={setNoteDrafts}
                      />
                    ) : (
                      <QuoteCompare quotes={quotes} display={display} />
                    )}
                  </>
                )}
                {tab === 'email' && (
                  <ClientEmail quotes={selectedQuotes} display={display} />
                )}
              </>
            )}
          </>
        )}
      </div>

      {confirm && deal && (
        <ConfirmDialog
          title={
            confirm === 'clear' ? 'Clear all quotes?' : 'Delete this deal?'
          }
          confirmLabel={
            confirm === 'clear' ? 'Clear all quotes' : 'Delete deal'
          }
          busy={busy}
          onCancel={() => setConfirm(undefined)}
          onConfirm={() => void runConfirmed()}
        >
          <p>
            {confirm === 'clear'
              ? `All ${quotes.length} saved quotes in “${deal.name}” will be permanently deleted. Other deals are not affected.`
              : `“${deal.name}” and all of its saved quotes will be permanently deleted.`}
          </p>
          {actionError && (
            <ErrorNotice error={actionError} context="Nothing was deleted." />
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}

function RenameDeal({
  deal,
  onCancel,
  onRenamed,
}: {
  readonly deal: DealDto;
  readonly onCancel: () => void;
  readonly onRenamed: (deal: DealDto) => void;
}): React.JSX.Element {
  const bridge = useBridge();
  const [name, setName] = useState(deal.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiFailure>();
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (name.trim() === '')
      return setError({ kind: 'validation', message: 'Enter a deal name.' });
    setSaving(true);
    const result = await bridge.deals.rename(deal.id, name);
    setSaving(false);
    if (result.ok) onRenamed(result.data);
    else setError(result.error);
  };
  return (
    <form className="rename-form" onSubmit={(event) => void submit(event)}>
      <label htmlFor="rename-deal" className="visually-hidden">
        Deal name
      </label>
      <input
        id="rename-deal"
        value={name}
        maxLength={200}
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => event.key === 'Escape' && onCancel()}
        aria-invalid={error ? true : undefined}
      />
      <button type="submit" className="button primary small" disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button
        type="button"
        className="button secondary small"
        onClick={onCancel}
      >
        Cancel
      </button>
      {error && <span className="field-error">{error.message}</span>}
    </form>
  );
}
