// @vitest-environment jsdom
/**
 * Real-stack broker workflow. Nothing here is simulated except what cannot exist in a
 * headless test process:
 *
 * - API: the production `createApplication` on a real TCP port, over a freshly migrated
 *   PostgreSQL (the `postgres-test` container) queried as the least-privilege runtime role
 *   with row-level security. Sign-in uses the API's development identity provider
 *   (production uses Google through Identity Platform; that path is verified by
 *   `cloud-smoke.mjs` and `auth-e2e.mjs`). Logos use the API's in-memory storage adapter
 *   (Cloud Storage is verified by `cloud-smoke.mjs`).
 * - Desktop Main: the real AuthSessionManager, loopback receiver, PKCE exchange, API
 *   client, IPC handlers, zod validation, preview engine and export builder.
 * - Renderer: the real AuthGate and Shell in jsdom.
 * - Replaced only: Electron's IPC transport (handlers are called directly with cloned
 *   arguments), the OS clipboard (the written HTML/text is captured), the OS file dialog
 *   (returns a real PNG) and OS secure storage (reported unavailable, a supported mode).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { DesktopAuthBridge, QuoteDto } from '@swyft/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  pngBytes,
  signIn as apiSignIn,
  uniqueEmail,
  type TestApp,
} from '../../../../api/test/db/support';
import type { TestDatabase } from '../../../../api/test/db/global-setup';
import { BusinessApiClient } from '../../main/api/business-api';
import { AuthApiClient } from '../../main/auth/api-client';
import { startLoopbackReceiver } from '../../main/auth/loopback';
import { AuthSessionManager } from '../../main/auth/session-manager';
import { SecureSessionStore } from '../../main/auth/session-store';
import { createBusinessHandlers } from '../../main/ipc/business-handlers';
import {
  AuthStateRelay,
  bridgeFromHandlers,
} from '../../test-support/handler-bridge';
import { Shell } from './app/shell';
import { AuthGate } from './auth-gate';
import { BridgeProvider } from './lib/bridge';

// Keeps the global-setup type augmentation (the injected test database) in scope.
export type { TestDatabase };

const slow = { timeout: 15_000 };
const brokerEmail = uniqueEmail('broker');

let testApp: TestApp;
let baseUrl: string;
let manager: AuthSessionManager;
let api: BusinessApiClient;
let clipboard: { html: string; text: string } | undefined;

/** What the system browser does: follow the login redirect, consent, return to the app. */
async function completeBrowserSignIn(loginUrl: string): Promise<void> {
  const login = await fetch(loginUrl, { redirect: 'manual' });
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const consent = new URL(login.headers.get('location') ?? '', loginUrl);
  const callback = new URL('/v1/auth/callback', baseUrl);
  callback.searchParams.set(
    'dev_session',
    consent.searchParams.get('session') ?? '',
  );
  callback.searchParams.set('email', brokerEmail);
  const back = await fetch(callback, {
    redirect: 'manual',
    headers: { cookie },
  });
  // The API redirects the browser to the desktop's loopback receiver.
  await fetch(back.headers.get('location') ?? '');
}

function field(label: string | RegExp): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}
function type(label: string | RegExp, value: string): void {
  fireEvent.change(field(label), { target: { value } });
}
function chooseLender(title: string): void {
  const select = screen.getByLabelText(
    'Lender and fee signature',
  ) as HTMLSelectElement;
  const option = Array.from(select.options).find(
    (item) => item.textContent === title,
  );
  if (!option) throw new Error(`No lender option ${title}`);
  fireEvent.change(select, { target: { value: option.value } });
}
async function savedQuotes(dealId: string): Promise<readonly QuoteDto[]> {
  return api.listQuotes(dealId);
}

beforeAll(async () => {
  testApp = await createTestApp();
  await testApp.app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = testApp.app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  const relay = new AuthStateRelay();
  manager = new AuthSessionManager({
    api: new AuthApiClient(baseUrl, (input, init) => fetch(input, init)),
    store: new SecureSessionStore(
      path.join(mkdtempSync(path.join(tmpdir(), 'swyft-it-')), 'session.bin'),
      {
        isEncryptionAvailable: () => false,
        encryptString: () => {
          throw new Error('unavailable');
        },
        decryptString: () => {
          throw new Error('unavailable');
        },
      },
    ),
    openBrowser: completeBrowserSignIn,
    startLoopback: startLoopbackReceiver,
    onStateChanged: relay.publish,
  });
  await manager.restore();
  api = new BusinessApiClient(
    baseUrl,
    (call) => manager.withAccessToken(call),
    (input, init) => fetch(input, init),
  );
  const handlers = createBusinessHandlers(
    api,
    async (content) => {
      clipboard = content;
    },
    async () => new Uint8Array(pngBytes),
  );
  const auth: DesktopAuthBridge = {
    getState: async () => manager.getState(),
    signIn: async () => {
      void manager.signIn();
    },
    signOut: () => manager.signOut(),
    retry: () => manager.restore(),
    onStateChanged: (listener) => relay.subscribe(listener),
  };
  const bridge = bridgeFromHandlers(handlers, auth);
  render(
    <AuthGate auth={auth}>
      {(user, signOut) => (
        <BridgeProvider bridge={bridge}>
          <Shell user={user} onSignOut={signOut} />
        </BridgeProvider>
      )}
    </AuthGate>,
  );
}, 60_000);

afterAll(async () => {
  cleanup();
  await testApp?.close();
});

describe('real-stack broker workflow', () => {
  let dealId = '';

  it('shows only sign-in, then signs in through the real PKCE loopback flow', async () => {
    fireEvent.click(
      await screen.findByRole('button', { name: 'Sign in with Google' }),
    );
    // The calculator is the landing screen; no deal is needed to quote.
    expect(
      await screen.findByRole('heading', { level: 2, name: 'New quote' }, slow),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New deal' })).toBeTruthy();
    expect(screen.getByText(brokerEmail.split('@')[0] ?? '')).toBeTruthy();
    expect(manager.getState().status).toBe('signed-in');
  });

  it('previews without a deal, then names a deal (stored in PostgreSQL) for a server-recalculated quote with the same figures', async () => {
    await waitFor(
      () =>
        expect(screen.getByLabelText('Lender and fee signature')).toBeTruthy(),
      slow,
    );
    chooseLender('Westpac — Dealer');
    type(/Finance amount/, '30000');
    type('Asset description', 'Ranger <b>XLT</b>');
    type(/Base rate/, '8.5');
    type('Settlement date', '2025-01-15');
    const preview = screen.getByRole('region', { name: 'Preview' });
    await within(preview).findByText('Comparison rate', {}, slow);
    // Westpac is advance: the dated schedule starts on the settlement date.
    await waitFor(() => {
      const firstRow = within(preview).getAllByRole('row')[1];
      expect(firstRow?.textContent).toMatch(/^115 Jan 2025/);
    }, slow);
    const previewPayment =
      within(preview).getAllByText(/^\$[\d,]+\.\d{2}$/)[0]?.textContent;
    expect((await api.listDeals()).items).toHaveLength(0);

    type('New deal name', 'Integration — Ranger');
    fireEvent.click(screen.getByRole('button', { name: 'Add quote to log' }));
    await screen.findByRole(
      'heading',
      { level: 2, name: 'Integration — Ranger' },
      slow,
    );
    await screen.findByText(/Saved: Westpac — Dealer/, {}, slow);
    const deal = (await api.listDeals()).items.find(
      (item) => item.name === 'Integration — Ranger',
    );
    expect(deal).toBeTruthy();
    dealId = deal?.id ?? '';
    const [saved] = await savedQuotes(dealId);
    expect(saved?.lenderName).toBe('Westpac');
    expect(`$${saved?.grossMonthlyPayment}`).toBe(
      previewPayment?.replace(',', ''),
    );
    expect(saved?.assetDescription).toBe('Ranger <b>XLT</b>');
  });

  it('uses the target commission calculator and saves a Branded quote reaching it', async () => {
    chooseLender('Branded — Dealer');
    type(/Base rate/, '8.54');
    type('Target commission', '900');
    fireEvent.click(screen.getByRole('button', { name: 'Find contract rate' }));
    await screen.findByText(/A contract rate of [\d.]+% earns/, {}, slow);
    fireEvent.click(screen.getByRole('button', { name: 'Use this rate' }));
    expect(field(/Contract \(customer\) rate/).value).not.toBe('');
    await screen.findByText('Comparison rate', {}, slow);
    fireEvent.click(screen.getByRole('button', { name: 'Add quote to log' }));
    await screen.findByText(/Saved: Branded — Dealer/, {}, slow);
    const branded = (await savedQuotes(dealId)).find(
      (quote) => quote.lenderName === 'Branded',
    );
    expect(Number(branded?.commission)).toBeGreaterThanOrEqual(900);
  });

  it('saves a daily-interest Autopay quote with its dates', async () => {
    chooseLender('Autopay — Standard');
    type(/Base rate/, '7.35');
    type('Commission', '4');
    type(/Settlement date/, '2025-05-31');
    type(/First repayment date/, '2025-06-06');
    const preview = screen.getByRole('region', { name: 'Preview' });
    await within(preview).findByText('Comparison rate', {}, slow);
    fireEvent.click(screen.getByRole('button', { name: 'Add quote to log' }));
    await screen.findByText(/Saved: Autopay — Standard/, {}, slow);
    expect(await savedQuotes(dealId)).toHaveLength(3);
  });

  it('edits a note, compares, exports to the clipboard and deletes a quote', async () => {
    fireEvent.click(screen.getByRole('tab', { name: /Saved quotes/ }));
    await screen.findByRole(
      'button',
      { name: 'Edit notes for Westpac — Dealer' },
      slow,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit notes for Westpac — Dealer' }),
    );
    fireEvent.change(await screen.findByLabelText('Notes'), {
      target: { value: 'Client prefers lower repayments' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await screen.findByText('Note saved', {}, slow);
    expect(
      (await savedQuotes(dealId)).find((q) => q.lenderName === 'Westpac')
        ?.notes,
    ).toBe('Client prefers lower repayments');

    fireEvent.click(
      screen.getByRole('button', { name: 'Compare side by side' }),
    );
    const compare = await screen.findByRole('table');
    for (const lender of ['Westpac', 'Branded', 'Autopay'])
      expect(within(compare).getAllByText(lender).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('tab', { name: 'Client email' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Copy quote to clipboard' }),
    );
    await screen.findByText(/Copied 3 quotes/, {}, slow);
    expect(clipboard?.html.match(/<table/g)?.length).toBe(4); // 1 header + 3 options
    expect(clipboard?.html).toContain('Ranger &lt;b&gt;XLT&lt;/b&gt;');
    expect(clipboard?.text).toContain('Finance Amount: $ 30,000.00');
    expect(clipboard?.text).not.toContain('Commissions'); // hidden by default

    fireEvent.click(screen.getByRole('tab', { name: /Saved quotes/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Quote log' }));
    fireEvent.click(
      await screen.findByRole(
        'button',
        { name: 'Delete quote Branded — Dealer' },
        slow,
      ),
    );
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Delete quote',
      }),
    );
    await waitFor(
      async () => expect(await savedQuotes(dealId)).toHaveLength(2),
      slow,
    );
  });

  it('manages a custom lender with a logo and assigns it a custom fee signature', async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Lenders' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Add lender' }, slow),
    );
    type(/Lender name/, 'Integration Credit Union');
    type('Website', 'http://not-https.example');
    fireEvent.click(screen.getByRole('button', { name: 'Create lender' }));
    expect(await screen.findByText(/full https:\/\/ address/)).toBeTruthy();
    type('Website', 'https://credit-union.example.com/');
    fireEvent.click(screen.getByRole('button', { name: 'Create lender' }));
    await screen.findByText(
      /Created lender “Integration Credit Union”/,
      {},
      slow,
    );

    fireEvent.click(
      await screen.findByRole('button', { name: 'Upload logo' }, slow),
    );
    const logo = (await screen.findByAltText(
      'Integration Credit Union logo',
      {},
      slow,
    )) as HTMLImageElement;
    expect(logo.src).toBe(
      `data:image/png;base64,${pngBytes.toString('base64')}`,
    );

    const presetRow = screen
      .getAllByRole('row')
      .find(
        (row) =>
          within(row).queryByText('Westpac') &&
          within(row).queryByText(/^Dealer/),
      );
    fireEvent.click(
      within(presetRow!).getByRole('button', {
        name: 'Duplicate to customise',
      }),
    );
    await screen.findByRole('button', { name: 'Save signature' }, slow);
    fireEvent.change(screen.getByLabelText('Lender'), {
      target: {
        value: (await api.listLenders()).find(
          (l) => l.name === 'Integration Credit Union',
        )?.id,
      },
    });
    type('Lender fee', '450');
    fireEvent.click(screen.getByRole('button', { name: 'Save signature' }));
    await screen.findByText(/Saved “Integration Credit Union — /, {}, slow);
    const custom = (await api.listFeeSignatures()).find(
      (signature) => signature.lenderName === 'Integration Credit Union',
    );
    expect(custom?.fees.establishment?.amount).toBe('450.00');
    expect(custom?.isPreset).toBe(false);
  });

  it('keeps each broker’s data private (RLS through the real API)', async () => {
    const other = await apiSignIn(testApp.app, uniqueEmail('other-broker'));
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/v1/deals',
      headers: other.headers,
    });
    expect(
      response.json<{ items: { id: string }[] }>().items.map((d) => d.id),
    ).not.toContain(dealId);
    const foreign = await testApp.app.inject({
      method: 'GET',
      url: `/v1/deals/${dealId}/quotes`,
      headers: other.headers,
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('clears the log, deletes the lender and the deal, then signs out to the sign-in screen', async () => {
    const lender = (await api.listLenders()).find(
      (l) => l.name === 'Integration Credit Union',
    );
    const lenderRow = screen
      .getAllByRole('listitem')
      .find((item) => within(item).queryByText('Integration Credit Union'));
    fireEvent.click(within(lenderRow!).getByRole('button', { name: 'Delete' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Delete lender',
      }),
    );
    await waitFor(async () => {
      const lenders = await api.listLenders();
      expect(lenders.some((l) => l.id === lender?.id)).toBe(false);
    }, slow);
    expect(
      (await api.listFeeSignatures()).some(
        (s) => s.lenderName === 'Integration Credit Union',
      ),
    ).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Calculator' }));
    fireEvent.click(
      await screen.findByRole('button', { name: /Integration — Ranger/ }, slow),
    );
    fireEvent.click(
      await screen.findByRole('tab', { name: /Saved quotes/ }, slow),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Clear all quotes' }, slow),
    );
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Clear all quotes',
      }),
    );
    await waitFor(
      async () => expect(await savedQuotes(dealId)).toHaveLength(0),
      slow,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete deal' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Delete deal',
      }),
    );
    await waitFor(async () => {
      expect((await api.listDeals()).items.some((d) => d.id === dealId)).toBe(
        false,
      );
    }, slow);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(
      await screen.findByRole('button', { name: 'Sign in with Google' }, slow),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New deal' })).toBeNull();
    await expect(api.listDeals()).rejects.toThrow();
  });
});
