import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const coreSrc = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));

// https://vite.dev/config/
export default defineConfig({
  // The desktop build serves from the bundle root, so the default is '/'.
  // GitHub Pages serves the app from /<repo>/, which needs every asset URL —
  // including the WASM kernel's — rewritten. The Pages workflow sets this;
  // nothing else does, so the installer is unaffected by the existence of the
  // web build.
  base: process.env['PAGES_BASE'] ?? '/',
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
