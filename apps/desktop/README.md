# Desktop app (`@swyft/desktop`)

The Electron app brokers use: a React UI for quoting, deals, the quote log, client emails and lender settings. It is built for Windows (NSIS installer) and macOS (disk images, ad-hoc signed).

## Process structure

```
Renderer (React UI, sandboxed)  →  Preload (window.swyft)  →  Main (Node, Electron APIs)  →  Cloud Run API
```

- **Renderer** (`src/renderer`) runs with `contextIsolation`, `sandbox` and no Node access. Its CSP blocks all network connections (`connect-src 'none'`), so it can only reach the rest of the app through the preload bridge.
- **Preload** (`src/preload`) exposes a small typed bridge, `window.swyft`, with groups `auth`, `deals`, `quotes`, `lenders`, `menu` and `updates`. Each method calls one named IPC channel; there is no generic "send".
- **Main** (`src/main`) checks that every IPC call comes from the app's own window, validates the arguments with zod, then acts. It owns sign-in, the session, all HTTP calls, the local quote preview, clipboard export, the logo file dialog, the application menu, the window state and automatic updates.
- **Shared** (`src/shared`) holds pure formatting, frequency and email-export code used by both Main and the UI.

## Layout

| Folder                                    | Contents                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main/auth/`                          | System-browser sign-in (loopback + PKCE), session manager, encrypted session store (`safeStorage`)                                   |
| `src/main/api/`                           | API client for deals, quotes, lenders and logos; every call returns a result, never throws across IPC                                |
| `src/main/ipc/`                           | IPC channel names and handlers with argument validation                                                                              |
| `src/main/quote-preview.ts`               | Local preview and target-commission calculator (same code the API uses to save)                                                      |
| `src/main/app-menu.ts`, `window-state.ts` | Native menu with shortcuts; remembered window size and position                                                                      |
| `src/main/updates.ts`                     | Automatic updates (installed Windows app): check at start-up and every 6 hours, download in the background, install on restart       |
| `src/renderer/src/app/`                   | Signed-in shell: header, navigation, deal list, offline banner                                                                       |
| `src/renderer/src/quotes/`                | Calculator form, preview, quote log, comparison, client email                                                                        |
| `src/renderer/src/deals/`, `lenders/`     | Deal list and workspace; lender library and fee-signature editor                                                                     |
| `src/renderer/src/lib/`, `ui/`            | Hooks (bridge, server data, display options, online status) and form/notice components                                               |
| `src/test-support/`                       | Test doubles and fixtures (excluded from the installer)                                                                              |
| `scripts/`                                | Packaged-app harnesses: `smoke-packaged.mjs`, `auth-e2e.mjs` (real sign-in), `workflow-e2e.mjs` (full broker flow against Cloud Run) |

## Commands

```powershell
pnpm desktop:dev                           # hot-reloading app (local API at http://127.0.0.1:8080)
pnpm --filter @swyft/desktop test          # unit and UI workflow tests (jsdom)
pnpm test:integration                      # UI + Main against the real API and PostgreSQL
pnpm desktop:package:win                   # Windows installer in apps/desktop/dist/
pnpm desktop:package:mac                   # macOS disk images (arm64 and x64); needs a Mac
```

Release builds embed only the public API origin from `.env.production`; the installer contains no secrets.

## Keyboard shortcuts

| Shortcut                        | Action                     |
| ------------------------------- | -------------------------- |
| Ctrl+N                          | New deal                   |
| Ctrl+1 / Ctrl+2                 | Calculator / Lenders       |
| Ctrl+B                          | Show or hide the deal list |
| Ctrl+Plus / Ctrl+Minus / Ctrl+0 | Zoom in / out / reset      |
| F11                             | Full screen                |

Help → Keyboard Shortcuts shows the same list. The window reopens at its last size and position (on a connected screen).
