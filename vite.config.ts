import { defineConfig } from 'vite';

/**
 * Dev server on 5173 with proxy to the game server (port 3000):
 *  - /api/*  -> HTTP API (chat proxy to the LLM gateway)
 *  - /ws     -> WebSocket multiplayer
 */
export default defineConfig({
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
