import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const source = (path: string) =>
  fileURLToPath(new URL(`../../packages/${path}`, import.meta.url));

// Renderer component tests opt into jsdom per file (`@vitest-environment jsdom`).
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
    include: ['src/**/*.test.{ts,tsx}'],
    // Needs PostgreSQL; run with `pnpm test:integration` (part of `pnpm verify`).
    exclude: ['src/**/*.integration.test.{ts,tsx}'],
  },
});
