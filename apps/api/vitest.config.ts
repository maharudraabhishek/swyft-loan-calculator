import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export const workspaceAliases = {
  '@swyft/contracts': fileURLToPath(
    new URL('../../packages/contracts/src/index.ts', import.meta.url),
  ),
  '@swyft/finance': fileURLToPath(
    new URL('../../packages/finance/src/index.ts', import.meta.url),
  ),
  '@swyft/quoting': fileURLToPath(
    new URL('../../packages/quoting/src/index.ts', import.meta.url),
  ),
};

/** Unit tests: no database or network. */
export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: { include: ['test/unit/**/*.test.ts'] },
});
