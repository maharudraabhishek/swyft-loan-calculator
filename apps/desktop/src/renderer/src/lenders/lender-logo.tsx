import { useEffect, useState } from 'react';
import type { DesktopBridge, LenderDto } from '@swyft/contracts';
import { useBridge } from '../lib/bridge';

/**
 * Logos are fetched through Main (the API requires the session token) and cached for the
 * session by lender and logo version, so a replaced logo is fetched again.
 */
const cache = new Map<string, Promise<string | undefined>>();

function loadLogo(
  bridge: DesktopBridge,
  lender: Pick<LenderDto, 'id' | 'logoUpdatedAt'>,
): Promise<string | undefined> {
  const key = `${lender.id}:${lender.logoUpdatedAt ?? ''}`;
  let pending = cache.get(key);
  if (pending === undefined) {
    pending = bridge.lenders
      .logo(lender.id)
      .then((result) => (result.ok ? result.data.dataUrl : undefined))
      .catch(() => undefined);
    // A failed load is retried on the next render rather than cached forever.
    void pending.then((url) => {
      if (url === undefined) cache.delete(key);
    });
    cache.set(key, pending);
  }
  return pending;
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

/**
 * A lender's logo (downloaded through Main and the API, shown as a data URL) or, when
 * there is none, a badge with the lender's initials. Logos are cached per lender and
 * logo version, so each is downloaded once.
 */
export function LenderLogo({
  lender,
  size = 28,
}: {
  readonly lender: Pick<LenderDto, 'id' | 'name' | 'hasLogo' | 'logoUpdatedAt'>;
  readonly size?: 28 | 40;
}): React.JSX.Element {
  const bridge = useBridge();
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let current = true;
    setUrl(undefined);
    if (lender.hasLogo)
      void loadLogo(bridge, lender).then((loaded) => {
        if (current) setUrl(loaded);
      });
    return () => {
      current = false;
    };
  }, [bridge, lender]);
  return url ? (
    <img
      className={`lender-logo size-${size}`}
      src={url}
      alt={`${lender.name} logo`}
    />
  ) : (
    <span className={`lender-logo fallback size-${size}`} aria-hidden="true">
      {initials(lender.name)}
    </span>
  );
}
