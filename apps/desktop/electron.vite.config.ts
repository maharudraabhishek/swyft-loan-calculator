import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Workspace source aliases make the packaged app self-contained; no symlinked finance module is needed at runtime.
const workspaceAliases = {
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

export default defineConfig({
  main: {
    resolve: { alias: workspaceAliases },
    build: { externalizeDeps: false },
  },
  preload: {
    resolve: { alias: workspaceAliases },
    build: { externalizeDeps: false },
  },
  renderer: {
    resolve: { alias: workspaceAliases },
    plugins: [react()],
    server: { port: Number(process.env.SWYFT_RENDERER_PORT ?? 5173) },
  },
});
