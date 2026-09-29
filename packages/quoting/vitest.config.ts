import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@swyft/finance': fileURLToPath(
        new URL('../finance/src/index.ts', import.meta.url),
      ),
    },
  },
});
