// defineConfig from vitest/config (not vite) so the `test` block below is
// typed; it is the same function with vitest's config extension merged in.
import { defineConfig } from 'vitest/config';

/**
 * Dev server on 5173 with proxy to the game server (port 3000):
 *  - /api/*  -> HTTP API (chat proxy to the LLM gateway)
 *  - /ws     -> WebSocket multiplayer
 */
export default defineConfig({
  // Vitest runs the co-located TypeScript unit tests plus server/llm.test.mjs
  // (the only server test written in vitest style). The other server tests
  // (server/npc.test.mjs, server/server.test.mjs) use node:test and are run
  // with `npm run test:server` — vitest must not pick them up (it finds no
  // vitest suites in them and stalls the worker).
  test: {
    include: ['src/**/*.test.ts', 'server/llm.test.mjs'],
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  build: {
    target: 'es2022',
    // Keep the bundle lean; Babylon is the bulk.
    rollupOptions: {
      output: {
        // Rolldown-based Vite only supports the function form of manualChunks.
        manualChunks(id: string) {
          if (id.includes('@babylonjs/core')) return 'babylon';
        },
      },
    },
  },
});
