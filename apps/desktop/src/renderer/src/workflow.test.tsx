// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../test-support/fake-bridge';
import {
  dealFixture,
  quoteFixture,
  signatureFixtures,
} from '../../test-support/fixtures';
import { Shell } from './app/shell';
import { BridgeProvider } from './lib/bridge';

type Fake = ReturnType<typeof createFakeBridge>;

function renderShell(fake: Fake) {
  return render(
    <BridgeProvider bridge={fake.bridge}>
      <Shell
        user={{ email: 'broker@example.test', displayName: 'Broker' }}
        onSignOut={() => fake.bridge.auth.signOut()}
      />
    </BridgeProvider>,
  );
}

async function openDeal(name = dealFixture().name) {
  fireEvent.click(
    await screen.findByRole('button', { name: new RegExp(name) }),
  );
  await screen.findByRole('heading', { level: 2, name });
}

function input(label: string | RegExp) {
  return screen.getByLabelText(label) as HTMLInputElement;
}

function type(label: string | RegExp, value: string) {
  fireEvent.change(input(label), { target: { value } });
}

const savedQuotes = [
  quoteFixture(),
  quoteFixture({
    id: '10000000-0000-4000-8000-000000000002',
    lenderName: 'Branded',
    feeSignatureName: 'Dealer',
    commissionModel: 'overs',
    commissionRate: null,
    contractRate: '0.1004',
    commission: '735.02',
    monthlyFee: '8.00',
    monthlyPayment: '642.00',
    grossMonthlyPayment: '650.00',
  }),
];

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(cleanup);

describe('deal workflow', () => {
  it('loads, creates, opens and deletes deals', async () => {
    const fake = createFakeBridge();
    renderShell(fake);
    expect(await screen.findByText(dealFixture().name)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'New deal' }));
    type('Deal name', '  Jones — Caravan ');
    fireEvent.click(screen.getByRole('button', { name: 'Create deal' }));
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Jones — Caravan' }),
    ).toBeTruthy();
    expect(fake.bridge.deals.create).toHaveBeenCalledWith('  Jones — Caravan ');

    fireEvent.click(screen.getByRole('button', { name: 'Delete deal' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/permanently deleted/)).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Delete deal' }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /Jones — Caravan/ }),
      ).toBeNull(),
    );
    // With the deal gone the calculator stays open, ready for the next quote.
    expect(
      screen.getByRole('heading', { level: 2, name: 'New quote' }),
    ).toBeTruthy();
    expect(fake.store.deals.map((deal) => deal.name)).toEqual([
      dealFixture().name,
    ]);
  });

  it('refuses an empty deal name without calling the API', async () => {
    const fake = createFakeBridge();
    renderShell(fake);
    fireEvent.click(await screen.findByRole('button', { name: 'New deal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create deal' }));
    expect(await screen.findByText('Enter a name for the deal.')).toBeTruthy();
    expect(fake.bridge.deals.create).not.toHaveBeenCalled();
  });

  it('shows an offline error with retry when deals cannot load', async () => {
    const fake = createFakeBridge();
    fake.failNext('deals.list', {
      kind: 'offline',
      message: 'You appear to be offline.',
    });
    renderShell(fake);
    expect(await screen.findByText('Deals could not be loaded.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(dealFixture().name)).toBeTruthy();
  });
});

describe('application menu commands', () => {
  it('switches views, toggles the deal list and opens New deal from the menu', async () => {
    const fake = createFakeBridge();
    renderShell(fake);
    await screen.findByRole('heading', { level: 2, name: 'New quote' });

    act(() => fake.sendMenuCommand('show-lenders'));
    expect(
      await screen.findByRole('heading', { name: 'Lender library' }),
    ).toBeTruthy();
    act(() => fake.sendMenuCommand('show-calculator'));
    expect(
      screen
        .getByRole('button', { name: 'Calculator' })
        .getAttribute('aria-current'),
    ).toBe('page');

    act(() => fake.sendMenuCommand('toggle-deal-list'));
    expect(screen.queryByRole('navigation', { name: 'Deals' })).toBeNull();
    // New deal reopens the list with the name field ready to type in.
    act(() => fake.sendMenuCommand('new-deal'));
    expect(await screen.findByLabelText('Deal name')).toBe(
      document.activeElement,
    );
  });

  it('shows a downloaded update and installs it only when asked', async () => {
    const fake = createFakeBridge();
    renderShell(fake);
    await screen.findByRole('heading', { level: 2, name: 'New quote' });
    expect(screen.queryByText(/ready to install/)).toBeNull();

    act(() => fake.updateReady('1.1.1'));
    expect(
      await screen.findByText('Swyft Finance 1.1.1 is ready to install.'),
    ).toBeTruthy();
    expect(fake.bridge.updates.install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Restart and update' }));
    expect(fake.bridge.updates.install).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole('button', { name: 'Restarting…' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('shows an update that finished downloading before the window opened', async () => {
    const fake = createFakeBridge();
    fake.updateReady('1.1.1');
    renderShell(fake);
    expect(
      await screen.findByText('Swyft Finance 1.1.1 is ready to install.'),
    ).toBeTruthy();
  });
});

describe('calculator without a deal', () => {
  const secondDeal = dealFixture({
    id: '20000000-0000-4000-8000-000000000002',
    quoteLogId: '30000000-0000-4000-8000-000000000002',
    name: 'Lee — Excavator',
  });

  function fillWestpacQuote() {
    fireEvent.change(screen.getByLabelText('Lender and fee signature'), {
      target: { value: signatureFixtures.westpacDealer.id },
    });
    type(/Finance amount/, '30000');
    type(/Base rate/, '8.5');
  }

  it('opens on the calculator and previews without choosing a deal', async () => {
    const fake = createFakeBridge();
    renderShell(fake);
    expect(
      await screen.findByRole('heading', { level: 2, name: 'New quote' }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Calculator' })
        .getAttribute('aria-current'),
    ).toBe('page');
    // The quote log and client email belong to a deal.
    for (const name of ['Quote log', 'Client email'])
      expect(
        (screen.getByRole('tab', { name }) as HTMLButtonElement).disabled,
      ).toBe(true);

    fillWestpacQuote();
    const preview = screen.getByRole('region', { name: 'Preview' });
    await within(preview).findByText('Comparison rate', {}, { timeout: 2000 });
    expect(within(preview).getByText('Not saved')).toBeTruthy();
    expect(fake.bridge.quotes.list).not.toHaveBeenCalled();
    expect(fake.bridge.quotes.save).not.toHaveBeenCalled();
  });

  it('names a deal when adding a quote and opens it with the saved quote', async () => {
    const fake = createFakeBridge({ deals: [] });
    renderShell(fake);
    await screen.findByRole('heading', { level: 2, name: 'New quote' });
    fillWestpacQuote();
    await screen.findByText('Comparison rate', {}, { timeout: 2000 });

    fireEvent.click(screen.getByRole('button', { name: 'Add quote to log' }));
    expect(
      await screen.findByText(/Name a deal to keep this quote in/),
    ).toBeTruthy();
    expect(fake.bridge.deals.create).not.toHaveBeenCalled();
    expect(fake.bridge.quotes.save).not.toHaveBeenCalled();

    type('New deal name', 'Nguyen — Camry');
    fireEvent.click(screen.getByRole('button', { name: 'Add quote to log' }));
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Nguyen — Camry' }),
    ).toBeTruthy();
    expect(await screen.findByText(/Saved: Westpac — Dealer/)).toBeTruthy();
    const created = fake.store.deals[0]!;
    expect(fake.bridge.deals.create).toHaveBeenCalledWith('Nguyen — Camry');
    expect(fake.bridge.quotes.save).toHaveBeenCalledWith(
      created.id,
      expect.any(String),
      expect.objectContaining({ financeAmount: '30000' }),
    );
    expect(
      await screen.findByRole('tab', { name: 'Quote log (1)' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Nguyen — Camry/ })).toBeTruthy();
    // The loan details stay for quoting the next lender.
    expect(input(/Finance amount/).value).toBe('30000');
  });

  it('keeps typed values but never shows another deal’s quotes when switching deals', async () => {
    const fake = createFakeBridge({
      deals: [dealFixture(), secondDeal],
      quotes: [...savedQuotes],
    });
    renderShell(fake);
    await openDeal();
    type(/Finance amount/, '45000');
    fireEvent.click(screen.getByRole('tab', { name: /Quote log/ }));
    await screen.findByRole('table');

    // The second deal's log is still loading: the first deal's rows must not linger.
    fake.bridge.quotes.list.mockImplementationOnce(
      () => new Promise<never>(() => undefined),
    );
    await openDeal(secondDeal.name);
    expect(screen.getByText('Loading saved quotes…')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Quote builder' }));
    expect(input(/Finance amount/).value).toBe('45000');
    expect(
      screen.getByText(secondDeal.name, { selector: 'strong' }),
    ).toBeTruthy();
  });

  it('uses a new idempotency key when the same draft is saved to another deal', async () => {
    const fake = createFakeBridge({ deals: [dealFixture(), secondDeal] });
    renderShell(fake);
    await openDeal();
    fillWestpacQuote();
    await screen.findByText('Comparison rate', {}, { timeout: 2000 });
    fake.failNext('quotes.save', {
      kind: 'offline',
      message: 'You appear to be offline.',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add quote to log' }));
    expect(await screen.findByText('The quote was not saved.')).toBeTruthy();

    await openDeal(secondDeal.name);
    // The failure belonged to the first deal.
    expect(screen.queryByText('The quote was not saved.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add quote to log' }));
    expect(await screen.findByText(/Saved: Westpac — Dealer/)).toBeTruthy();
    expect(
      fake.bridge.quotes.save.mock.calls.map(([dealId]) => dealId),
    ).toEqual([dealFixture().id, secondDeal.id]);
    expect(fake.saveKeys[1]).not.toBe(fake.saveKeys[0]);
  });
});

describe('quote workflow', () => {
  it('previews locally, saves to the API and shows the persisted server quote', async () => {
    const fake = createFakeBridge();
    renderShell(fake);
    await openDeal();

    fireEvent.change(screen.getByLabelText('Lender and fee signature'), {
      target: { value: signatureFixtures.westpacDealer.id },
    });
    type(/Finance amount/, '30000');
    type(/Base rate/, '8.5');
    expect(input('Commission').value).toBe('4');

    const preview = screen.getByRole('region', { name: 'Preview' });
    await within(preview).findByText('Comparison rate', {}, { timeout: 2000 });
    expect(within(preview).getByText('Not saved')).toBeTruthy();

    // The API answers with its own recalculated record; the log must show that.
    fake.bridge.quotes.save.mockImplementationOnce(
      async (dealId, _key, request) => {
        expect(request).not.toHaveProperty('monthlyPayment');
        return {
          ok: true,
          data: quoteFixture({
            dealId,
            grossMonthlyPayment: '777.77',
            monthlyPayment: '777.77',
          }),
        };
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add quote to log' }));
    expect(
      await screen.findByText(/Saved: Westpac — Dealer at \$777\.77\/month/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'View saved quotes' }));
    const log = await screen.findByRole('table');
    expect(within(log).getByText('$777.77')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Quote log (1)' })).toBeTruthy();
  });

  it('finds the rate for a target commission and applies it', async () => {
    const fake = createFakeBridge();
    renderShell(fake);
    await openDeal();
    const select = screen.getByLabelText('Lender and fee signature');
    fireEvent.change(select, {
      target: { value: signatureFixtures.brandedDealer.id },
    });
    type(/Finance amount/, '18769.50');
    type(/Base rate/, '8.54');
    type('Target commission', '734.58');
    fireEvent.click(screen.getByRole('button', { name: 'Find contract rate' }));
    expect(
      await screen.findByText(
        /A contract rate of 10\.\d\d% earns \$7\d\d\.\d\d/,
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use this rate' }));
    expect(input(/Contract \(customer\) rate/).value).toMatch(/^10\.\d+$/);

    fireEvent.change(select, {
      target: { value: signatureFixtures.westpacDealer.id },
    });
    type('Target commission', '2000'); // 10.38% of NAF > the 6% cap
    fireEvent.click(screen.getByRole('button', { name: 'Find commission %' }));
    expect(await screen.findByText(/allows at most 6%/)).toBeTruthy();
  });

  it('shows the fields each lender needs', async () => {
    const fake = createFakeBridge();
    renderShell(fake);
    await openDeal();
    const select = screen.getByLabelText('Lender and fee signature');

    fireEvent.change(select, {
      target: { value: signatureFixtures.brandedDealer.id },
    });
    expect(input(/Contract \(customer\) rate/)).toBeTruthy();
    expect(screen.queryByLabelText('Commission')).toBeNull();
    expect(screen.queryByLabelText(/First repayment date/)).toBeNull();
    // Monthly lenders show a settlement date only to date the schedule.
    expect(screen.getByText(/not needed to price this lender/)).toBeTruthy();

    fireEvent.change(select, {
      target: { value: signatureFixtures.autopay.id },
    });
    expect(input(/Settlement date/)).toBeTruthy();
    expect(input(/First repayment date/)).toBeTruthy();
    expect(screen.getByLabelText('Commission')).toBeTruthy();
    expect(screen.queryByLabelText(/Contract \(customer\) rate/)).toBeNull();
    // Daily-interest timing is described by its first repayment date, not as monthly arrears.
    expect(screen.getByText(/From 1st repayment date/)).toBeTruthy();
    expect(screen.getByText(/advance-style start/)).toBeTruthy();
  });

  it('flags invalid input next to the field and does not save', async () => {
    const fake = createFakeBridge();
    renderShell(fake);
    await openDeal();
    fireEvent.change(screen.getByLabelText('Lender and fee signature'), {
      target: { value: signatureFixtures.westpacDealer.id },
    });
    type(/Finance amount/, '-500');
    type(/Base rate/, '8.5');
    type('Commission', '7');
    fireEvent.click(screen.getByRole('button', { name: 'Add quote to log' }));
    expect(
      await screen.findByText(/Enter an amount greater than zero/),
    ).toBeTruthy();
    expect(input(/Finance amount/).getAttribute('aria-invalid')).toBe('true');
    expect(input(/Finance amount/).value).toBe('-500');

    type(/Finance amount/, '30000');
    // Lender rule from the shared quoting package, reported by the preview.
    const messages = await screen.findAllByText(
      /cannot exceed 6%/,
      {},
      { timeout: 2000 },
    );
    expect(messages.some((element) => element.closest('.field'))).toBe(true);
    expect(input('Commission').getAttribute('aria-invalid')).toBe('true');
    expect(fake.bridge.quotes.save).not.toHaveBeenCalled();
  });

  it('retries a failed save with the same idempotency key and maps API field errors', async () => {
    const fake = createFakeBridge();
    renderShell(fake);
    await openDeal();
    fireEvent.change(screen.getByLabelText('Lender and fee signature'), {
      target: { value: signatureFixtures.westpacDealer.id },
    });
    type(/Finance amount/, '30000');
    type(/Base rate/, '8.5');
    await screen.findByText('Comparison rate', {}, { timeout: 2000 });

    fake.failNext('quotes.save', {
      kind: 'server',
      message: 'The Swyft service had a problem.',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add quote to log' }));
    expect(await screen.findByText('The quote was not saved.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/Saved: Westpac — Dealer/)).toBeTruthy();
    expect(fake.saveKeys).toHaveLength(2);
    expect(fake.saveKeys[0]).toBe(fake.saveKeys[1]);

    fake.failNext('quotes.save', {
      kind: 'validation',
      message: 'Some fields are invalid.',
      fields: { baseRate: 'Base rate is not accepted by the API.' },
    });
    type(/Base rate/, '8.6');
    await screen.findByText('Comparison rate', {}, { timeout: 2000 });
    fireEvent.click(screen.getByRole('button', { name: 'Add quote to log' }));
    expect(
      await screen.findByText('Base rate is not accepted by the API.'),
    ).toBeTruthy();
    expect(fake.saveKeys[2]).not.toBe(fake.saveKeys[0]);
  });
  it('keeps an unsaved quote when the broker looks at saved quotes', async () => {
    const fake = createFakeBridge();
    renderShell(fake);
    await openDeal();
    type(/Finance amount/, '45000');
    fireEvent.click(screen.getByRole('tab', { name: /Quote log/ }));
    fireEvent.click(screen.getByRole('tab', { name: 'Quote builder' }));
    expect(input(/Finance amount/).value).toBe('45000');
  });
});

describe('quote log', () => {
  async function openLog(fake: Fake) {
    renderShell(fake);
    await openDeal();
    fireEvent.click(screen.getByRole('tab', { name: /Quote log/ }));
    return screen.findByRole('table');
  }

  it('edits notes, deletes one quote and clears the log', async () => {
    const fake = createFakeBridge({ quotes: [...savedQuotes] });
    await openLog(fake);

    fireEvent.click(
      screen.getByRole('button', { name: 'Edit notes for Westpac — Dealer' }),
    );
    const notes = await screen.findByLabelText('Notes');
    fireEvent.change(notes, {
      target: { value: 'Client prefers <b>low</b> repayments' },
    });
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    expect(await screen.findByText('Note saved')).toBeTruthy();
    expect(fake.store.quotes[0]?.notes).toBe(
      'Client prefers <b>low</b> repayments',
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Delete quote Branded — Dealer' }),
    );
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Delete quote',
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Delete quote Branded — Dealer' }),
      ).toBeNull(),
    );
    expect(fake.store.quotes).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Clear all quotes' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Clear all quotes',
      }),
    );
    expect(
      await screen.findByText(/No quotes saved for this deal yet/),
    ).toBeTruthy();
    expect(fake.bridge.quotes.clear).toHaveBeenCalledWith(dealFixture().id);
  });

  it('keeps an unsaved note draft when its row is collapsed', async () => {
    const fake = createFakeBridge({ quotes: [...savedQuotes] });
    await openLog(fake);
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit notes for Westpac — Dealer' }),
    );
    fireEvent.change(await screen.findByLabelText('Notes'), {
      target: { value: 'Draft in progress' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Hide details for Westpac — Dealer' }),
    );
    expect(screen.queryByLabelText('Notes')).toBeNull();
    expect(screen.getByText('Unsaved note…')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Show details for Westpac — Dealer' }),
    );
    expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe(
      'Draft in progress',
    );
    expect(fake.bridge.quotes.updateNotes).not.toHaveBeenCalled();

    // The draft also survives switching to the comparison and back.
    fireEvent.click(
      screen.getByRole('button', { name: 'Compare side by side' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    expect(screen.getByText('Unsaved note…')).toBeTruthy();
  });

  it('keeps a quote visible when deleting fails', async () => {
    const fake = createFakeBridge({ quotes: [...savedQuotes] });
    await openLog(fake);
    fake.failNext('quotes.remove', {
      kind: 'offline',
      message: 'You appear to be offline.',
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete quote Branded — Dealer' }),
    );
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Delete quote' }),
    );
    expect(await within(dialog).findByText('Not deleted.')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Delete quote Branded — Dealer' }),
    ).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('toggles rates, commission and total hiring columns and frequencies', async () => {
    const fake = createFakeBridge({ quotes: [...savedQuotes] });
    const log = await openLog(fake);
    const header = () =>
      within(log)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent);

    expect(header()).toContain('Base rate');
    expect(header()).not.toContain('Commission');
    fireEvent.click(screen.getByRole('switch', { name: 'Commissions' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Base rate' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Total hiring' }));
    expect(header()).toContain('Commission');
    expect(header()).not.toContain('Base rate');
    expect(header()).not.toContain('Total hiring');
    expect(within(log).getByText('$1,219.80 (4%)')).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Fortnightly' }));
    expect(within(log).getByText('$300.31')).toBeTruthy();
    // Monthly can be cleared while another frequency remains; the last one cannot.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Monthly' }));
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Fortnightly',
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(window.localStorage.getItem('swyft.display-options.v1')).toContain(
      '"showCommission":true',
    );
  });

  it('compares quotes side by side without ranking them', async () => {
    const fake = createFakeBridge({ quotes: [...savedQuotes] });
    await openLog(fake);
    fireEvent.click(
      screen.getByRole('button', { name: 'Compare side by side' }),
    );
    const table = await screen.findByRole('table');
    expect(
      within(table).getByRole('columnheader', { name: /Option 1\s*Westpac/ }),
    ).toBeTruthy();
    expect(
      within(table).getByRole('columnheader', { name: /Option 2\s*Branded/ }),
    ).toBeTruthy();
    expect(
      within(table).getByRole('rowheader', { name: 'Contract rate' }),
    ).toBeTruthy();
    expect(
      within(table).queryByRole('rowheader', { name: 'Broker commission' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Commissions' }));
    expect(
      within(table).getByRole('rowheader', { name: 'Broker commission' }),
    ).toBeTruthy();
    expect(within(table).getByText('incl. GST, from rate overs')).toBeTruthy();
    expect(screen.queryByText(/best/i)).toBeNull();
  });

  it('shows stale data with a retry when reloading quotes fails', async () => {
    const fake = createFakeBridge({ quotes: [...savedQuotes] });
    fake.failNext('quotes.list', {
      kind: 'server',
      message: 'The Swyft service had a problem.',
    });
    renderShell(fake);
    await openDeal();
    fireEvent.click(screen.getByRole('tab', { name: /Quote log/ }));
    expect(
      await screen.findByText('The quote log could not be loaded.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeTruthy();
  });
});

describe('client email export', () => {
  it('copies the selected quotes with the current display options', async () => {
    const fake = createFakeBridge({ quotes: [...savedQuotes] });
    renderShell(fake);
    await openDeal();
    fireEvent.click(screen.getByRole('tab', { name: /Quote log/ }));
    await screen.findByRole('table');
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Include Branded — Dealer in client email',
      }),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Client email' }));

    const preview = screen.getByLabelText('Client email preview');
    expect(within(preview).getByText('Finance Amount')).toBeTruthy();
    expect(within(preview).getByText('$ 30,000.00')).toBeTruthy();
    expect(within(preview).queryByText(/Commissions/)).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'Copy quote to clipboard' }),
    );
    expect(
      await screen.findByText(/Copied 1 quote as formatted tables/),
    ).toBeTruthy();
    expect(fake.exports[0]?.quotes.map((quote) => quote.lenderName)).toEqual([
      'Westpac',
    ]);
    expect(fake.exports[0]?.display.showCommission).toBe(false);
  });

  it('reports a failed copy', async () => {
    const fake = createFakeBridge({ quotes: [...savedQuotes] });
    renderShell(fake);
    await openDeal();
    fireEvent.click(screen.getByRole('tab', { name: 'Client email' }));
    fake.failNext('quotes.copyExport', {
      kind: 'invalid-request',
      message: 'The request was not valid.',
    });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Copy quote to clipboard' }),
    );
    expect(await screen.findByText('Nothing was copied.')).toBeTruthy();
  });
});

describe('lender library', () => {
  it('opens each signature editor with its own values', async () => {
    const custom = (id: string, name: string, monthlyFee: string) => ({
      ...signatureFixtures.westpacDealer,
      id,
      name,
      monthlyFee,
      isPreset: false,
      sourceFeeSignatureId: signatureFixtures.westpacDealer.id,
    });
    const fake = createFakeBridge({
      signatures: [
        custom('71111111-1111-4111-8111-000000000001', 'Alpha', '1.00'),
        custom('71111111-1111-4111-8111-000000000002', 'Beta', '2.00'),
      ],
    });
    renderShell(fake);
    fireEvent.click(await screen.findByRole('button', { name: 'Lenders' }));
    const edits = await screen.findAllByRole('button', { name: 'Edit' });
    fireEvent.click(edits[0]!);
    expect(input(/Signature name/).value).toBe('Alpha');
    fireEvent.click(edits[1]!);
    expect(input(/Signature name/).value).toBe('Beta');
    expect(input('Monthly fee').value).toBe('2.00');
  });

  it('previews whole-dollar repayments and edits the setting', async () => {
    const wholeDollar = {
      ...signatureFixtures.westpacDealer,
      id: '71111111-1111-4111-8111-000000000009',
      name: 'Whole dollar',
      isPreset: false,
      sourceFeeSignatureId: signatureFixtures.westpacDealer.id,
      roundPaymentUpToDollar: true,
    };
    const fake = createFakeBridge({
      signatures: [signatureFixtures.westpacDealer, wholeDollar],
    });
    renderShell(fake);
    await screen.findByRole('heading', { level: 2, name: 'New quote' });
    fireEvent.change(screen.getByLabelText('Lender and fee signature'), {
      target: { value: wholeDollar.id },
    });
    type(/Finance amount/, '30000');
    type(/Base rate/, '8.5');
    const preview = screen.getByRole('region', { name: 'Preview' });
    // $646.21 at cent rounding becomes $647.00 for a whole-dollar lender.
    expect(
      (await within(preview).findAllByText('$647.00', {}, { timeout: 2000 }))
        .length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/repayments rounded up to whole dollars/).length,
    ).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Lenders' }));
    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'Edit' }))[0]!,
    );
    const toggle = screen.getByRole('checkbox', {
      name: 'Round repayments up to the whole dollar',
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save signature' }));
    await waitFor(() =>
      expect(fake.bridge.lenders.updateSignature).toHaveBeenCalledWith(
        wholeDollar.id,
        expect.objectContaining({ roundPaymentUpToDollar: false }),
      ),
    );
  });

  it('duplicates a built-in signature and deletes the custom copy', async () => {
    const fake = createFakeBridge();
    renderShell(fake);
    fireEvent.click(await screen.findByRole('button', { name: 'Lenders' }));
    const duplicate = (
      await screen.findAllByRole('button', { name: 'Duplicate to customise' })
    )[0];
    fireEvent.click(duplicate!);
    expect(await screen.findByText(/Created “/)).toBeTruthy();
    expect(
      await screen.findByRole('button', { name: 'Save signature' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Delete signature',
      }),
    );
    await waitFor(() =>
      expect(
        fake.store.signatures.every((signature) => signature.isPreset),
      ).toBe(true),
    );
  });
});
