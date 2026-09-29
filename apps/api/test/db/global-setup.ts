import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { bootstrapCluster } from '../../src/db/bootstrap.js';
import { migrate, readMigrations } from '../../src/db/migrator.js';

export interface TestDatabase {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly ownerPassword: string;
  readonly appPassword: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabase: TestDatabase;
  }
}

/**
 * Creates a fresh database on the disposable `postgres-test` container, bootstraps the
 * real roles with random passwords, applies the real migrations as the owner, and drops
 * the database afterwards. Tests then connect as the least-privilege runtime role.
 */
export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const adminUrl =
    process.env.TEST_DATABASE_ADMIN_URL ??
    'postgresql://postgres:local-test-only@127.0.0.1:55433/postgres';
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch {
    throw new Error(
      'Test PostgreSQL is not reachable. Start it with: docker compose up -d --wait postgres-test',
    );
  }
  const url = new URL(adminUrl);
  const testDatabase: TestDatabase = {
    host: url.hostname,
    port: Number(url.port || 5432),
    database: `swyft_test_${randomBytes(4).toString('hex')}`,
    ownerPassword: randomBytes(24).toString('base64url'),
    appPassword: randomBytes(24).toString('base64url'),
  };
  await bootstrapCluster(admin, {
    database: testDatabase.database,
    ownerPassword: testDatabase.ownerPassword,
    appPassword: testDatabase.appPassword,
  });

  const owner = new pg.Client({
    host: testDatabase.host,
    port: testDatabase.port,
    database: testDatabase.database,
    user: 'swyft_owner',
    password: testDatabase.ownerPassword,
  });
  await owner.connect();
  try {
    const migrations = await readMigrations(
      fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    );
    await migrate(owner, migrations);
  } finally {
    await owner.end();
  }
  project.provide('testDatabase', testDatabase);

  return async () => {
    await admin.query(
      `DROP DATABASE IF EXISTS "${testDatabase.database}" WITH (FORCE)`,
    );
    await admin.end();
  };
}
