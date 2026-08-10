import { defineConfig } from '@playwright/test';

/**
 * Browser tests run against the built bundle, so `npm run build` must have run
 * first (the `test:ui` script does it). They are a separate suite from the
 * Vitest unit tests because they need a browser and take longer.
 */
export default defineConfig({
  testDir: './test-ui',
  fullyParallel: false,
  workers: 1,
  reporter: process.env['CI'] === undefined ? 'list' : 'github',
  use: {
    viewport: { width: 1400, height: 900 },
    // Chromium is what both Tauri webviews are closest to; the failures these
    // tests guard against are engine-independent (CSP and CSS layout).
    ...(process.env['PLAYWRIGHT_CHROMIUM_PATH'] !== undefined
      ? { launchOptions: { executablePath: process.env['PLAYWRIGHT_CHROMIUM_PATH'] } }
      : {}),
  },
});
