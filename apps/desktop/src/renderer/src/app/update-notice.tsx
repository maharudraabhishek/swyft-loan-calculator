import { useEffect, useState } from 'react';
import type { UpdateStatus } from '@swyft/contracts';
import { useBridge } from '../lib/bridge';

/**
 * Tells the broker a new version has been downloaded. Nothing restarts on its own: they
 * choose when, or the update installs the next time they close the app.
 */
export function UpdateNotice(): React.JSX.Element | null {
  const bridge = useBridge();
  const [status, setStatus] = useState<UpdateStatus>({ state: 'none' });
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    let active = true;
    const unsubscribe = bridge.updates.onStatus(setStatus);
    // The download may have finished before this screen opened.
    void bridge.updates.getStatus().then((current) => {
      if (active && current.state === 'ready') setStatus(current);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge]);

  if (status.state !== 'ready') return null;
  return (
    <div className="update-banner" role="status">
      <span>
        <strong>Swyft Finance {status.version} is ready to install.</strong>{' '}
        Save the quote you are working on first. If you don&apos;t restart now,
        it installs when you next close the app.
      </span>
      <button
        type="button"
        className="button small"
        disabled={restarting}
        onClick={() => {
          setRestarting(true);
          void bridge.updates.install();
        }}
      >
        {restarting ? 'Restarting…' : 'Restart and update'}
      </button>
    </div>
  );
}
