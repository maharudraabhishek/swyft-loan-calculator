// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AuthStateDto, DesktopAuthBridge } from '@swyft/contracts';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthGate, authView } from './auth-gate';

function fakeAuth(initial: AuthStateDto) {
  let listener: ((state: AuthStateDto) => void) | undefined;
  const auth: DesktopAuthBridge = {
    getState: vi.fn(async () => initial),
    signIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () =>
      listener?.({ status: 'signed-out', remembersSession: true }),
    ),
    retry: vi.fn(async () => undefined),
    onStateChanged: (next) => {
      listener = next;
      return () => undefined;
    },
  };
  return { auth, push: (state: AuthStateDto) => act(() => listener?.(state)) };
}

const signedIn: AuthStateDto = {
  status: 'signed-in',
  user: { email: 'broker@example.test', displayName: 'Broker' },
  remembersSession: true,
};

afterEach(cleanup);

describe('AuthGate', () => {
  it('maps every non-live state away from the product', () => {
    expect(authView(undefined)).toBe('loading');
    expect(authView({ status: 'restoring', remembersSession: true })).toBe(
      'loading',
    );
    expect(authView({ status: 'signing-in', remembersSession: true })).toBe(
      'sign-in',
    );
    expect(authView({ status: 'offline', remembersSession: true })).toBe(
      'offline',
    );
    expect(authView(signedIn)).toBe('app');
  });

  it('shows only sign-in while signed out', async () => {
    const { auth } = fakeAuth({ status: 'signed-out', remembersSession: true });
    const product = vi.fn(() => <p>Deals</p>);
    render(<AuthGate auth={auth}>{product}</AuthGate>);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Sign in with Google' }),
    );
    expect(auth.signIn).toHaveBeenCalled();
    expect(screen.queryByText('Deals')).toBeNull();
    expect(product).not.toHaveBeenCalled();
  });

  it('renders the product for a live session and removes it on sign-out', async () => {
    const { auth } = fakeAuth(signedIn);
    render(
      <AuthGate auth={auth}>
        {(user, signOut) => (
          <button type="button" onClick={() => void signOut()}>
            Sign out {user.email}
          </button>
        )}
      </AuthGate>,
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Sign out broker@example.test/,
      }),
    );
    expect(auth.signOut).toHaveBeenCalled();
    expect(
      await screen.findByRole('button', { name: 'Sign in with Google' }),
    ).toBeTruthy();
    expect(screen.queryByText(/Sign out/)).toBeNull();
  });

  it('leaves the product when the session expires elsewhere', async () => {
    const { auth, push } = fakeAuth(signedIn);
    render(<AuthGate auth={auth}>{() => <p>Deals</p>}</AuthGate>);
    expect(await screen.findByText('Deals')).toBeTruthy();
    push({
      status: 'signed-out',
      message: 'Your session has ended. Sign in again.',
      remembersSession: true,
    });
    expect(
      await screen.findByText('Your session has ended. Sign in again.'),
    ).toBeTruthy();
    expect(screen.queryByText('Deals')).toBeNull();
  });

  it('offers retry when offline at startup', async () => {
    const { auth } = fakeAuth({
      status: 'offline',
      message: 'You appear to be offline.',
      remembersSession: true,
    });
    render(<AuthGate auth={auth}>{() => <p>Deals</p>}</AuthGate>);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(auth.retry).toHaveBeenCalled();
  });
});
