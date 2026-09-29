import { defineConfig } from 'vitest/config';
import { workspaceAliases } from './vitest.config.js';

/** Integration tests against a real PostgreSQL (docker compose service postgres-test). */
export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    include: ['test/db/**/*.test.ts'],
    globalSetup: ['test/db/global-setup.ts'],
    // One database per run; files share it, so run them in one worker for determinism.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
