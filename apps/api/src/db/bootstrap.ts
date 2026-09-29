import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type pg from 'pg';

/**
 * PostgreSQL SCRAM-SHA-256 verifier (RFC 5802/7677 stored form). Passwords are limited
 * to printable ASCII so no SASLprep normalisation is needed.
 */
export function scramSha256Verifier(
  password: string,
  iterations = 4096,
): string {
  if (!/^[\x21-\x7e]{16,256}$/.test(password))
    throw new Error(
      'Database passwords must be 16-256 printable ASCII characters',
    );
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

export const ownerRole = 'swyft_owner';
export const appRole = 'swyft_app';

export interface BootstrapOptions {
  readonly database: string;
  readonly ownerPassword: string;
  readonly appPassword: string;
}

/** A failed step, named without any value (values may be secrets). */
export class BootstrapError extends Error {
  constructor(step: string, code: string | undefined) {
    super(`Bootstrap step failed: ${step}${code ? ` (SQLSTATE ${code})` : ''}`);
    this.name = 'BootstrapError';
  }
}

async function execute(
  client: pg.Client,
  step: string,
  template: string,
  ...values: string[]
): Promise<void> {
  try {
    // format() quotes identifiers (%I) and literals (%L) server-side; secrets are never interpolated in JS.
    const { rows } = await client.query<{ statement: string }>(
      `SELECT format('${template}', ${values.map((_, index) => `$${index + 1}::text`).join(', ')}) AS statement`,
      values,
    );
    const statement = rows[0]?.statement;
    if (!statement) throw new Error('empty statement');
    await client.query(statement);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined;
    throw new BootstrapError(step, code);
  }
}

/**
 * One-time cluster setup, run by an administrator (Cloud SQL: the `postgres` user, which
 * has CREATEROLE but is not a superuser): the migration/owner role, the least-privilege
 * runtime role, and the database. Idempotent: re-running rotates the two passwords.
 */
export async function bootstrapCluster(
  admin: pg.Client,
  options: BootstrapOptions,
): Promise<void> {
  for (const role of [ownerRole, appRole]) {
    const exists = await admin.query(
      'SELECT 1 FROM pg_roles WHERE rolname = $1',
      [role],
    );
    // Defaults are already NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
    // naming those attributes would require a real superuser, which Cloud SQL does not grant.
    if (exists.rowCount === 0)
      await execute(
        admin,
        `create role ${role}`,
        'CREATE ROLE %I LOGIN NOINHERIT',
        role,
      );
  }
  // The runtime role must never be privileged, even if it was created elsewhere: check, don't alter.
  const flags = await admin.query<Record<string, boolean>>(
    `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
     FROM pg_roles WHERE rolname = $1`,
    [appRole],
  );
  const privileged = Object.entries(flags.rows[0] ?? {}).filter(
    ([, value]) => value,
  );
  if (privileged.length > 0)
    throw new BootstrapError(
      `runtime role has privileged attributes: ${privileged.map(([name]) => name).join(', ')}`,
      undefined,
    );
  // Only SCRAM verifiers reach the server, so no plaintext password can appear in
  // statement text or server logs.
  await execute(
    admin,
    'set owner password',
    'ALTER ROLE %I PASSWORD %L',
    ownerRole,
    scramSha256Verifier(options.ownerPassword),
  );
  await execute(
    admin,
    'set app password',
    'ALTER ROLE %I PASSWORD %L',
    appRole,
    scramSha256Verifier(options.appPassword),
  );
  // Cloud SQL's admin is not a superuser; membership lets it create a database owned by swyft_owner.
  await execute(
    admin,
    'grant owner role to admin',
    'GRANT %I TO CURRENT_USER',
    ownerRole,
  );

  const database = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [options.database],
  );
  if (database.rowCount === 0)
    await execute(
      admin,
      'create database',
      'CREATE DATABASE %I OWNER %I',
      options.database,
      ownerRole,
    );
  await execute(
    admin,
    'revoke database defaults',
    'REVOKE ALL ON DATABASE %I FROM PUBLIC',
    options.database,
  );
  await execute(
    admin,
    'grant owner connect',
    'GRANT CONNECT ON DATABASE %I TO %I',
    options.database,
    ownerRole,
  );
  await execute(
    admin,
    'grant app connect',
    'GRANT CONNECT ON DATABASE %I TO %I',
    options.database,
    appRole,
  );
}
