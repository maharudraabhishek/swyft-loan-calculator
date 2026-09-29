import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { bootstrapCluster } from './db/bootstrap.js';
import { migrate, readMigrations } from './db/migrator.js';
import { verifyDeployment } from './db/verify.js';

/**
 * Operational database commands (never run by the API process):
 *   bootstrap  admin connection; creates swyft_owner/swyft_app and the database
 *   migrate    owner connection (swyft_owner)
 *   verify     owner + app connections: hardening, migration checksums and a two-user RLS
 *              probe through the runtime role; exits non-zero on failure
 *
 * Connections come from a URL (ADMIN_DATABASE_URL, MIGRATION_DATABASE_URL, APP_DATABASE_URL)
 * or from DB_HOST (Cloud SQL socket path), DB_PORT, DB_NAME and one password per role
 * (DB_ADMIN_PASSWORD, SWYFT_OWNER_PASSWORD, SWYFT_APP_PASSWORD), each injected from Secret
 * Manager into the job that needs it. Secrets are never printed.
 */
const migrationsDirectory = fileURLToPath(
  new URL('../db/migrations', import.meta.url),
);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

type Connection = 'admin' | 'owner' | 'app';

const connectionSources: Record<
  Connection,
  { url: string; user: string; password: string; adminDatabase?: true }
> = {
  admin: {
    url: 'ADMIN_DATABASE_URL',
    user: 'postgres',
    password: 'DB_ADMIN_PASSWORD',
    adminDatabase: true,
  },
  owner: {
    url: 'MIGRATION_DATABASE_URL',
    user: 'swyft_owner',
    password: 'SWYFT_OWNER_PASSWORD',
  },
  app: {
    url: 'APP_DATABASE_URL',
    user: 'swyft_app',
    password: 'SWYFT_APP_PASSWORD',
  },
};

function databaseName(): string {
  return process.env.SWYFT_DB_NAME ?? required('DB_NAME');
}

function connection(kind: Connection): pg.ClientConfig {
  const source = connectionSources[kind];
  const url = process.env[source.url];
  if (url) return { connectionString: url };
  return {
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 5432),
    database: source.adminDatabase ? 'postgres' : databaseName(),
    user: source.user,
    password: required(source.password),
  };
}

async function withClient<T>(
  kind: Connection,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client(connection(kind));
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

const command = process.argv[2];
try {
  if (command === 'bootstrap') {
    await withClient('admin', (client) =>
      bootstrapCluster(client, {
        database: databaseName(),
        ownerPassword: required('SWYFT_OWNER_PASSWORD'),
        appPassword: required('SWYFT_APP_PASSWORD'),
      }),
    );
    process.stdout.write('Bootstrap complete\n');
  } else if (command === 'migrate') {
    const migrations = await readMigrations(migrationsDirectory);
    const applied = await withClient('owner', (client) =>
      migrate(client, migrations),
    );
    process.stdout.write(
      applied.length > 0
        ? `Applied migrations: ${applied.join(', ')}\n`
        : 'Database is up to date\n',
    );
  } else if (command === 'verify') {
    const migrations = await readMigrations(migrationsDirectory);
    const result = await withClient('owner', (owner) =>
      withClient('app', (app) => verifyDeployment(owner, app, migrations)),
    );
    for (const item of result.checks)
      process.stdout.write(
        `${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? ` (${item.detail})` : ''}\n`,
      );
    process.stdout.write(
      result.ok ? 'Verification passed\n' : 'Verification FAILED\n',
    );
    if (!result.ok) process.exitCode = 1;
  } else {
    throw new Error('Usage: db-cli <bootstrap|migrate|verify>');
  }
} catch (error) {
  // Messages from our own checks are safe; driver errors are reduced to their SQLSTATE.
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : '';
  process.stderr.write(
    `${error instanceof Error && !code ? error.message : `Database command failed${code ? ` (${code})` : ''}`}\n`,
  );
  process.exitCode = 1;
}
