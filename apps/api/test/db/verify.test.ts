import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMigrations } from '../../src/db/migrator.js';
import { verifyDeployment } from '../../src/db/verify.js';
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

describe('deployment verification command (used against Cloud SQL)', () => {
  it('passes every check and removes its probe users', async () => {
    const migrations = await readMigrations(
      fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    );
    const result = await verifyDeployment(owner, app, migrations);
    expect(result.checks.filter((check) => !check.ok)).toEqual([]);
    expect(result.checks.length).toBeGreaterThanOrEqual(13);
    expect(result.ok).toBe(true);
  });

  it('fails when a migration checksum does not match', async () => {
    const migrations = await readMigrations(
      fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    );
    const tampered = migrations.map((m, i) =>
      i === 0 ? { ...m, sha256: 'x' } : m,
    );
    const result = await verifyDeployment(owner, app, tampered);
    expect(result.ok).toBe(false);
  });
});
