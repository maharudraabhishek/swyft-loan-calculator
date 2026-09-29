import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const source = (path: string) =>
  fileURLToPath(new URL(`../../packages/${path}`, import.meta.url));

/**
 * Real-stack integration: the Renderer and Main code against the real API on a real port
 * and a freshly migrated PostgreSQL (docker compose service postgres-test), prepared by the
 * API's own global setup.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@swyft/contracts': source('contracts/src/index.ts'),
      '@swyft/finance': source('finance/src/index.ts'),
      '@swyft/quoting': source('quoting/src/index.ts'),
    },
  },
  test: {
    include: ['src/**/*.integration.test.{ts,tsx}'],
    globalSetup: ['../api/test/db/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
