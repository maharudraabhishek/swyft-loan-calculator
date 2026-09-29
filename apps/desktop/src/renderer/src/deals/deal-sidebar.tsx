import { useState } from 'react';
import type { ApiFailure, DealDto, DealPageDto } from '@swyft/contracts';
import { formatDate } from '../../../shared/format';
import { useBridge } from '../lib/bridge';
import type { Resource } from '../lib/use-resource';
import { ErrorNotice, LoadingRows } from '../ui/notice';

/** Deal list with inline creation. A deal groups every quote for one client/transaction. */
export function DealSidebar({
  deals,
  selectedId,
  onSelect,
  onCreated,
  onRetry,
  onLoadMore,
  loadingMore,
}: {
  readonly deals: Resource<DealPageDto>;
  readonly selectedId: string | undefined;
  readonly onSelect: (deal: DealDto) => void;
  readonly onCreated: (deal: DealDto) => void;
  readonly onRetry: () => void;
  readonly onLoadMore: () => void;
  readonly loadingMore: boolean;
}): React.JSX.Element {
  const bridge = useBridge();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiFailure>();

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (name.trim() === '')
      return setError({
        kind: 'validation',
        message: 'Enter a name for the deal.',
      });
    setSaving(true);
    setError(undefined);
    const result = await bridge.deals.create(name);
    setSaving(false);
    if (!result.ok) return setError(result.error);
    setName('');
    setCreating(false);
    onCreated(result.data);
  };

  const items = deals.data?.items ?? [];
  return (
    <nav className="sidebar" aria-label="Deals">
      <div className="sidebar-header">
        <h2>Deals</h2>
        {!creating && (
          <button
            type="button"
            className="button primary small"
            onClick={() => {
              setCreating(true);
              setError(undefined);
            }}
          >
            New deal
          </button>
        )}
      </div>
      {creating && (
        <form
          className="new-deal"
          onSubmit={(event) => void create(event)}
          noValidate
        >
          <label htmlFor="new-deal-name">Deal name</label>
          <input
            id="new-deal-name"
            value={name}
            maxLength={200}
            autoFocus
            placeholder="e.g. Jones — Ranger ute"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'new-deal-error' : undefined}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && setCreating(false)}
          />
          {error && (
            <p id="new-deal-error" className="field-error">
              {error.message}
            </p>
          )}
          <div className="row">
            <button
              type="submit"
              className="button primary small"
              disabled={saving}
            >
              {saving ? 'Creating…' : 'Create deal'}
            </button>
            <button
              type="button"
              className="button secondary small"
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {deals.status === 'loading' && !deals.data && (
        <LoadingRows label="Loading deals…" />
      )}
      {deals.status === 'error' && (
        <ErrorNotice
          error={deals.error}
          context={
            deals.data
              ? 'Deals may be out of date.'
              : 'Deals could not be loaded.'
          }
          onRetry={onRetry}
        />
      )}
      {deals.data && items.length === 0 && !creating && (
        <p className="empty-state small">
          No deals yet. A deal keeps the quotes for one client or transaction:
          create one here, or name one when you add a quote to the log.
        </p>
      )}
      <ul className="deal-list">
        {items.map((deal) => (
          <li key={deal.id}>
            <button
              type="button"
              className="deal-item"
              aria-current={deal.id === selectedId ? 'page' : undefined}
              onClick={() => onSelect(deal)}
            >
              <span className="deal-name">{deal.name}</span>
              <span className="muted small">
                {deal.quoteCount} {deal.quoteCount === 1 ? 'quote' : 'quotes'} ·{' '}
                {formatDate(deal.updatedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {deals.data?.nextCursor && (
        <button
          type="button"
          className="button secondary small"
          disabled={loadingMore}
          onClick={onLoadMore}
        >
          {loadingMore ? 'Loading…' : 'Load more deals'}
        </button>
      )}
    </nav>
  );
}
