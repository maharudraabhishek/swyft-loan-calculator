import { useEffect, useState, type ReactNode } from 'react';
import type { AuthStateDto, DesktopAuthBridge } from '@swyft/contracts';

export type AuthView = 'loading' | 'sign-in' | 'offline' | 'app';

/** Which screen to show. Anything but a live session shows only sign-in or status. */
export function authView(state: AuthStateDto | undefined): AuthView {
  switch (state?.status) {
    case 'signed-in':
      return 'app';
    case 'offline':
      return 'offline';
    case 'signed-out':
    case 'signing-in':
      return 'sign-in';
    default:
      return 'loading';
  }
}

function useAuthState(
  auth: DesktopAuthBridge | undefined,
): AuthStateDto | undefined {
  const [state, setState] = useState<AuthStateDto>();
  useEffect(() => {
    if (!auth) return undefined;
    let active = true;
    const unsubscribe = auth.onStateChanged((next) => setState(next));
    void auth.getState().then((current) => {
      if (active) setState((previous) => previous ?? current);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [auth]);
  return state;
}

export interface SessionUser {
  readonly email: string;
  readonly displayName: string | null;
}

/**
 * Shows only the sign-in experience until Main reports a live session; then renders the
 * product with the user's identity and a sign-out action. When the session ends (sign-out
 * or an expired session) the product unmounts, taking all its in-memory data with it.
 */
export function AuthGate({
  auth,
  children,
}: {
  readonly auth: DesktopAuthBridge | undefined;
  readonly children: (
    user: SessionUser,
    signOut: () => Promise<void>,
  ) => ReactNode;
}): React.JSX.Element {
  const state = useAuthState(auth);
  const view = authView(state);

  if (!auth)
    return (
      <div className="auth-screen">
        <p className="notice error">
          The desktop bridge is unavailable. Restart Swyft Finance.
        </p>
      </div>
    );

  if (view === 'app' && state?.user)
    return <>{children(state.user, () => auth.signOut())}</>;

  return (
    <div className="auth-screen">
      <section className="auth-card" aria-live="polite">
        <p className="eyebrow">Swyft Finance</p>
        <h1>Multi-lender quoting</h1>
        {view === 'loading' && <p className="muted">Checking your sign-in…</p>}
        {view === 'offline' && (
          <>
            <p className="notice error">
              {state?.message ??
                'You appear to be offline. Check your connection.'}
            </p>
            <button
              type="button"
              className="button primary"
              onClick={() => void auth.retry()}
            >
              Try again
            </button>
          </>
        )}
        {view === 'sign-in' && (
          <>
            <p className="muted">
              Sign in with your Google account. Your browser will open; return
              here when you are done.
            </p>
            {state?.message && <p className="notice error">{state.message}</p>}
            <button
              type="button"
              className="button primary"
              disabled={state?.status === 'signing-in'}
              onClick={() => void auth.signIn()}
            >
              {state?.status === 'signing-in'
                ? 'Waiting for your browser…'
                : 'Sign in with Google'}
            </button>
            {state?.remembersSession === false && (
              <p className="muted small-print">
                Secure storage is unavailable on this system, so you will need
                to sign in each time the app starts.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
