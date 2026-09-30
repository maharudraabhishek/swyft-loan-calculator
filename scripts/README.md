# Scripts

Developer tools. The launcher is for Windows; it needs Node 24 with pnpm and, except for `cloud` mode, Docker Desktop.

| Script              | What it does                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run_local.py`      | Starts the whole app with one command (see below)                                                                                                      |
| `test_run_local.py` | Safety tests for the launcher: `python -m unittest discover scripts`                                                                                   |
| `verify.ps1`        | Runs every check (`pnpm verify`): format, lint, typecheck, build, database tests, real-stack tests, then unit and fixture tests                        |
| `check-finance.mjs` | Finance gate used by CI: passes when every finance test passes except the five documented official cases, each with exactly its documented differences |

## `run_local.py` modes

```powershell
python scripts/run_local.py dev          # PostgreSQL + API + hot-reloading desktop
python scripts/run_local.py production   # the same, from compiled builds
python scripts/run_local.py cloud        # compiled desktop against the deployed Cloud Run API
```

- **`dev` and `production`** start PostgreSQL in Docker, create the database roles, run the migrations and start a local API. Sign-in uses a local consent page instead of Google (Google only returns to the registered Cloud Run callback), and logos are kept in memory. Local database passwords are generated once and saved in `.local-stack.json` (git-ignored), so deals are kept between runs.
- **`cloud`** starts no local services. It uses the API origin in `apps/desktop/.env.production` (must be `https://`), with real Google sign-in in your normal browser.

Closing the desktop window (or Ctrl+C) stops the API and the desktop. PostgreSQL keeps running in Docker with its data; `docker compose stop` stops it.

`verify.ps1` stops at the first failing check. The unit and fixture tests run last and currently fail only on the five official test cases explained in the main README (Known limitations).
