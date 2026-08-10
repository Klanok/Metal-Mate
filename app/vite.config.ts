import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const coreSrc = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Consume the core as TypeScript source rather than through the workspace
    // symlink: one type-check across the whole repo, and no build step between
    // editing a core rule and seeing it in the app.
    alias: { '@metal-mate/core': coreSrc },
  },
  // Tauri expects a fixed dev port and fails loudly rather than silently
  // moving to another one.
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: {
    // The webview on every platform Tauri 2 targets handles ES2021.
    target: 'es2021',
    sourcemap: true,
  },
});
