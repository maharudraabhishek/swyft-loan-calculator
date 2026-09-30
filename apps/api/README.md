# API (`@swyft/api`)

The backend, a Fastify `/v1` API running on Google Cloud Run. It signs users in with Google (Identity Platform), stores deals, quotes and lender settings in PostgreSQL, and keeps lender logos in Cloud Storage. The desktop app talks only to this API.

## How it behaves

- All `/v1` routes except sign-in need a valid session. A unit test walks the route table and checks that every protected route returns 401 without one.
- Queries run as a least-privilege role under PostgreSQL row-level security, so each user only sees their own data. Anything that belongs to someone else returns 404.
- When a quote is saved, the API recalculates it from the broker's inputs and the stored fee signature, using the same shared engine as the app's preview, and stores the result with a snapshot that never changes.
- Quote saves need an `Idempotency-Key` header. Retrying returns the original quote, and a different request with the same key is rejected.

## Layout

| Folder / file             | Contents                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/server.ts`           | Process entry: reads configuration, starts the HTTP server                                             |
| `src/composition.ts`      | Wires the real database, identity provider and logo storage into the app                               |
| `src/app.ts`              | Fastify setup: logging, security headers, error envelope, health routes                                |
| `src/config.ts`           | Environment variables, validated at startup (unsafe production settings refuse to start)               |
| `src/identity/`           | Sign-in: login, OAuth callback, token exchange and refresh, logout; PKCE and loopback checks           |
| `src/deals/`              | Deals, quote logs and quotes (service and SQL)                                                         |
| `src/lenders/`            | Lenders, logos and fee signatures (service and SQL)                                                    |
| `src/storage/`            | Logo storage: Cloud Storage in production, in memory for local runs                                    |
| `src/http/`               | Route registration for signed-in users, error types, request validation, rate limiting                 |
| `src/db/`                 | Connection pool, migration runner, role bootstrap, post-deploy security verification                   |
| `src/db-cli.ts`           | Operational commands: `bootstrap`, `migrate`, `verify`                                                 |
| `db/migrations/`          | SQL migrations (`NNNN_name.sql`): additive only; applied files are never edited (they are checksummed) |
| `scripts/cloud-smoke.mjs` | End-to-end check against a deployed API with real Google sign-in (`--two-users` tests isolation)       |

## Commands

```powershell
pnpm --filter @swyft/api dev          # watch mode (reads apps/api/.env; see .env.example)
pnpm --filter @swyft/api test         # unit tests
pnpm test:db                          # database tests on a disposable PostgreSQL (Docker)
pnpm --filter @swyft/api db:migrate   # apply migrations as the owner role
```

Configuration is described in the repository's `.env.example`. In production the values come from the Cloud Run service settings, and passwords come from Secret Manager.
