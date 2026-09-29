import { randomBytes, createHash } from 'node:crypto';
import type pg from 'pg';
import type { Migration } from './migrator.js';

export interface VerificationResult {
  readonly checks: readonly {
    readonly name: string;
    readonly ok: boolean;
    readonly detail?: string;
  }[];
  readonly ok: boolean;
}

interface ProbeUser {
  readonly id: string;
  readonly accessHash: Buffer;
}

const tables = 10;

function sqlCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

/**
 * Verifies a deployed database: runtime-role hardening, migration integrity and
 * cross-user RLS isolation through the real runtime role. Two synthetic users (provider
 * `dev-local`, subject `rls-probe:*`) are created by the owner and always deleted.
 *
 * @param owner connected as swyft_owner (migration role)
 * @param app connected as swyft_app (the role Cloud Run uses)
 */
export async function verifyDeployment(
  owner: pg.Client,
  app: pg.Client,
  migrations: readonly Migration[],
): Promise<VerificationResult> {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const check = (name: string, ok: boolean, detail?: string) =>
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail });

  // --- Role and schema hardening -------------------------------------------------
  const role = (
    await owner.query(
      `SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
         (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid) AS relations,
         pg_has_role('swyft_app', 'swyft_owner', 'MEMBER') AS owner_member
       FROM pg_roles r WHERE r.rolname = 'swyft_app'`,
    )
  ).rows[0];
  check(
    'runtime role: not superuser, no BYPASSRLS/CREATEROLE/CREATEDB, owns nothing, not owner member',
    role !== undefined &&
      !role.rolsuper &&
      !role.rolbypassrls &&
      !role.rolcreaterole &&
      !role.rolcreatedb &&
      role.relations === 0 &&
      !role.owner_member,
  );
  const rls = await owner.query<{ total: number; enabled: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE c.relrowsecurity)::int AS enabled
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r' AND n.nspname IN ('app', 'auth', 'app_meta')`,
  );
  check(
    'RLS enabled on every table',
    rls.rows[0]?.total === tables && rls.rows[0]?.enabled === tables,
    `${rls.rows[0]?.enabled}/${rls.rows[0]?.total}`,
  );
  const functions = await owner.query<{ public_can: boolean; pinned: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_can,
            coalesce(p.proconfig = ARRAY['search_path=pg_catalog, pg_temp'], false) AS pinned
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'auth'`,
  );
  check(
    'auth functions: none executable by PUBLIC, search_path pinned',
    functions.rows.length > 0 &&
      functions.rows.every((row) => !row.public_can && row.pinned),
    `${functions.rows.length} functions`,
  );
  const applied = new Map(
    (
      await owner.query<{ version: string; sha256: string }>(
        'SELECT version, sha256 FROM app_meta.schema_migrations',
      )
    ).rows.map((row) => [row.version, row.sha256]),
  );
  check(
    'all migrations applied with matching checksums',
    migrations.length === applied.size &&
      migrations.every(
        (migration) => applied.get(migration.version) === migration.sha256,
      ),
    [...applied.keys()].join(','),
  );
  const presets = await owner.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM app.fee_signatures WHERE owner_user_id IS NULL',
  );
  check('ten preset fee signatures seeded', presets.rows[0]?.count === 10);

  // --- Two-user RLS probe through the runtime role --------------------------------
  const probeIds: string[] = [];
  const makeUser = async (label: string): Promise<ProbeUser> => {
    const subject = `rls-probe:${label}:${randomBytes(6).toString('hex')}`;
    const user = (
      await owner.query<{ id: string }>(
        `INSERT INTO app.users (identity_provider, identity_subject, email, email_verified)
         VALUES ('dev-local', $1, $2, true) RETURNING id`,
        [subject, `${subject.replace(/:/g, '-')}@probe.invalid`],
      )
    ).rows[0];
    if (!user) throw new Error('probe user not created');
    probeIds.push(user.id);
    const accessHash = createHash('sha256').update(randomBytes(32)).digest();
    await owner.query(
      `INSERT INTO auth.sessions (user_id, access_token_hash, access_expires_at, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, now() + interval '5 minutes', now() + interval '5 minutes', now() + interval '5 minutes')`,
      [user.id, accessHash],
    );
    return { id: user.id, accessHash };
  };

  const asUser = async <T>(
    user: ProbeUser | null,
    work: () => Promise<T>,
  ): Promise<T> => {
    await app.query('BEGIN');
    try {
      if (user)
        await app.query(
          "SELECT set_config('app.access_token_hash', $1, true)",
          [user.accessHash.toString('hex')],
        );
      return await work();
    } finally {
      await app.query('ROLLBACK');
    }
  };
  const rejects = async (
    user: ProbeUser,
    text: string,
    values: unknown[],
    codes: string[],
  ) =>
    asUser(user, async () => {
      try {
        await app.query(text, values);
        return false;
      } catch (error) {
        return codes.includes(sqlCode(error) ?? '');
      }
    });
  const count = async (
    user: ProbeUser | null,
    text: string,
    values: unknown[] = [],
  ) => asUser(user, async () => (await app.query(text, values)).rowCount ?? -1);

  try {
    const alice = await makeUser('a');
    const bob = await makeUser('b');
    const bobDeal = (
      await owner.query<{ id: string }>(
        "INSERT INTO app.deals (owner_user_id, name) VALUES ($1, 'probe') RETURNING id",
        [bob.id],
      )
    ).rows[0]?.id;
    const bobLog = (
      await owner.query<{ id: string }>(
        'INSERT INTO app.quote_logs (owner_user_id, deal_id) VALUES ($1, $2) RETURNING id',
        [bob.id, bobDeal],
      )
    ).rows[0]?.id;
    const bobLender = (
      await owner.query<{ id: string }>(
        "INSERT INTO app.lenders (owner_user_id, name, logo_object_key, logo_content_type) VALUES ($1, 'Probe lender', $2, 'image/png') RETURNING id",
        [bob.id, `lender-logos/${bob.id}/probe.png`],
      )
    ).rows[0]?.id;
    const bobSignature = (
      await owner.query<{ id: string }>(
        `INSERT INTO app.fee_signatures (owner_user_id, lender_id, name, commission_model, interest_method, payment_timing)
         VALUES ($1, $2, 'Probe', 'capitalised', 'monthly', 'arrears') RETURNING id`,
        [bob.id, bobLender],
      )
    ).rows[0]?.id;
    const bobQuote = (
      await owner.query<{ id: string }>(
        `INSERT INTO app.quotes (owner_user_id, quote_log_id, fee_signature_id, lender_name, fee_signature_name,
           fee_signature_version, commission_model, interest_method, payment_timing, finance_amount, term_months,
           balloon, base_rate, lender_fee, origination_fee, monthly_fee, upfront_fees, net_amount_financed,
           amount_financed, monthly_payment, gross_monthly_payment, total_hiring, calculation_input,
           calculation_result, fee_signature_snapshot, engine_version, idempotency_key, request_sha256)
         VALUES ($1, $2, $3, 'Probe lender', 'Probe', 1, 'capitalised', 'monthly', 'arrears', 1000, 12, 0, 0.05,
           0, 0, 0, 0, 1000, 1000, 90, 90, 1080, '{}', '{}', '{}', 'probe', 'probe-key-0001', $4)
         RETURNING id`,
        [bob.id, bobLog, bobSignature, Buffer.alloc(32)],
      )
    ).rows[0]?.id;

    check(
      'owner sees own rows through the runtime role',
      (await count(bob, 'SELECT 1 FROM app.quotes WHERE id = $1', [
        bobQuote,
      ])) === 1,
    );
    check(
      'SELECT of another user: deals, logs, quotes, lenders, signatures, logo metadata hidden',
      (await count(alice, 'SELECT 1 FROM app.deals WHERE id = $1', [
        bobDeal,
      ])) === 0 &&
        (await count(alice, 'SELECT 1 FROM app.quote_logs WHERE id = $1', [
          bobLog,
        ])) === 0 &&
        (await count(alice, 'SELECT 1 FROM app.quotes WHERE id = $1', [
          bobQuote,
        ])) === 0 &&
        (await count(alice, 'SELECT 1 FROM app.lenders WHERE id = $1', [
          bobLender,
        ])) === 0 &&
        (await count(alice, 'SELECT 1 FROM app.fee_signatures WHERE id = $1', [
          bobSignature,
        ])) === 0 &&
        (await count(
          alice,
          'SELECT 1 FROM app.lenders WHERE logo_object_key IS NOT NULL AND owner_user_id IS NOT NULL',
        )) === 0,
    );
    check(
      'UPDATE/DELETE of another user are no-ops',
      (await count(alice, "UPDATE app.deals SET name = 'x' WHERE id = $1", [
        bobDeal,
      ])) === 0 &&
        (await count(alice, "UPDATE app.quotes SET notes = 'x' WHERE id = $1", [
          bobQuote,
        ])) === 0 &&
        (await count(alice, 'DELETE FROM app.quotes WHERE id = $1', [
          bobQuote,
        ])) === 0 &&
        (await count(alice, 'DELETE FROM app.lenders WHERE id = $1', [
          bobLender,
        ])) === 0,
    );
    check(
      'INSERT claiming another owner is rejected',
      await rejects(
        alice,
        "INSERT INTO app.deals (owner_user_id, name) VALUES ($1, 'forged')",
        [bob.id],
        ['42501'],
      ),
    );
    check(
      "cannot attach a log to another user's deal",
      await rejects(
        alice,
        'INSERT INTO app.quote_logs (owner_user_id, deal_id) VALUES ($1, $2)',
        [alice.id, bobDeal],
        ['23503', '23505'],
      ),
    );
    check(
      "cannot reference another user's lender or fee signature",
      (await rejects(
        alice,
        `INSERT INTO app.fee_signatures (owner_user_id, lender_id, name, commission_model, interest_method, payment_timing)
         VALUES ($1, $2, 'x', 'capitalised', 'monthly', 'arrears')`,
        [alice.id, bobLender],
        ['42501'],
      )) &&
        (await rejects(
          alice,
          `INSERT INTO app.fee_signatures (owner_user_id, lender_id, source_fee_signature_id, name, commission_model, interest_method, payment_timing)
           VALUES ($1, '00000000-0000-4000-8000-000000000001', $2, 'x', 'capitalised', 'monthly', 'arrears')`,
          [alice.id, bobSignature],
          ['42501'],
        )),
    );
    check(
      'quote calculation columns immutable, auth tables inaccessible',
      (await rejects(
        bob,
        'UPDATE app.quotes SET monthly_payment = 1 WHERE id = $1',
        [bobQuote],
        ['42501'],
      )) && (await rejects(bob, 'SELECT * FROM auth.sessions', [], ['42501'])),
    );
    check(
      'no identity without a valid token hash',
      (await count(null, 'SELECT 1 FROM app.deals')) === 0 &&
        (await count(null, 'SELECT 1 FROM app.users')) === 0,
    );
  } finally {
    if (probeIds.length > 0)
      await owner.query('DELETE FROM app.users WHERE id = ANY($1::uuid[])', [
        probeIds,
      ]);
  }
  const leftovers = await owner.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM app.users WHERE identity_subject LIKE 'rls-probe:%'",
  );
  check('probe users cleaned up', leftovers.rows[0]?.count === 0);
  return { checks, ok: checks.every((item) => item.ok) };
}
