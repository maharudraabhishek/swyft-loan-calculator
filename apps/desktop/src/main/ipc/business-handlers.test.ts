import { readFileSync } from 'node:fs';
import { defaultDisplayOptions, menuCommands } from '@swyft/contracts';
import { describe, expect, it, vi } from 'vitest';
import { updateChannels } from '../updates';
import {
  dealFixture,
  quoteFixture,
  signatureFixtures,
} from '../../test-support/fixtures';
import type { BusinessApiClient } from '../api/business-api';
import {
  businessChannels,
  createBusinessHandlers,
  type ClipboardWriter,
  type LogoFilePicker,
} from './business-handlers';

function setup() {
  const api = {
    listDeals: vi.fn(async () => ({
      items: [dealFixture()],
      nextCursor: null,
    })),
    createDeal: vi.fn(async (name: string) => dealFixture({ name })),
    deleteDeal: vi.fn(async () => null),
    createLender: vi.fn(async (input: { name: string }) => ({
      id: '40000000-0000-4000-8000-000000000001',
      name: input.name,
      websiteUrl: null,
      isPreset: false,
      hasLogo: false,
      logoUpdatedAt: null,
      createdAt: '2026-09-29T00:00:00.000Z',
      updatedAt: '2026-09-29T00:00:00.000Z',
    })),
    putLenderLogo: vi.fn(async () => null),
    saveQuote: vi.fn(async () => quoteFixture()),
    updateQuoteNotes: vi.fn(async () => quoteFixture({ notes: 'n' })),
    clearQuotes: vi.fn(async () => ({ deleted: 3 })),
  };
  const clipboard = vi.fn<ClipboardWriter>(async () => undefined);
  const pickLogo = vi.fn<LogoFilePicker>(async () => null);
  const handlers = createBusinessHandlers(
    api as unknown as BusinessApiClient,
    clipboard,
    pickLogo,
  );
  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers[channel];
    if (!handler) throw new Error(`No handler for ${channel}`);
    return Promise.resolve(handler(args));
  };
  return { api, clipboard, pickLogo, call };
}

const invalid = {
  ok: false,
  error: {
    kind: 'invalid-request',
    message: 'The request was not valid. Reload and try again.',
  },
};

describe('business IPC handlers', () => {
  it('forwards valid calls and wraps results', async () => {
    const { api, call } = setup();
    await expect(
      call(businessChannels.dealsCreate, '  Jones  '),
    ).resolves.toEqual({ ok: true, data: dealFixture({ name: 'Jones' }) });
    expect(api.createDeal).toHaveBeenCalledWith('Jones');
    await expect(call(businessChannels.dealsList)).resolves.toMatchObject({
      ok: true,
    });
  });

  it.each([
    ['a non-UUID deal id', businessChannels.dealsRemove, ['../../v1/deals']],
    ['an empty deal name', businessChannels.dealsCreate, ['   ']],
    [
      'an extra argument',
      businessChannels.dealsRemove,
      [dealFixture().id, 'x'],
    ],
    [
      'a short idempotency key',
      businessChannels.quotesSave,
      [dealFixture().id, 'k', { feeSignatureId: dealFixture().id }],
    ],
    [
      'a renderer-calculated payment',
      businessChannels.quotesSave,
      [
        dealFixture().id,
        'key-12345678',
        {
          feeSignatureId: dealFixture().id,
          financeAmount: '30000',
          termMonths: 60,
          baseRate: '0.085',
          monthlyPayment: '1.00',
        },
      ],
    ],
    [
      'an oversized note',
      businessChannels.quotesUpdateNotes,
      [quoteFixture().id, 'x'.repeat(2001)],
    ],
  ])('rejects %s before calling the API', async (_label, channel, args) => {
    const { api, call } = setup();
    await expect(call(channel, ...args)).resolves.toEqual(invalid);
    for (const method of Object.values(api))
      expect(method).not.toHaveBeenCalled();
  });

  it('previews with the shared engine: the brief worked example', async () => {
    const { call } = setup();
    const signature = {
      ...signatureFixtures.westpacDealer,
      paymentTiming: 'arrears' as const,
      fees: { establishment: { amount: '495.00', financed: true } },
    };
    const response = await call(businessChannels.quotesPreview, {
      signature,
      request: {
        feeSignatureId: signature.id,
        financeAmount: '30000',
        termMonths: 60,
        baseRate: '0.085',
        commissionRate: '0.04',
      },
    });
    expect(response).toMatchObject({
      ok: true,
      preview: {
        monthlyPayment: '650.68',
        totalHiring: '39040.80',
        commission: '1219.80',
        netAmountFinanced: '30495.00',
      },
    });
  });

  it('dates monthly-lender schedules from the settlement date', async () => {
    const { call } = setup();
    const request = {
      feeSignatureId: signatureFixtures.westpacDealer.id,
      financeAmount: '30000',
      termMonths: 60,
      baseRate: '0.085',
    };
    const advance = (await call(businessChannels.quotesPreview, {
      signature: signatureFixtures.westpacDealer,
      request,
      scheduleStartDate: '2025-01-31',
    })) as { ok: true; preview: { schedule: { paymentDate?: string }[] } };
    // Advance: first payment at settlement; later ones keep the day, clamped.
    expect(advance.preview.schedule[0]?.paymentDate).toBe('2025-01-31');
    expect(advance.preview.schedule[1]?.paymentDate).toBe('2025-02-28');
    const arrears = (await call(businessChannels.quotesPreview, {
      signature: {
        ...signatureFixtures.westpacDealer,
        paymentTiming: 'arrears',
      },
      request,
      scheduleStartDate: '2025-01-15',
    })) as { ok: true; preview: { schedule: { paymentDate?: string }[] } };
    expect(arrears.preview.schedule[0]?.paymentDate).toBe('2025-02-15');
    const undated = (await call(businessChannels.quotesPreview, {
      signature: signatureFixtures.westpacDealer,
      request,
    })) as { ok: true; preview: { schedule: { paymentDate?: string }[] } };
    expect(undated.preview.schedule[0]?.paymentDate).toBeUndefined();
  });

  it('returns signature rule violations as field errors', async () => {
    const { call } = setup();
    const response = await call(businessChannels.quotesPreview, {
      signature: signatureFixtures.westpacDealer,
      request: {
        feeSignatureId: signatureFixtures.westpacDealer.id,
        financeAmount: '30000',
        termMonths: 60,
        baseRate: '0.085',
        commissionRate: '0.07',
      },
    });
    expect(response).toMatchObject({
      ok: false,
      fields: { commissionRate: expect.stringContaining('6%') as unknown },
    });
  });

  it('maps schema problems to request fields', async () => {
    const { call } = setup();
    const response = await call(businessChannels.quotesPreview, {
      signature: signatureFixtures.westpacDealer,
      request: {
        feeSignatureId: signatureFixtures.westpacDealer.id,
        financeAmount: '-5',
        termMonths: 60,
        baseRate: '0.085',
      },
    });
    expect(response).toMatchObject({
      ok: false,
      fields: { financeAmount: expect.any(String) as unknown },
    });
  });

  it('explains daily-interest date order problems on the right field', async () => {
    const { call } = setup();
    const response = await call(businessChannels.quotesPreview, {
      signature: signatureFixtures.autopay,
      request: {
        feeSignatureId: signatureFixtures.autopay.id,
        financeAmount: '30000',
        termMonths: 60,
        baseRate: '0.0735',
        commissionRate: '0.04',
        settlementDate: '2026-10-10',
        firstRepaymentDate: '2026-10-01',
      },
    });
    expect(response).toMatchObject({
      ok: false,
      fields: { firstRepaymentDate: expect.any(String) as unknown },
    });
  });

  it('explains a term too short for a comparison rate on the term field', async () => {
    const { call } = setup();
    const response = await call(businessChannels.quotesPreview, {
      signature: signatureFixtures.westpacDealer,
      request: {
        feeSignatureId: signatureFixtures.westpacDealer.id,
        financeAmount: '30000',
        termMonths: 1,
        baseRate: '0.085',
      },
    });
    expect(response).toMatchObject({
      ok: false,
      fields: {
        termMonths: expect.stringMatching(/term is too short/) as unknown,
      },
    });
  });

  it('solves a target commission with the shared engine', async () => {
    const { call } = setup();
    const signature = {
      ...signatureFixtures.westpacDealer,
      paymentTiming: 'arrears' as const,
      fees: { establishment: { amount: '495.00', financed: true } },
    };
    const request = {
      feeSignatureId: signature.id,
      financeAmount: '30000',
      termMonths: 60,
      baseRate: '0.085',
    };
    await expect(
      call(businessChannels.quotesTargetCommission, {
        signature,
        request,
        targetCommission: '1219.80',
      }),
    ).resolves.toEqual({
      ok: true,
      solves: 'commissionRate',
      rate: '0.04',
      commission: '1219.80',
      contractRate: null,
      metByBaseCommission: false,
    });
    await expect(
      call(businessChannels.quotesTargetCommission, {
        signature,
        request,
        targetCommission: '1e9',
      }),
    ).resolves.toMatchObject({
      ok: false,
      fields: { targetCommission: expect.any(String) as unknown },
    });
  });

  it('writes generated HTML and text to the clipboard', async () => {
    const { call, clipboard } = setup();
    const result = await call(businessChannels.quotesCopyExport, {
      quotes: [quoteFixture({ assetDescription: '<b>Ute</b>' })],
      display: defaultDisplayOptions,
    });
    expect(result).toEqual({ ok: true, data: { quoteCount: 1 } });
    const written = clipboard.mock.calls[0]?.[0] ?? { html: '', text: '' };
    expect(written.html).toContain('&lt;b&gt;Ute&lt;/b&gt;');
    expect(written.html).not.toContain('<b>Ute');
    expect(written.text).toContain('Asset: <b>Ute</b>');
  });

  it('reports a clipboard failure as a clipboard problem', async () => {
    const { call, clipboard } = setup();
    clipboard.mockRejectedValueOnce(new Error('OS clipboard busy'));
    const result = await call(businessChannels.quotesCopyExport, {
      quotes: [quoteFixture()],
      display: defaultDisplayOptions,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'server',
        message: 'The system clipboard could not be written. Try again.',
      },
    });
  });

  it('refuses a clipboard request carrying raw HTML fields', async () => {
    const { call, clipboard } = setup();
    const result = await call(businessChannels.quotesCopyExport, {
      quotes: [quoteFixture()],
      display: defaultDisplayOptions,
      html: '<script>',
    });
    expect(result).toEqual(invalid);
    expect(clipboard).not.toHaveBeenCalled();
  });

  it('creates custom lenders only with a valid name and https website', async () => {
    const { api, call } = setup();
    await expect(
      call(businessChannels.lendersCreate, {
        name: 'Local Credit Union',
        websiteUrl: 'https://example.com.au/',
      }),
    ).resolves.toMatchObject({ ok: true });
    for (const bad of [
      { name: 'X', websiteUrl: 'http://example.com/' },
      { name: 'X', websiteUrl: 'javascript:alert(1)' },
      { name: '   ' },
      { name: 'X', ownerUserId: dealFixture().id },
    ])
      await expect(call(businessChannels.lendersCreate, bad)).resolves.toEqual(
        invalid,
      );
    expect(api.createLender).toHaveBeenCalledTimes(1);
  });

  it('uploads a logo only after the broker picks a file in Main', async () => {
    const { api, call, pickLogo } = setup();
    const id = '40000000-0000-4000-8000-000000000001';
    await expect(call(businessChannels.lendersUploadLogo, id)).resolves.toEqual(
      { ok: true, data: null },
    );
    expect(api.putLenderLogo).not.toHaveBeenCalled();
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    pickLogo.mockResolvedValueOnce(png);
    await call(businessChannels.lendersUploadLogo, id);
    expect(api.putLenderLogo).toHaveBeenCalledWith(id, png);
    // The Renderer can name the lender, never a path or bytes.
    await expect(
      call(businessChannels.lendersUploadLogo, id, 'C:/secret.png'),
    ).resolves.toEqual(invalid);
  });

  it('Preload forwards exactly the channels Main handles', () => {
    const preload = readFileSync(
      new URL('../../preload/index.ts', import.meta.url),
      'utf8',
    );
    const used = [
      ...preload.matchAll(
        /'((?:deals|quotes|lenders|fee-signatures):[a-z-]+:v\d)'/g,
      ),
    ]
      .map((match) => match[1])
      .sort();
    expect(used).toEqual(Object.values(businessChannels).sort());
  });

  it('Preload uses exactly the update channels Main defines', () => {
    const preload = readFileSync(
      new URL('../../preload/index.ts', import.meta.url),
      'utf8',
    );
    const used = [...preload.matchAll(/'(updates:[a-z-]+:v\d)'/g)]
      .map((match) => match[1])
      .sort();
    expect(used).toEqual(Object.values(updateChannels).sort());
  });

  it('Preload accepts exactly the menu commands the contract defines', () => {
    const preload = readFileSync(
      new URL('../../preload/index.ts', import.meta.url),
      'utf8',
    );
    const list = /knownMenuCommands[^=]*=\s*\[([^\]]*)\]/.exec(preload)?.[1];
    const accepted = [...(list ?? '').matchAll(/'([a-z-]+)'/g)].map(
      (match) => match[1],
    );
    expect(accepted.sort()).toEqual([...menuCommands].sort());
  });
});
