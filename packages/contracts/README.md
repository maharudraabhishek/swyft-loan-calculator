# Contracts (`@swyft/contracts`)

The shapes that cross a boundary, defined once with zod and validated on both sides:

- **HTTP** (`src/http.ts`): request and response bodies of the `/v1` API. The API validates what it receives; Electron Main validates what the API returns.
- **IPC** (`src/index.ts`): what the UI and Main exchange over the preload bridge (`DesktopBridge`), the preview and export requests, display options, menu commands and update status.

## Rules

- **Objects are strict.** Unknown keys are rejected, so a client cannot slip in an owner ID or a calculated amount.
- **Money and rates are decimal strings,** never floats. Money: `"1234.50"` (at most $999,999,999.99). Rates and fractions: `"0.085"` for 8.5%. Dates: `YYYY-MM-DD`.
- **Failures are data.** IPC calls return `ApiResult<T>` (`{ ok: true, data }` or `{ ok: false, error }`) instead of throwing, so the UI always has a message to show.
- **New response fields must stay compatible** with installed app versions, which parse strictly. For example, `roundPaymentUpToDollar` is optional and the API sends it only when it is true.

`pnpm --filter @swyft/contracts test` runs its tests.
