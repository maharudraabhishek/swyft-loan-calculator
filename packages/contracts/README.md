# Contracts (`@swyft/contracts`)

Zod schemas for everything that crosses a process boundary, shared so both sides validate against the same definition:

- **HTTP** (`src/http.ts`): request and response bodies of the `/v1` API. The API validates what it receives; Electron Main validates what the API returns.
- **IPC** (`src/index.ts`): what the UI and Main exchange over the preload bridge (`DesktopBridge`), the preview and export requests, display options, menu commands and update status.

## Rules

- Objects are strict. Unknown keys are rejected, so a client can't slip in an owner ID or a calculated amount.
- Money and rates travel as decimal strings, not floats. Money: `"1234.50"` (up to $999,999,999.99). Rates and fractions: `"0.085"` for 8.5%. Dates: `YYYY-MM-DD`.
- IPC calls don't throw. They return `ApiResult<T>` (`{ ok: true, data }` or `{ ok: false, error }`), so the UI always has a message to show.
- Installed app versions parse responses strictly, so a new response field has to be optional and only sent when needed. `roundPaymentUpToDollar`, for example, is only sent when it's true.

`pnpm --filter @swyft/contracts test` runs its tests.
