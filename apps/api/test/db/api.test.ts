import type {
  DealDto,
  FeeSignatureDto,
  LenderDto,
  QuoteDto,
} from '@swyft/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  pngBytes,
  presetIds,
  signIn,
  uniqueEmail,
  type SignedInUser,
  type TestApp,
} from './support.js';

let test: TestApp;
let alice: SignedInUser;
let bob: SignedInUser;
let keyCounter = 0;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function call(
  user: SignedInUser,
  method: Method,
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  return test.app.inject({
    method,
    url,
    headers: { ...user.headers, ...headers },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

async function createDeal(user: SignedInUser, name = 'Deal'): Promise<DealDto> {
  const response = await call(user, 'POST', '/v1/deals', { name });
  expect(response.statusCode).toBe(201);
  return response.json();
}

const westpacQuote = {
  feeSignatureId: presetIds.westpacDealer,
  assetDescription: 'New Land Rover Defender',
  financeAmount: '30000',
  termMonths: 60,
  baseRate: '0.085',
  commissionRate: '0.04',
};

async function saveQuote(
  user: SignedInUser,
  dealId: string,
  body: Record<string, unknown> = westpacQuote,
  key = `key-${++keyCounter}-${Date.now()}`,
) {
  return call(user, 'POST', `/v1/deals/${dealId}/quotes`, body, {
    'idempotency-key': key,
  });
}

beforeAll(async () => {
  test = await createTestApp();
  alice = await signIn(test.app, uniqueEmail('alice'));
  bob = await signIn(test.app, uniqueEmail('bob'));
});

afterAll(async () => {
  await test.close();
});

describe('deals and the quote log', () => {
  it('creates a deal with its quote log and lists it first', async () => {
    const deal = await createDeal(alice, 'Smith family car');
    expect(deal).toMatchObject({ name: 'Smith family car', quoteCount: 0 });
    const list = (await call(alice, 'GET', '/v1/deals?limit=1')).json();
    expect(list.items[0].id).toBe(deal.id);
  });

  it('paginates deals deterministically with a keyset cursor', async () => {
    const user = await signIn(test.app, uniqueEmail('pager'));
    for (const name of ['one', 'two', 'three']) await createDeal(user, name);
    const first = (await call(user, 'GET', '/v1/deals?limit=2')).json();
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (
      await call(user, 'GET', `/v1/deals?limit=2&cursor=${first.nextCursor}`)
    ).json();
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const names = [...first.items, ...second.items].map(
      (deal: DealDto) => deal.name,
    );
    expect(new Set(names)).toEqual(new Set(['one', 'two', 'three']));
  });

  it('renames and deletes a deal, removing its quotes', async () => {
    const deal = await createDeal(alice);
    const quote = (await saveQuote(alice, deal.id)).json<QuoteDto>();
    expect(
      (
        await call(alice, 'PATCH', `/v1/deals/${deal.id}`, { name: 'Renamed' })
      ).json().name,
    ).toBe('Renamed');
    expect(
      (await call(alice, 'DELETE', `/v1/deals/${deal.id}`)).statusCode,
    ).toBe(204);
    expect(
      (await call(alice, 'GET', `/v1/quotes/${quote.id}`)).statusCode,
    ).toBe(404);
  });
});

describe('server-calculated quotes', () => {
  it('recalculates from the preset and stores the snapshot', async () => {
    const deal = await createDeal(alice);
    const response = await saveQuote(alice, deal.id);
    expect(response.statusCode).toBe(201);
    const quote = response.json<QuoteDto>();
    // Westpac Dealer preset: $500 financed lender fee, advance, 4% commission.
    expect(quote).toMatchObject({
      dealId: deal.id,
      lenderName: 'Westpac',
      feeSignatureName: 'Dealer',
      paymentTiming: 'advance',
      netAmountFinanced: '30500.00',
      commission: '1220.00',
      amountFinanced: '31720.00',
      lenderFee: '500.00',
      assetDescription: 'New Land Rover Defender',
      engineVersion: 'finance-1.0.0',
    });
    expect(Number(quote.comparisonRate)).toBeGreaterThan(0.085);
    expect(
      (await call(alice, 'GET', `/v1/deals/${deal.id}`)).json().quoteCount,
    ).toBe(1);
  });

  it('ignores nothing silently: client-supplied results or owners are rejected', async () => {
    const deal = await createDeal(alice);
    for (const extra of [
      { monthlyPayment: '1.00' },
      { ownerUserId: bob.tokens.user.id },
      { commission: '0' },
    ]) {
      const response = await saveQuote(alice, deal.id, {
        ...westpacQuote,
        ...extra,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('applies lender rules: commission cap, dynamic fees and overs', async () => {
    const deal = await createDeal(alice);
    const capped = await saveQuote(alice, deal.id, {
      ...westpacQuote,
      commissionRate: '0.07',
    });
    expect(capped.statusCode).toBe(400);
    expect(capped.json().error.fields.commissionRate).toContain('6%');

    const metro = await saveQuote(alice, deal.id, {
      feeSignatureId: presetIds.metro,
      financeAmount: '20000',
      termMonths: 48,
      baseRate: '0.09',
      commissionRate: '0.03',
      originationFee: '300',
    });
    expect(metro.statusCode).toBe(201);
    // $275 minimum + $300 origination, capped at $450; plus $8.25 PPSR.
    expect(metro.json().lenderFee).toBe('458.25');

    const overs = await saveQuote(alice, deal.id, {
      feeSignatureId: presetIds.brandedDealer,
      financeAmount: '30000',
      termMonths: 60,
      baseRate: '0.0669',
      contractRate: '0.08',
    });
    expect(overs.statusCode).toBe(201);
    expect(overs.json()).toMatchObject({
      commissionModel: 'overs',
      contractRate: '0.08',
    });
  });

  it('charges the private-sale fee whenever a Private signature is chosen', async () => {
    const deal = await createDeal(alice);
    const response = await saveQuote(alice, deal.id, {
      ...westpacQuote,
      feeSignatureId: presetIds.westpacPrivate,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      feeSignatureName: 'Private',
      lenderFee: '750.00',
      netAmountFinanced: '30750.00',
    });
  });

  it('computes Autopay daily interest with required dates', async () => {
    const deal = await createDeal(alice);
    const missing = await saveQuote(alice, deal.id, {
      feeSignatureId: presetIds.autopay,
      financeAmount: '50000',
      termMonths: 60,
      baseRate: '0.0735',
      commissionRate: '0.04',
    });
    expect(missing.statusCode).toBe(400);
    const saved = await saveQuote(alice, deal.id, {
      feeSignatureId: presetIds.autopay,
      financeAmount: '50000',
      termMonths: 60,
      baseRate: '0.0735',
      commissionRate: '0.04',
      settlementDate: '2025-05-31',
      firstRepaymentDate: '2025-06-06',
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({
      interestMethod: 'daily',
      paymentTiming: 'arrears',
      monthlyFee: '12.50',
      comparisonRate: '0.0895',
    });
  });

  it('replays an identical retry and rejects a reused key with a different body', async () => {
    const deal = await createDeal(alice);
    const first = await saveQuote(
      alice,
      deal.id,
      westpacQuote,
      'retry-key-001',
    );
    const retry = await saveQuote(
      alice,
      deal.id,
      westpacQuote,
      'retry-key-001',
    );
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().id).toBe(first.json().id);
    const different = await saveQuote(
      alice,
      deal.id,
      { ...westpacQuote, termMonths: 48 },
      'retry-key-001',
    );
    expect(different.statusCode).toBe(409);
    expect(
      (await call(alice, 'GET', `/v1/deals/${deal.id}/quotes`)).json().items,
    ).toHaveLength(1);
  });

  it('creates exactly one quote under concurrent identical retries', async () => {
    const deal = await createDeal(alice);
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        saveQuote(alice, deal.id, westpacQuote, 'concurrent-key-1'),
      ),
    );
    expect(
      responses.every((response) => [200, 201].includes(response.statusCode)),
    ).toBe(true);
    expect(new Set(responses.map((response) => response.json().id)).size).toBe(
      1,
    );
    expect(
      (await call(alice, 'GET', `/v1/deals/${deal.id}/quotes`)).json().items,
    ).toHaveLength(1);
  });

  it('keeps saved quotes stable when their fee signature later changes or is deleted', async () => {
    const copy = (
      await call(alice, 'POST', '/v1/fee-signatures', {
        copyFromId: presetIds.westpacDealer,
        name: 'My Westpac',
      })
    ).json<FeeSignatureDto>();
    const deal = await createDeal(alice);
    const before = (
      await saveQuote(alice, deal.id, {
        ...westpacQuote,
        feeSignatureId: copy.id,
      })
    ).json<QuoteDto>();

    const {
      id,
      lenderName,
      isPreset,
      sourceFeeSignatureId,
      interestMethod,
      version,
      createdAt,
      updatedAt,
      ...definition
    } = copy;
    void [
      id,
      lenderName,
      isPreset,
      sourceFeeSignatureId,
      interestMethod,
      version,
      createdAt,
      updatedAt,
    ];
    const updated = await call(alice, 'PUT', `/v1/fee-signatures/${copy.id}`, {
      ...definition,
      fees: { establishment: { amount: '900', financed: true } },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().version).toBe(2);

    const after = (
      await call(alice, 'GET', `/v1/quotes/${before.id}`)
    ).json<QuoteDto>();
    expect(after).toEqual(before);
    expect(after.feeSignatureVersion).toBe(1);

    expect(
      (await call(alice, 'DELETE', `/v1/fee-signatures/${copy.id}`)).statusCode,
    ).toBe(204);
    const orphaned = (
      await call(alice, 'GET', `/v1/quotes/${before.id}`)
    ).json<QuoteDto>();
    expect(orphaned).toEqual({ ...before, feeSignatureId: null });
  });

  it('edits notes only and clears all quotes of a deal', async () => {
    const deal = await createDeal(alice);
    const quote = (await saveQuote(alice, deal.id)).json<QuoteDto>();
    await saveQuote(alice, deal.id);
    const noted = await call(alice, 'PATCH', `/v1/quotes/${quote.id}`, {
      notes: 'Client prefers 48 months',
    });
    expect(noted.json()).toMatchObject({
      notes: 'Client prefers 48 months',
      monthlyPayment: quote.monthlyPayment,
    });
    expect(
      (
        await call(alice, 'PATCH', `/v1/quotes/${quote.id}`, {
          notes: 'x',
          monthlyPayment: '1',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await call(alice, 'DELETE', `/v1/deals/${deal.id}/quotes`)).json(),
    ).toEqual({ deleted: 2 });
    expect(
      (await call(alice, 'GET', `/v1/deals/${deal.id}/quotes`)).json().items,
    ).toEqual([]);
  });
});

describe('cross-user isolation through the API (IDOR)', () => {
  let deal: DealDto;
  let quote: QuoteDto;
  let lender: LenderDto;
  let signature: FeeSignatureDto;

  beforeAll(async () => {
    deal = await createDeal(alice, 'Private deal');
    quote = (await saveQuote(alice, deal.id)).json();
    lender = (
      await call(alice, 'POST', '/v1/lenders', {
        name: `Alice Lender ${Date.now()}`,
      })
    ).json();
    signature = (
      await call(alice, 'POST', '/v1/fee-signatures', {
        copyFromId: presetIds.pepperDealer,
      })
    ).json();
    expect(
      (
        await call(alice, 'PUT', `/v1/lenders/${lender.id}/logo`, pngBytes, {
          'content-type': 'image/png',
        })
      ).statusCode,
    ).toBe(200);
  });

  it.each([
    ['GET', () => `/v1/deals/${deal.id}`],
    ['PATCH', () => `/v1/deals/${deal.id}`, { name: 'stolen' }],
    ['DELETE', () => `/v1/deals/${deal.id}`],
    ['GET', () => `/v1/deals/${deal.id}/quotes`],
    ['DELETE', () => `/v1/deals/${deal.id}/quotes`],
    ['GET', () => `/v1/quotes/${quote.id}`],
    ['PATCH', () => `/v1/quotes/${quote.id}`, { notes: 'stolen' }],
    ['DELETE', () => `/v1/quotes/${quote.id}`],
    ['PATCH', () => `/v1/lenders/${lender.id}`, { name: 'stolen' }],
    ['DELETE', () => `/v1/lenders/${lender.id}`],
    ['GET', () => `/v1/lenders/${lender.id}/logo`],
    ['DELETE', () => `/v1/lenders/${lender.id}/logo`],
    ['GET', () => `/v1/fee-signatures/${signature.id}`],
    ['DELETE', () => `/v1/fee-signatures/${signature.id}`],
  ] as const)(
    "%s another user's resource returns 404",
    async (method, url, payload?: unknown) => {
      const response = await call(bob, method, url(), payload);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
    },
  );

  it("cannot save a quote into another user's deal or with their fee signature", async () => {
    expect((await saveQuote(bob, deal.id)).statusCode).toBe(404);
    const own = await createDeal(bob);
    const borrowed = await saveQuote(bob, own.id, {
      feeSignatureId: signature.id,
      financeAmount: '10000',
      termMonths: 36,
      baseRate: '0.1',
    });
    expect(borrowed.statusCode).toBe(400);
    expect(borrowed.json().error.fields.feeSignatureId).toBeDefined();
  });

  it("cannot copy another user's fee signature or upload a logo to their lender", async () => {
    expect(
      (
        await call(bob, 'POST', '/v1/fee-signatures', {
          copyFromId: signature.id,
        })
      ).statusCode,
    ).toBe(404);
    const upload = await call(
      bob,
      'PUT',
      `/v1/lenders/${lender.id}/logo`,
      pngBytes,
      {
        'content-type': 'image/png',
      },
    );
    expect(upload.statusCode).toBe(404);
  });

  it('lists only presets plus own lenders and signatures', async () => {
    const lenders = (await call(bob, 'GET', '/v1/lenders')).json()
      .items as LenderDto[];
    expect(lenders.some((item) => item.id === lender.id)).toBe(false);
    expect(lenders.filter((item) => item.isPreset)).toHaveLength(6);
    const signatures = (await call(bob, 'GET', '/v1/fee-signatures')).json()
      .items as FeeSignatureDto[];
    expect(signatures.some((item) => item.id === signature.id)).toBe(false);
    expect(signatures.filter((item) => item.isPreset)).toHaveLength(10);
  });

  it("left Alice's data untouched", async () => {
    expect(
      (await call(alice, 'GET', `/v1/quotes/${quote.id}`)).json().notes,
    ).toBe('');
    expect((await call(alice, 'GET', `/v1/deals/${deal.id}`)).json().name).toBe(
      'Private deal',
    );
  });
});

describe('lenders, fee signatures and logos', () => {
  it('refuses to modify presets', async () => {
    expect(
      (
        await call(alice, 'PATCH', `/v1/lenders/${presetIds.pepperLender}`, {
          name: 'x',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(
          alice,
          'DELETE',
          `/v1/fee-signatures/${presetIds.westpacDealer}`,
        )
      ).statusCode,
    ).toBe(404);
    const upload = await call(
      alice,
      'PUT',
      `/v1/lenders/${presetIds.pepperLender}/logo`,
      pngBytes,
      {
        'content-type': 'image/png',
      },
    );
    expect(upload.statusCode).toBe(404);
  });

  it('creates a custom fee signature and rejects model/parameter mismatches', async () => {
    const lender = (
      await call(alice, 'POST', '/v1/lenders', { name: `Custom ${Date.now()}` })
    ).json<LenderDto>();
    const valid = await call(alice, 'POST', '/v1/fee-signatures', {
      lenderId: lender.id,
      name: 'Dealer',
      commissionModel: 'loaded',
      paymentTiming: 'advance',
      loadingFactor: '0.4',
      fees: { establishment: { amount: '499', financed: false } },
    });
    expect(valid.statusCode).toBe(201);
    expect(valid.json()).toMatchObject({
      isPreset: false,
      interestMethod: 'monthly',
    });
    const invalid = await call(alice, 'POST', '/v1/fee-signatures', {
      lenderId: lender.id,
      name: 'Broken',
      commissionModel: 'overs',
      paymentTiming: 'arrears',
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.fields.commissionModel).toContain(
      'baseCommission',
    );
    const duplicate = await call(alice, 'POST', '/v1/lenders', {
      name: lender.name,
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it('rounds repayments up to whole dollars only for signatures that ask for it', async () => {
    // Built-in signatures never carry the flag, so app versions that predate it (and
    // parse strictly) keep working against this API.
    const presets = (await call(alice, 'GET', '/v1/fee-signatures')).json<{
      items: FeeSignatureDto[];
    }>();
    expect(
      presets.items.filter(
        (item) => item.isPreset && 'roundPaymentUpToDollar' in item,
      ),
    ).toEqual([]);

    const lender = (
      await call(alice, 'POST', '/v1/lenders', {
        name: `Whole dollar ${Date.now()}`,
      })
    ).json<LenderDto>();
    const definition = {
      lenderId: lender.id,
      name: 'Dealer',
      commissionModel: 'capitalised',
      paymentTiming: 'arrears',
      maxCommissionRate: '0.06',
      fees: { establishment: { amount: '495', financed: true } },
    };
    const created = await call(alice, 'POST', '/v1/fee-signatures', {
      ...definition,
      roundPaymentUpToDollar: true,
    });
    expect(created.statusCode).toBe(201);
    const signature = created.json<FeeSignatureDto>();
    expect(signature.roundPaymentUpToDollar).toBe(true);

    // The server recalculates with the lender's rule: $650.68 becomes $651.00.
    const deal = await createDeal(alice, 'Whole-dollar deal');
    const saved = await saveQuote(alice, deal.id, {
      ...westpacQuote,
      feeSignatureId: signature.id,
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.json<QuoteDto>().monthlyPayment).toBe('651.00');
    expect(saved.json<QuoteDto>().totalHiring).toBe('39036.02');

    // An update that omits the flag (as older app versions do) keeps it...
    const kept = await call(
      alice,
      'PUT',
      `/v1/fee-signatures/${signature.id}`,
      { ...definition, name: 'Dealer renamed' },
    );
    expect(kept.json<FeeSignatureDto>().roundPaymentUpToDollar).toBe(true);
    // ...a copy keeps it too...
    const copy = await call(alice, 'POST', '/v1/fee-signatures', {
      copyFromId: signature.id,
    });
    expect(copy.json<FeeSignatureDto>().roundPaymentUpToDollar).toBe(true);
    // ...and `false` switches it off (then the DTO omits it).
    const off = await call(alice, 'PUT', `/v1/fee-signatures/${signature.id}`, {
      ...definition,
      roundPaymentUpToDollar: false,
    });
    expect('roundPaymentUpToDollar' in off.json<FeeSignatureDto>()).toBe(false);
  });

  it('stores, serves, replaces and deletes a logo through the API only', async () => {
    const lender = (
      await call(alice, 'POST', '/v1/lenders', { name: `Logo ${Date.now()}` })
    ).json<LenderDto>();
    const put = await call(
      alice,
      'PUT',
      `/v1/lenders/${lender.id}/logo`,
      pngBytes,
      { 'content-type': 'image/png' },
    );
    expect(put.statusCode).toBe(200);
    expect(put.json().hasLogo).toBe(true);
    const got = await call(alice, 'GET', `/v1/lenders/${lender.id}/logo`);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(got.rawPayload.equals(pngBytes)).toBe(true);
    const keysBefore = test.storage
      .keys()
      .filter((key) => key.includes(lender.id));
    await call(alice, 'PUT', `/v1/lenders/${lender.id}/logo`, pngBytes, {
      'content-type': 'image/png',
    });
    const keysAfter = test.storage
      .keys()
      .filter((key) => key.includes(lender.id));
    expect(keysAfter).toHaveLength(1);
    expect(keysAfter).not.toEqual(keysBefore);
    expect(
      (await call(alice, 'DELETE', `/v1/lenders/${lender.id}/logo`)).statusCode,
    ).toBe(204);
    expect(
      test.storage.keys().filter((key) => key.includes(lender.id)),
    ).toEqual([]);
  });

  it('rejects SVG, mislabelled and oversized uploads', async () => {
    const lender = (
      await call(alice, 'POST', '/v1/lenders', { name: `Bad ${Date.now()}` })
    ).json<LenderDto>();
    const url = `/v1/lenders/${lender.id}/logo`;
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect(
      (await call(alice, 'PUT', url, svg, { 'content-type': 'image/svg+xml' }))
        .statusCode,
    ).toBe(415);
    expect(
      (await call(alice, 'PUT', url, svg, { 'content-type': 'image/png' }))
        .statusCode,
    ).toBe(415);
    expect(
      (
        await call(alice, 'PUT', url, pngBytes, {
          'content-type': 'image/jpeg',
        })
      ).statusCode,
    ).toBe(415);
    const large = Buffer.concat([pngBytes, Buffer.alloc(600 * 1024)]);
    expect(
      (await call(alice, 'PUT', url, large, { 'content-type': 'image/png' }))
        .statusCode,
    ).toBe(413);
    expect(
      test.storage.keys().filter((key) => key.includes(lender.id)),
    ).toEqual([]);
  });
});

describe('validation', () => {
  it.each([
    ['a malformed ID', 'GET', '/v1/deals/not-a-uuid'],
    ['a malformed cursor', 'GET', '/v1/deals?cursor=@@@'],
    ['an out-of-range limit', 'GET', '/v1/deals?limit=1000'],
  ] as const)('rejects %s', async (_label, method, url) => {
    expect((await call(alice, method, url)).statusCode).toBe(400);
  });

  it.each([
    ['an empty name', { name: '   ' }],
    ['a name that is too long', { name: 'x'.repeat(201) }],
    ['control characters', { name: 'bad\u0000name' }],
    [
      'an unexpected property',
      { name: 'ok', ownerUserId: '00000000-0000-4000-8000-000000000001' },
    ],
  ])('rejects a deal with %s', async (_label, body) => {
    const response = await call(alice, 'POST', '/v1/deals', body);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.fields).toBeDefined();
  });

  it.each([
    ['negative money', { financeAmount: '-1' }],
    ['three decimals', { financeAmount: '100.001' }],
    ['an amount beyond the supported range', { financeAmount: '1000000000' }],
    ['a rate above 1', { baseRate: '1.5' }],
    ['a fractional term', { termMonths: 12.5 }],
    ['an invalid date', { settlementDate: '2025-02-30' }],
    ['an unknown fee kind', { feeFinancing: { stampDuty: true } }],
    ['notes that are too long', { notes: 'n'.repeat(2001) }],
    ['a balloon above the amount financed', { balloon: '99999' }],
  ])('rejects a quote with %s', async (_label, override) => {
    const deal = await createDeal(alice);
    const response = await saveQuote(alice, deal.id, {
      ...westpacQuote,
      ...override,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('requires an Idempotency-Key to save a quote', async () => {
    const deal = await createDeal(alice);
    const response = await call(
      alice,
      'POST',
      `/v1/deals/${deal.id}/quotes`,
      westpacQuote,
    );
    expect(response.statusCode).toBe(400);
  });

  it('rejects oversized JSON bodies', async () => {
    const response = await call(alice, 'POST', '/v1/deals', {
      name: 'x',
      padding: 'p'.repeat(70 * 1024),
    });
    expect(response.statusCode).toBe(413);
  });
});

describe('transactions', () => {
  it('rolls back every statement of a failed unit of work', async () => {
    const name = `rollback-${Date.now()}`;
    await expect(
      test.database.withUser(alice.principal, async (sql) => {
        await sql.query(
          'INSERT INTO app.deals (owner_user_id, name) VALUES ($1, $2)',
          [alice.tokens.user.id, name],
        );
        await sql.query('SELECT 1 / 0');
      }),
    ).rejects.toMatchObject({ code: '22012' });
    const rows = await test.database.withUser(alice.principal, (sql) =>
      sql.query('SELECT 1 FROM app.deals WHERE name = $1', [name]),
    );
    expect(rows).toEqual([]);
  });

  it('never leaves a deal without its quote log', async () => {
    const orphaned = await test.database.withUser(alice.principal, (sql) =>
      sql.query(
        'SELECT d.id FROM app.deals d LEFT JOIN app.quote_logs q ON q.deal_id = d.id WHERE q.id IS NULL',
      ),
    );
    expect(orphaned).toEqual([]);
  });
});
