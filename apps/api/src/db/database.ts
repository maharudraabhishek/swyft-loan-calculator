import pg from 'pg';
import type { ApiConfig } from '../config.js';

/** Minimal query surface handed to repositories; pg types stay inside this module. */
export interface Sql {
  query<Row extends object>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Row[]>;
}

/** The request identity the database uses for RLS. */
export interface Principal {
  readonly userId: string;
  readonly sessionId: string;
  /** SHA-256 of the access token; RLS resolves the user from this inside PostgreSQL. */
  readonly accessTokenHash: Buffer;
}

export interface DatabaseOptions {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly max: number;
  readonly ssl: boolean;
}

/**
 * Owns the connection pool and the transaction boundary.
 *
 * Every unit of work runs in one explicit transaction. `set_config(..., true)` is
 * transaction-local, so the identity setting cannot leak to the next request that
 * borrows the pooled connection. A connection whose rollback fails is destroyed.
 */
export class Database {
  private readonly pool: pg.Pool;

  constructor(options: DatabaseOptions) {
    this.pool = new pg.Pool({
      host: options.host,
      port: options.port,
      database: options.database,
      user: options.user,
      password: options.password,
      max: options.max,
      ssl: options.ssl ? { rejectUnauthorized: true } : false,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      // Server-side guard so one slow statement cannot hold a connection indefinitely.
      statement_timeout: 10_000,
      idle_in_transaction_session_timeout: 15_000,
      application_name: 'swyft-api',
    });
    // An idle client error must not crash the process; the pool discards the client.
    this.pool.on('error', () => undefined);
  }

  static fromConfig(config: ApiConfig): Database {
    return new Database({
      host: config.database.host,
      port: config.database.port,
      database: config.database.name,
      user: config.database.user,
      password: config.database.password,
      max: config.database.poolMax,
      ssl: config.database.ssl,
    });
  }

  /** Runs `work` with RLS identity derived from the principal's access token. */
  withUser<T>(
    principal: Principal,
    work: (sql: Sql) => Promise<T>,
  ): Promise<T> {
    return this.transaction(principal.accessTokenHash, work);
  }

  /** Runs `work` with no user identity; only auth functions are usable. */
  withoutUser<T>(work: (sql: Sql) => Promise<T>): Promise<T> {
    return this.transaction(undefined, work);
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async transaction<T>(
    accessTokenHash: Buffer | undefined,
    work: (sql: Sql) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      if (accessTokenHash !== undefined)
        await client.query(
          "SELECT set_config('app.access_token_hash', $1, true)",
          [accessTokenHash.toString('hex')],
        );
      const sql: Sql = {
        async query<Row extends object>(
          text: string,
          values: readonly unknown[] = [],
        ): Promise<Row[]> {
          const result = await client.query<Row>(text, [...values]);
          return result.rows;
        },
      };
      const result = await work(sql);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }
}

/** PostgreSQL SQLSTATE of a driver error, if any. */
export function sqlState(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[0-9A-Z]{5}$/.test(error.code)
  )
    return error.code;
  return undefined;
}
