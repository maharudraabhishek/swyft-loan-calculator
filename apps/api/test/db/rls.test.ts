import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appRoleClient,
  createTestApp,
  pngBytes,
  presetIds,
  signIn,
  uniqueEmail,
  type SignedInUser,
  type TestApp,
} from './support.js';

/**
 * Policy tests that bypass the API entirely: the runtime role talks to PostgreSQL
 * directly, so only RLS, grants and constraints stand between the two users.
 */
let test: TestApp;
let db: pg.Client;
let alice: SignedInUser;
let bob: SignedInUser;
const aliceData = {} as {
  dealId: string;
  quoteLogId: string;
  quoteId: string;
  lenderId: string;
  feeSignatureId: string;
};

async function asUser<T>(
  user: SignedInUser | null,
  work: () => Promise<T>,
): Promise<T> {
  await db.query('BEGIN');
  try {
    if (user)
      await db.query("SELECT set_config('app.access_token_hash', $1, true)", [
        user.principal.accessTokenHash.toString('hex'),
      ]);
    return await work();
  } finally {
    await db.query('ROLLBACK');
  }
}

const rows = async (text: string, values: unknown[] = []) =>
  (await db.query(text, values)).rows;
const count = async (text: string, values: unknown[] = []) =>
  (await db.query(text, values)).rowCount;

beforeAll(async () => {
  test = await createTestApp();
  db = await appRoleClient();
  alice = await signIn(test.app, uniqueEmail('alice'));
  bob = await signIn(test.app, uniqueEmail('bob'));
  // Every arrangement step must succeed, or later "hidden" assertions would pass vacuously.
  const post = async (
    url: string,
    payload: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await test.app.inject({
      method: 'POST',
      url,
      payload: payload as object,
      headers: { ...alice.headers, ...headers },
    });
    expect(response.statusCode, url).toBe(201);
    return response;
  };

  const deal = (await post('/v1/deals', { name: 'Alice truck' })).json();
  aliceData.dealId = deal.id;
  aliceData.quoteLogId = deal.quoteLogId;
  aliceData.quoteId = (
    await post(
      `/v1/deals/${deal.id}/quotes`,
      {
        feeSignatureId: presetIds.westpacDealer,
        financeAmount: '30000',
        termMonths: 60,
        baseRate: '0.085',
      },
      { 'idempotency-key': 'alice-quote-1' },
    )
  ).json().id;
  aliceData.lenderId = (
    await post('/v1/lenders', { name: 'Alice Credit' })
  ).json().id;
  aliceData.feeSignatureId = (
    await post('/v1/fee-signatures', {
      copyFromId: presetIds.westpacDealer,
      name: 'Alice Westpac',
    })
  ).json().id;
  const logo = await test.app.inject({
    method: 'PUT',
    url: `/v1/lenders/${aliceData.lenderId}/logo`,
    headers: { ...alice.headers, 'content-type': 'image/png' },
    payload: pngBytes,
  });
  expect(logo.statusCode).toBe(200);
});

afterAll(async () => {
  await db.end();
  await test.close();
});

describe('RLS isolates users at the database, independent of the API', () => {
  it('lets the owner see their own rows through the same role', async () => {
    await asUser(alice, async () => {
      expect(
        await count('SELECT 1 FROM app.deals WHERE id = $1', [
          aliceData.dealId,
        ]),
      ).toBe(1);
      expect(
        await count('SELECT 1 FROM app.quotes WHERE id = $1', [
          aliceData.quoteId,
        ]),
      ).toBe(1);
      expect(await count('SELECT 1 FROM app.users')).toBe(1);
    });
  });

  it('hides every other user row from SELECT, even without a WHERE clause', async () => {
    await asUser(bob, async () => {
      for (const table of ['deals', 'quote_logs', 'quotes'])
        expect(await count(`SELECT 1 FROM app.${table}`), table).toBe(0);
      expect(await rows('SELECT id FROM app.users')).toEqual([
        { id: bob.tokens.user.id },
      ]);
      expect(
        await count('SELECT 1 FROM app.lenders WHERE id = $1', [
          aliceData.lenderId,
        ]),
      ).toBe(0);
      expect(
        await count('SELECT 1 FROM app.fee_signatures WHERE id = $1', [
          aliceData.feeSignatureId,
        ]),
      ).toBe(0);
    });
  });

  it("hides another user's logo storage metadata", async () => {
    await asUser(bob, async () => {
      expect(
        await rows(
          'SELECT logo_object_key FROM app.lenders WHERE logo_object_key IS NOT NULL',
        ),
      ).toEqual([]);
    });
    await asUser(alice, async () => {
      const [row] = await rows(
        'SELECT logo_object_key FROM app.lenders WHERE id = $1',
        [aliceData.lenderId],
      );
      expect(row.logo_object_key).toMatch(
        new RegExp(`^lender-logos/${alice.tokens.user.id}/`),
      );
    });
  });

  it('turns UPDATE and DELETE of another user rows into no-ops', async () => {
    await asUser(bob, async () => {
      expect(
        await count("UPDATE app.deals SET name = 'stolen' WHERE id = $1", [
          aliceData.dealId,
        ]),
      ).toBe(0);
      expect(
        await count("UPDATE app.quotes SET notes = 'stolen' WHERE id = $1", [
          aliceData.quoteId,
        ]),
      ).toBe(0);
      expect(
        await count("UPDATE app.lenders SET name = 'stolen' WHERE id = $1", [
          aliceData.lenderId,
        ]),
      ).toBe(0);
      expect(
        await count('DELETE FROM app.deals WHERE id = $1', [aliceData.dealId]),
      ).toBe(0);
      expect(await count('DELETE FROM app.quotes')).toBe(0);
      expect(
        await count('DELETE FROM app.fee_signatures WHERE id = $1', [
          aliceData.feeSignatureId,
        ]),
      ).toBe(0);
    });
  });

  it('rejects INSERTs that claim another owner', async () => {
    await asUser(bob, async () => {
      await expect(
        db.query(
          "INSERT INTO app.deals (owner_user_id, name) VALUES ($1, 'forged')",
          [alice.tokens.user.id],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
    await asUser(bob, async () => {
      await expect(
        db.query(
          "INSERT INTO app.lenders (owner_user_id, name) VALUES (NULL, 'Fake preset')",
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it("cannot attach a quote log to another user's deal", async () => {
    await asUser(bob, async () => {
      // Rejected by the composite (deal_id, owner) key or the one-log-per-deal key.
      const error = await db
        .query(
          'INSERT INTO app.quote_logs (owner_user_id, deal_id) VALUES ($1, $2)',
          [bob.tokens.user.id, aliceData.dealId],
        )
        .catch((caught: { code?: string }) => caught);
      expect(['23503', '23505']).toContain((error as { code?: string }).code);
    });
  });

  it("cannot put a quote into another user's quote log (composite ownership key)", async () => {
    await asUser(bob, async () => {
      await expect(
        db.query(
          `INSERT INTO app.quotes (owner_user_id, quote_log_id, lender_name, fee_signature_name,
             fee_signature_version, commission_model, interest_method, payment_timing, finance_amount,
             term_months, balloon, base_rate, lender_fee, origination_fee, monthly_fee, upfront_fees,
             net_amount_financed, amount_financed, monthly_payment, gross_monthly_payment, total_hiring,
             calculation_input, calculation_result, fee_signature_snapshot, engine_version,
             idempotency_key, request_sha256)
           VALUES ($1, $2, 'L', 'S', 1, 'capitalised', 'monthly', 'arrears', 1000, 12, 0, 0.05, 0, 0, 0, 0,
             1000, 1000, 90, 90, 1080, '{}', '{}', '{}', 'test', 'forged-key', $3)`,
          [bob.tokens.user.id, aliceData.quoteLogId, Buffer.alloc(32)],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });

  it("cannot reference another user's fee signature or lender", async () => {
    await asUser(bob, async () => {
      await expect(
        db.query(
          `INSERT INTO app.fee_signatures (owner_user_id, lender_id, name, commission_model,
             interest_method, payment_timing)
           VALUES ($1, $2, 'Borrowed', 'capitalised', 'monthly', 'arrears')`,
          [bob.tokens.user.id, aliceData.lenderId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
    await asUser(bob, async () => {
      await expect(
        db.query(
          `INSERT INTO app.fee_signatures (owner_user_id, lender_id, source_fee_signature_id, name,
             commission_model, interest_method, payment_timing)
           VALUES ($1, $2, $3, 'Copied', 'capitalised', 'monthly', 'arrears')`,
          [
            bob.tokens.user.id,
            presetIds.pepperLender,
            aliceData.feeSignatureId,
          ],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('keeps presets read-only for every user', async () => {
    await asUser(alice, async () => {
      expect(
        await count("UPDATE app.fee_signatures SET name = 'x' WHERE id = $1", [
          presetIds.westpacDealer,
        ]),
      ).toBe(0);
      expect(
        await count('DELETE FROM app.lenders WHERE owner_user_id IS NULL'),
      ).toBe(0);
      expect(
        await count(
          'SELECT 1 FROM app.fee_signatures WHERE owner_user_id IS NULL',
        ),
      ).toBe(10);
    });
  });

  it('denies updates to immutable quote calculation columns, even for the owner', async () => {
    await asUser(alice, async () => {
      await expect(
        db.query(
          "UPDATE app.quotes SET monthly_payment = '1.00' WHERE id = $1",
          [aliceData.quoteId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
    await asUser(alice, async () => {
      expect(
        await count("UPDATE app.quotes SET notes = 'ok' WHERE id = $1", [
          aliceData.quoteId,
        ]),
      ).toBe(1);
    });
  });

  it('shows no user data without a valid access-token hash', async () => {
    await asUser(null, async () => {
      expect(await count('SELECT 1 FROM app.deals')).toBe(0);
      expect(await count('SELECT 1 FROM app.users')).toBe(0);
      expect(
        await count(
          'SELECT 1 FROM app.lenders WHERE owner_user_id IS NOT NULL',
        ),
      ).toBe(0);
    });
    await db.query('BEGIN');
    try {
      await db.query("SELECT set_config('app.access_token_hash', $1, true)", [
        '00'.repeat(32),
      ]);
      expect(await count('SELECT 1 FROM app.quotes')).toBe(0);
    } finally {
      await db.query('ROLLBACK');
    }
  });

  it('does not leak identity between transactions on the same connection', async () => {
    await asUser(alice, async () => {
      expect(await count('SELECT 1 FROM app.deals')).toBeGreaterThan(0);
    });
    expect(await count('SELECT 1 FROM app.deals')).toBe(0);
  });
});
