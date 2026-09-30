import { useCallback, useEffect, useState } from 'react';
import type { DealDto, DealPageDto } from '@swyft/contracts';
import { DealSidebar } from '../deals/deal-sidebar';
import { DealWorkspace } from '../deals/deal-workspace';
import { LenderLibrary } from '../lenders/lender-library';
import { useBridge } from '../lib/bridge';
import { useDisplayOptions } from '../lib/display-options';
import { useOnline } from '../lib/use-online';
import { useResource } from '../lib/use-resource';
import { ErrorBoundary, ErrorNotice } from '../ui/notice';
import { UpdateNotice } from './update-notice';

type View = 'deals' | 'lenders';

const narrowQuery = '(max-width: 899px)';

/** True below the width where the deal list becomes a drawer (matches styles.css). */
function useNarrowWindow(): boolean {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.(narrowQuery).matches ?? false,
  );
  useEffect(() => {
    const query = window.matchMedia?.(narrowQuery);
    if (!query) return undefined;
    const onChange = () => setNarrow(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

/** Who is signed in, for the header. */
export interface SignedInUser {
  readonly email: string;
  readonly displayName: string | null;
}

/**
 * The signed-in product: header (navigation, account, sign out), the deal list and the
 * open deal's workspace, or the lender library. Deals and fee signatures are loaded once
 * here because both the sidebar and the workspace depend on them.
 */
export function Shell({
  user,
  onSignOut,
}: {
  readonly user: SignedInUser;
  readonly onSignOut: () => Promise<void>;
}): React.JSX.Element {
  const bridge = useBridge();
  const online = useOnline();
  const [view, setView] = useState<View>('deals');
  const [selectedId, setSelectedId] = useState<string>();
  const narrow = useNarrowWindow();
  const [sidebarOpen, setSidebarOpen] = useState(() => !narrow);
  // Wide windows show the deal list beside the workspace; narrow ones use it as a drawer.
  useEffect(() => setSidebarOpen(!narrow), [narrow]);
  const [signingOut, setSigningOut] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [display, setDisplay] = useDisplayOptions();
  const [newDealRequest, setNewDealRequest] = useState(0);

  // Application menu and keyboard shortcuts (File → New Deal, View → Calculator, ...).
  useEffect(
    () =>
      bridge.menu.onCommand((command) => {
        switch (command) {
          case 'new-deal':
            setSidebarOpen(true);
            setNewDealRequest((count) => count + 1);
            break;
          case 'show-calculator':
            setView('deals');
            break;
          case 'show-lenders':
            setView('lenders');
            break;
          case 'toggle-deal-list':
            setSidebarOpen((open) => !open);
            break;
        }
      }),
    [bridge],
  );

  const loadDeals = useCallback(() => bridge.deals.list(), [bridge]);
  const deals = useResource<DealPageDto>(loadDeals, 'deals');
  const loadSignatures = useCallback(
    () => bridge.lenders.listSignatures(),
    [bridge],
  );
  const signatures = useResource(loadSignatures, 'signatures');
  const loadLenders = useCallback(() => bridge.lenders.listLenders(), [bridge]);
  const lenders = useResource(loadLenders, 'lenders');

  const selected = deals.resource.data?.items.find(
    (deal) => deal.id === selectedId,
  );

  const replaceDeal = (changed: DealDto) =>
    deals.update((page) => ({
      ...page,
      items: page.items.map((deal) =>
        deal.id === changed.id ? changed : deal,
      ),
    }));

  const loadMore = async () => {
    const cursor = deals.resource.data?.nextCursor;
    if (!cursor) return;
    setLoadingMore(true);
    const result = await bridge.deals.list(cursor);
    setLoadingMore(false);
    if (result.ok)
      deals.update((page) => ({
        items: [
          ...page.items,
          ...result.data.items.filter(
            (deal) => !page.items.some((known) => known.id === deal.id),
          ),
        ],
        nextCursor: result.data.nextCursor,
      }));
  };

  const signOut = async () => {
    setSigningOut(true);
    try {
      await onSignOut();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <button
          type="button"
          className="icon-button on-dark"
          aria-expanded={sidebarOpen}
          aria-controls="deal-sidebar"
          aria-label={sidebarOpen ? 'Hide deal list' : 'Show deal list'}
          onClick={() => setSidebarOpen((open) => !open)}
        >
          ☰
        </button>
        <span className="brand">Swyft Finance</span>
        <nav aria-label="Main" className="main-nav">
          <button
            type="button"
            aria-current={view === 'deals' ? 'page' : undefined}
            onClick={() => setView('deals')}
          >
            Calculator
          </button>
          <button
            type="button"
            aria-current={view === 'lenders' ? 'page' : undefined}
            onClick={() => setView('lenders')}
          >
            Lenders
          </button>
        </nav>
        <div className="account">
          <span className="account-name" title={user.email}>
            {user.displayName ?? user.email}
          </span>
          <button
            type="button"
            className="button ghost small"
            disabled={signingOut}
            onClick={() => void signOut()}
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>

      {!online && (
        <div className="offline-banner" role="status">
          <strong>You&apos;re offline.</strong> Saved deals and quotes
          can&apos;t be loaded or changed until you reconnect. Previews still
          work; nothing is saved offline.
        </div>
      )}
      <UpdateNotice />

      <div className={`app-body${sidebarOpen ? ' with-sidebar' : ''}`}>
        {sidebarOpen && narrow && (
          <div
            className="drawer-scrim"
            aria-hidden="true"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        {sidebarOpen && (
          <div
            id="deal-sidebar"
            className="sidebar-wrap"
            onKeyDown={(event) => {
              if (narrow && event.key === 'Escape') setSidebarOpen(false);
            }}
          >
            <DealSidebar
              deals={deals.resource}
              selectedId={view === 'deals' ? selectedId : undefined}
              onSelect={(deal) => {
                setView('deals');
                setSelectedId(deal.id);
                if (narrow) setSidebarOpen(false);
              }}
              onCreated={(deal) => {
                deals.update((page) => ({
                  ...page,
                  items: [deal, ...page.items],
                }));
                setView('deals');
                setSelectedId(deal.id);
              }}
              onRetry={deals.reload}
              onLoadMore={() => void loadMore()}
              loadingMore={loadingMore}
              newDealRequest={newDealRequest}
            />
          </div>
        )}
        <main className="main" id="main">
          {view === 'lenders' && (
            <ErrorBoundary resetKey="lenders">
              <LenderLibrary
                signatures={signatures.resource}
                lenders={lenders.resource}
                onChanged={signatures.reload}
                onLendersChanged={lenders.reload}
                onRetry={signatures.reload}
              />
            </ErrorBoundary>
          )}
          {/* The calculator is the landing screen and works without a deal (brief:
              "Core Calculator"). A deal only chooses where "Add quote to log" saves.
              It stays mounted across deal changes and the lender library, so values
              being typed, note drafts and email selections survive. */}
          <div hidden={view !== 'deals'}>
            <ErrorBoundary resetKey="calculator">
              {signatures.resource.status === 'error' && (
                <ErrorNotice
                  error={signatures.resource.error}
                  context="Lenders could not be loaded."
                  onRetry={signatures.reload}
                />
              )}
              {signatures.resource.data ? (
                <DealWorkspace
                  deal={selected}
                  signatures={signatures.resource.data}
                  lenders={lenders.resource.data ?? []}
                  display={display}
                  onDisplayChange={setDisplay}
                  onDealChanged={replaceDeal}
                  onDealCreated={(deal) => {
                    deals.update((page) => ({
                      ...page,
                      items: [deal, ...page.items],
                    }));
                    setSelectedId(deal.id);
                  }}
                  onDealDeleted={(dealId) => {
                    deals.update((page) => ({
                      ...page,
                      items: page.items.filter((deal) => deal.id !== dealId),
                    }));
                    setSelectedId(undefined);
                  }}
                />
              ) : (
                signatures.resource.status === 'loading' && (
                  <p className="muted" role="status">
                    Loading lenders…
                  </p>
                )
              )}
            </ErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}
