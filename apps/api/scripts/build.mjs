// Bundles the API and its workspace packages into dist/. npm dependencies stay external
// and are installed in the runtime image from the locked manifest.
import { readFileSync, rmSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const workspace = (name) =>
  fileURLToPath(
    new URL(`../../../packages/${name}/src/index.ts`, import.meta.url),
  );

// Start clean so no stale output from earlier builds ships.
rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: { server: 'src/server.ts', 'db-cli': 'src/db-cli.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  legalComments: 'none',
  alias: {
    '@swyft/contracts': workspace('contracts'),
    '@swyft/finance': workspace('finance'),
    '@swyft/quoting': workspace('quoting'),
  },
  external: Object.keys(manifest.dependencies),
  logLevel: 'warning',
});
