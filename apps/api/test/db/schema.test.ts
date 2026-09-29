import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  migrate,
  MigrationError,
  readMigrations,
} from '../../src/db/migrator.js';
import { appRoleClient, ownerClient } from './support.js';

let owner: pg.Client;
let app: pg.Client;

beforeAll(async () => {
  owner = await ownerClient();
  app = await appRoleClient();
});

afterAll(async () => {
  await owner.end();
  await app.end();
});

describe('runtime role least privilege', () => {
  it('is not superuser, cannot bypass RLS and cannot create roles or databases', async () => {
    const { rows } = await owner.query(
      `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
       FROM pg_roles WHERE rolname = 'swyft_app'`,
    );
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
    });
  });

  it('owns no relation or function and is not a member of the owner role', async () => {
    const { rows } = await owner.query(
      `SELECT
         (SELECT count(*)::int FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
          WHERE r.rolname = 'swyft_app') AS relations,
         (SELECT count(*)::int FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
          WHERE r.rolname = 'swyft_app') AS functions,
         pg_has_role('swyft_app', 'swyft_owner', 'MEMBER') AS member`,
    );
    expect(rows[0]).toEqual({ relations: 0, functions: 0, member: false });
  });

  it('has row level security enabled on every table in app, auth and app_meta', async () => {
    const { rows } = await owner.query(
      `SELECT n.nspname || '.' || c.relname AS name, c.relrowsecurity AS rls
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r' AND n.nspname IN ('app', 'auth', 'app_meta')
       ORDER BY 1`,
    );
    expect(rows.length).toBe(10);
    expect(rows.filter((row) => !row.rls)).toEqual([]);
  });

  it('cannot read or write auth or migration tables directly', async () => {
    for (const statement of [
      'SELECT * FROM auth.sessions',
      'SELECT * FROM auth.refresh_tokens',
      'SELECT * FROM auth.login_attempts',
      'SELECT * FROM app_meta.schema_migrations',
      "INSERT INTO app.users (identity_provider, identity_subject, email, email_verified) VALUES ('google.com', 'x', 'x@x.x', true)",
    ])
      await expect(app.query(statement), statement).rejects.toMatchObject({
        code: '42501',
      });
  });

  it('grants no function to PUBLIC and only the named auth functions to the runtime role', async () => {
    const { rows } = await owner.query(
      // A NULL ACL means the default, which includes EXECUTE for PUBLIC (grantee 0).
      `SELECT p.proname, has_function_privilege('swyft_app', p.oid, 'EXECUTE') AS app_can,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_can
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'auth' ORDER BY 1`,
    );
    expect(rows.every((row) => row.app_can === true)).toBe(true);
    expect(rows.filter((row) => row.public_can)).toEqual([]);
    expect(rows.map((row) => row.proname)).toEqual([
      'begin_login',
      'complete_login',
      'current_user_id',
      'exchange_code',
      'fee_signature_visible',
      'lender_visible',
      'pending_login',
      'refresh_session',
      'resolve_access_token',
      'revoke_session',
    ]);
  });

  it('pins every SECURITY DEFINER function search_path to pg_catalog, pg_temp', async () => {
    const { rows } = await owner.query(
      `SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.prosecdef`,
    );
    expect(rows.length).toBe(10);
    for (const row of rows)
      expect(row.proconfig).toEqual(['search_path=pg_catalog, pg_temp']);
  });
});

describe('migration runner', () => {
  const directory = fileURLToPath(
    new URL('../../db/migrations', import.meta.url),
  );

  it('is idempotent when everything is applied', async () => {
    expect(await migrate(owner, await readMigrations(directory))).toEqual([]);
  });

  it('refuses to run when an applied migration has been edited', async () => {
    const migrations = await readMigrations(directory);
    const tampered = migrations.map((migration, index) =>
      index === 0 ? { ...migration, sha256: 'edited' } : migration,
    );
    await expect(migrate(owner, tampered)).rejects.toBeInstanceOf(
      MigrationError,
    );
  });

  it('seeds the ten preset fee signatures from the brief', async () => {
    const { rows } = await owner.query(
      `SELECT l.name AS lender, count(*)::int AS signatures
       FROM app.fee_signatures f JOIN app.lenders l ON l.id = f.lender_id
       WHERE f.owner_user_id IS NULL GROUP BY l.name ORDER BY l.name`,
    );
    expect(rows).toEqual([
      { lender: 'Autopay', signatures: 1 },
      { lender: 'Branded', signatures: 2 },
      { lender: 'Firstmac', signatures: 2 },
      { lender: 'Metro', signatures: 1 },
      { lender: 'Pepper', signatures: 2 },
      { lender: 'Westpac', signatures: 2 },
    ]);
  });
});
