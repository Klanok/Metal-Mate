/**
 * Browser tests against the built app, served under the desktop CSP.
 *
 * These exist because two shipped bugs were invisible to every other test in
 * this repo and only appeared on a real machine:
 *
 *  - the geometry kernel could not start, because the CSP allowed
 *    'wasm-unsafe-eval' but Emscripten's embind needs 'unsafe-eval';
 *  - the 3D viewport went black on any display scaled above 100%, because the
 *    canvas had no CSS size and grew its own container on every resize.
 *
 * Neither is reachable from a Node unit test, and neither shows up under a
 * plain `vite preview` at 100% scaling. So this suite serves the real bundle
 * with the real policy and drives it at more than one device pixel ratio.
 */

import { type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { serveDist } from './harness.js';

const PORT = 4319;
let server: Server;

test.beforeAll(async () => {
  server = await serveDist(PORT);
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const url = `http://localhost:${PORT}/`;

test.describe('under the desktop content security policy', () => {
  test('the geometry kernel starts and the part builds', async ({ page }) => {
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') failures.push(m.text());
    });

    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('verdict')).toContainText('Ready to export', {
      timeout: 20_000,
    });
    await expect(page.locator('.kernel-error')).toHaveCount(0);
    expect(failures.join('\n')).not.toMatch(/Content Security Policy|unsafe-eval/i);
  });

  test('an edge can be folded on any of the four sides', async ({ page }) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('verdict')).toContainText('Ready to export', { timeout: 20_000 });
    // Front and back are folded by default; they are opposite sides, so no
    // corner has two bends meeting in it yet.
    await expect(page.getByTestId('bend-table').locator('tbody tr')).toHaveCount(2);
    await expect(page.getByTestId('corner-relief')).toHaveCount(0);

    for (const side of ['left', 'right']) {
      await page.getByTestId(`edge-${side}`).locator('select').selectOption('square-drop');
    }

    await expect(page.getByTestId('bend-table').locator('tbody tr')).toHaveCount(4);
    // Four corners are now in play, so the corner controls appear.
    await expect(page.getByTestId('corner-editor')).toBeVisible();
    await expect(page.getByTestId('verdict')).toContainText('Ready to export');
    await expect(page.getByTestId('export-dxf')).toBeEnabled();
  });

  test('corners close by default and can be opened back up', async ({ page }) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('verdict')).toContainText('Ready to export', { timeout: 20_000 });
    await expect(page.getByTestId('corner-editor')).toHaveCount(0);

    // Fold both ends down. The default splashback still folds up, so the two
    // front corners close and the two back ones cannot.
    for (const side of ['left', 'right']) {
      await page.getByTestId(`edge-${side}`).locator('select').selectOption('square-drop');
    }
    const corners = page.getByTestId('corner-editor');
    await expect(corners).toContainText('2 corners close up');
    await expect(corners).toContainText('2 corners cannot close');
    await expect(corners.locator('.field.number', { hasText: 'Weld gap' })).toBeVisible();
    await expect(corners.locator('.field.number', { hasText: 'Relief notch' })).toBeVisible();

    await corners.locator('select').selectOption('relief');
    await expect(corners).not.toContainText('close up');
    await expect(corners.locator('.field.number', { hasText: 'Weld gap' })).toHaveCount(0);
    await expect(page.getByTestId('verdict')).toContainText('Ready to export');
  });

  test('a left end can fold up as well as down', async ({ page }) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('verdict')).toContainText('Ready to export', { timeout: 20_000 });
    await page.getByTestId('edge-left').locator('select').selectOption('upstand');
    const directions = page.getByTestId('bend-table').locator('tbody tr td:nth-child(3)');
    await expect(directions).toHaveText(['down', 'up', 'up']);
  });

  test('export is blocked when the part exceeds the machine', async ({ page }) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('verdict')).toContainText('Ready to export');
    await page
      .locator('.field.number', { hasText: 'Length' })
      .locator('input')
      .fill('3000');
    await expect(page.getByTestId('verdict')).toContainText('Export blocked');
    await expect(page.getByTestId('export-dxf')).toBeDisabled();
  });
});

// A 200% display is ordinary on Windows laptops, and it is where the viewport
// bug lived. 1 alone would have missed it.
for (const deviceScaleFactor of [1, 2]) {
  test.describe(`at ${deviceScaleFactor}x display scaling`, () => {
    test.use({ deviceScaleFactor });

    test('the 3D canvas fits its container instead of growing it', async ({ page }) => {
      await page.goto(url, { waitUntil: 'networkidle' });
      const canvas = page.locator('[data-testid="viewport-3d"] canvas');
      await canvas.waitFor({ timeout: 20_000 });
      // Give the resize observer several frames to run away if it is going to.
      await page.waitForTimeout(1500);

      const size = await page.evaluate(() => {
        const holder = document.querySelector('[data-testid="viewport-3d"]')!;
        const c = holder.querySelector('canvas')!.getBoundingClientRect();
        return {
          holderWidth: holder.clientWidth,
          holderHeight: holder.clientHeight,
          canvasWidth: c.width,
          canvasHeight: c.height,
        };
      });

      expect(size.canvasWidth).toBeLessThanOrEqual(size.holderWidth + 1);
      expect(size.canvasHeight).toBeLessThanOrEqual(size.holderHeight + 1);
      // A runaway loop reached millions of pixels; this catches it long before.
      expect(size.holderWidth).toBeLessThan(10_000);
    });

    test('the fold slider stays on screen below the viewport', async ({ page }) => {
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.locator('[data-testid="viewport-3d"] canvas').waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1500);
      // An oversized canvas pushes this out of the clipped column, which is
      // how the bug first showed itself.
      await expect(page.getByTestId('fold-slider')).toBeVisible();
    });
  });
}

test('the flat pattern draws arcs rather than polylines', async ({ page }) => {
  await page.goto(url, { waitUntil: 'networkidle' });
  await expect(page.getByTestId('verdict')).toContainText('Ready to export', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Add sink' }).click();
  await page.getByRole('button', { name: 'Flat pattern' }).click();
  const inner = page.locator('.flat-preview path.cut-inner').first();
  await expect(inner).toHaveAttribute('d', /A /);
});
