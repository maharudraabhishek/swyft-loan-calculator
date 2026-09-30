import { createContext, useContext, type ReactNode } from 'react';
import type { DesktopBridge } from '@swyft/contracts';

/**
 * The Preload capabilities, provided through context so components never reach for
 * `window` directly and tests can supply a fake bridge.
 */
const BridgeContext = createContext<DesktopBridge | undefined>(undefined);

/** Makes the preload bridge (`window.swyft`, or a test double) available to the UI. */
export function BridgeProvider({
  bridge,
  children,
}: {
  readonly bridge: DesktopBridge;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <BridgeContext.Provider value={bridge}>{children}</BridgeContext.Provider>
  );
}

/** The preload bridge. Components call Main only through this. */
export function useBridge(): DesktopBridge {
  const bridge = useContext(BridgeContext);
  if (bridge === undefined)
    throw new Error('useBridge must be used inside a BridgeProvider');
  return bridge;
}
