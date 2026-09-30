import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

const migrationFile = /^(\d{4})_([a-z0-9_]+)\.sql$/;
// Arbitrary constant shared by every runner so concurrent deploys apply migrations once.
const advisoryLockKey = 7_401_239_118;

/** One `NNNN_name.sql` file with its SHA-256, recorded when applied. */
export interface Migration {
  readonly version: string;
  readonly name: string;
  readonly sql: string;
  readonly sha256: string;
}

/** A migration could not be applied, or an applied file has changed (checksum mismatch). */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/** Reads `NNNN_name.sql` files in order. Line endings are normalised so Git checkouts hash equally. */
export async function readMigrations(directory: string): Promise<Migration[]> {
  const files = (await readdir(directory))
    .filter((file) => migrationFile.test(file))
    .sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const match = migrationFile.exec(file);
    if (!match?.[1] || !match[2]) continue;
    const sql = (await readFile(path.join(directory, file), 'utf8')).replace(
      /\r\n/g,
      '\n',
    );
    migrations.push({
      version: match[1],
      name: match[2],
      sql,
      sha256: createHash('sha256').update(sql).digest('hex'),
    });
  }
  const versions = new Set(migrations.map((migration) => migration.version));
  if (versions.size !== migrations.length)
    throw new MigrationError('Duplicate migration version');
  return migrations;
}

/**
 * Applies pending migrations as the connected (owner) role, each in its own transaction,
 * under an advisory lock. Fails if an applied migration's contents have changed.
 * @returns the versions applied by this run.
 */
export async function migrate(
  client: pg.Client,
  migrations: readonly Migration[],
): Promise<string[]> {
  await client.query('SELECT pg_advisory_lock($1)', [advisoryLockKey]);
  try {
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS app_meta;
      REVOKE ALL ON SCHEMA app_meta FROM PUBLIC;
      CREATE TABLE IF NOT EXISTS app_meta.schema_migrations (
        version text PRIMARY KEY,
        name text NOT NULL,
        sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE app_meta.schema_migrations ENABLE ROW LEVEL SECURITY;
    `);
    const applied = new Map(
      (
        await client.query<{ version: string; sha256: string }>(
          'SELECT version, sha256 FROM app_meta.schema_migrations',
        )
      ).rows.map((row) => [row.version, row.sha256]),
    );
    for (const [version, sha256] of applied) {
      const source = migrations.find(
        (migration) => migration.version === version,
      );
      if (!source)
        throw new MigrationError(
          `Applied migration ${version} is missing locally`,
        );
      if (source.sha256 !== sha256)
        throw new MigrationError(
          `Applied migration ${version} has been modified`,
        );
    }
    const appliedNow: string[] = [];
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO app_meta.schema_migrations (version, name, sha256) VALUES ($1, $2, $3)',
          [migration.version, migration.name, migration.sha256],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      appliedNow.push(migration.version);
    }
    return appliedNow;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [advisoryLockKey]);
  }
}
