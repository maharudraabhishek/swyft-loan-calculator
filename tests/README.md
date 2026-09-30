# Test fixtures

`fixtures/upstream/` is a byte-for-byte copy of SPG's official Option A resources (`quoting-tool/resources/` at the commit in `UPSTREAM_COMMIT`): `test-cases.json`, `lender-configs.json`, the lender CSV schedules and SPG's four HTML calculators. `MANIFEST.md` lists the source and a SHA-256 hash for every file.

These files are **never edited**, not even to make a test pass. The finance tests in `packages/finance/tests/` read them directly, and they are not shipped in the installer.

Each package keeps its own tests next to its code (`*.test.ts` files in `src/`, `test/` or `tests/`); see the package READMEs.
