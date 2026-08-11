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

test.describe('documents with several parts', () => {
  test('a part can be added, edited independently, and removed', async ({ page }) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('verdict')).toContainText('Ready to export', { timeout: 20_000 });
    const parts = page.getByTestId('parts-panel');
    await expect(parts.locator('.design')).toHaveCount(1);
    // With one part there is nothing to total up.
    await expect(page.getByTestId('cut-list-totals')).toHaveCount(0);

    await page.getByTestId('add-benchtop').click();
    await expect(parts.locator('.design')).toHaveCount(2);
    await expect(page.getByTestId('cut-list-totals')).toBeVisible();

    // The new part is selected, so editing the wizard must not touch the first.
    await page
      .locator('.field.number', { hasText: 'Length' })
      .locator('input')
      .fill('900');
    await parts.locator('.design').first().locator('.part-select').click();
    await expect(page.locator('.field.number', { hasText: 'Length' }).locator('input')).toHaveValue(
      '1800',
    );

    await parts.locator('.design').last().getByRole('button', { name: 'remove' }).click();
    await expect(parts.locator('.design')).toHaveCount(1);
  });

  test('two parts with the same name are reported, not silently accepted', async ({ page }) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('verdict')).toContainText('Ready to export', { timeout: 20_000 });
    await page.getByTestId('add-benchtop').click();
    // Rename the new part onto the first one's name.
    await page.locator('.field', { hasText: 'Name' }).locator('input').fill('Benchtop');

    await expect(page.getByTestId('document-problems')).toContainText('2 parts are called');
    await expect(page.getByTestId('export-all')).toBeDisabled();
  });

  test('a copy does not inherit the original part number', async ({ page }) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('verdict')).toContainText('Ready to export', { timeout: 20_000 });
    await page.locator('.field', { hasText: 'Part ID' }).locator('input').fill('CAN-001');

    await page.getByTestId('parts-panel').locator('.design').first()
      .getByRole('button', { name: 'copy' }).click();
    // Two parts sharing a part number is exactly the collision that would send
    // one panel to the laser twice and the other not at all.
    await expect(page.locator('.field', { hasText: 'Part ID' }).locator('input')).toHaveValue('');
    await expect(page.getByTestId('document-problems')).toHaveCount(0);
  });

  test('one blocked part stops the whole document exporting', async ({ page }) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('verdict')).toContainText('Ready to export', { timeout: 20_000 });
    await page.getByTestId('add-benchtop').click();
    await expect(page.getByTestId('export-all')).toBeEnabled();

    // 3000 mm overruns the 2500 mm bed on the second part only.
    await page.locator('.field.number', { hasText: 'Length' }).locator('input').fill('3000');
    await expect(page.getByTestId('export-all')).toBeDisabled();
    // ...and the parts list says which one is at fault.
    await expect(page.getByTestId('parts-panel')).toContainText('error');
  });

  test('the cut list counts quantities', async ({ page }) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('verdict')).toContainText('Ready to export', { timeout: 20_000 });
    await page.getByTestId('add-benchtop').click();
    const totals = page.getByTestId('cut-list-totals');
    await expect(totals).toContainText('2');

    await page.locator('.field.number', { hasText: 'Quantity' }).locator('input').fill('3');
    // Two rows, one of them three off.
    await expect(totals).toContainText('4');
    await expect(page.getByTestId('parts-panel')).toContainText('3 off');
  });
});

test.describe('the canopy template', () => {
  test('adds a canopy and swaps the wizard for it', async ({ page }) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('verdict')).toContainText('Ready to export', { timeout: 20_000 });
    await expect(page.getByTestId('template-panel')).toBeVisible();
    await expect(page.getByTestId('canopy-panel')).toHaveCount(0);

    await page.getByTestId('add-canopy').click();

    // The wizard swaps to the canopy's own parameters — no edges, no cutouts.
    await expect(page.getByTestId('canopy-panel')).toBeVisible();
    await expect(page.getByTestId('template-panel')).toHaveCount(0);
    await expect(page.getByTestId('canopy-caveat')).toContainText('skeleton');
  });

  test('keeps the size fields on screen, not below a six-panel list', async ({ page }) => {
    // Reported from a real machine: "canopy appears but no option to change
    // sizes". The fields existed — a canopy's six panels pushed them past the
    // bottom of a column most people do not realise scrolls.
    await page.setViewportSize({ width: 1400, height: 700 });
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('verdict')).toContainText('Ready to export', { timeout: 20_000 });
    await page.getByTestId('add-canopy').click();

    for (const label of ['Length', 'Width', 'Height']) {
      const field = page
        .getByTestId('canopy-panel')
        .locator('.field.number', { hasText: label })
        .first();
      await expect(field).toBeVisible();
      const box = await field.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y + box!.height).toBeLessThanOrEqual(700);
    }
  });

  test('makes six panels from one design', async ({ page }) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('verdict')).toContainText('Ready to export', { timeout: 20_000 });
    await page.getByTestId('add-canopy').click();

    const design = page.getByTestId('parts-panel').locator('.design').last();
    await expect(design).toContainText('6 panels');
    await expect(design.locator('.panel-row')).toHaveCount(6);
    await expect(design).toContainText('CAN-FLOOR');
    await expect(design).toContainText('CAN-ROOF');

    // One benchtop plus six canopy panels.
    await expect(page.getByTestId('cut-list-totals')).toContainText('7');
  });

  test('drops the floor panel when the canopy sits on the tray', async ({ page }) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('verdict')).toContainText('Ready to export', { timeout: 20_000 });
    await page.getByTestId('add-canopy').click();
    const design = page.getByTestId('parts-panel').locator('.design').last();
    await expect(design.locator('.panel-row')).toHaveCount(6);

    await page.getByTestId('canopy-floor').uncheck();
    await expect(design.locator('.panel-row')).toHaveCount(5);
    await expect(design).not.toContainText('CAN-FLOOR');
  });

  test('a panel can be picked and put on screen', async ({ page }) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('verdict')).toContainText('Ready to export', { timeout: 20_000 });
    await page.getByTestId('add-canopy').click();

    // The roof is the last panel; selecting it must show that part, not the
    // design's first one.
    await page.getByTestId('parts-panel').locator('.panel-row').last().locator('button').click();
    await expect(page.getByTestId('parts-panel').locator('.panel-row.active')).toContainText(
      'CAN-ROOF',
    );
    // A flat panel has no bends, which is a fact about the skeleton worth
    // seeing rather than assuming.
    await expect(page.getByTestId('bend-table').locator('tbody tr')).toHaveCount(0);
    await expect(page.getByTestId('verdict')).toContainText('Ready to export');
  });

  test('reports a canopy too small to build, against its own design', async ({ page }) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('verdict')).toContainText('Ready to export', { timeout: 20_000 });
    await page.getByTestId('add-canopy').click();

    await page
      .getByTestId('canopy-panel')
      .locator('.field.number', { hasText: 'Width' })
      .locator('input')
      .fill('1');
    const design = page.getByTestId('parts-panel').locator('.design').last();
    await expect(design).toContainText('will not build');
    await expect(design.locator('.panel-row')).toHaveCount(0);
    // The benchtop alongside it is unaffected, which is the point of catching
    // this per design rather than per document.
    await expect(page.getByTestId('parts-panel').locator('.design').first()).toContainText(
      'Benchtop',
    );
  });
});

test.describe('shop settings', () => {
  test('the press brake can be edited and changes what validation says', async ({ page }) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('verdict')).toContainText('Ready to export', { timeout: 20_000 });
    await expect(page.getByTestId('machine-caveat')).toBeVisible();

    // A 1800 mm bench fits a 2500 mm bed. Shrink the bed and it must not.
    await page.getByTestId('open-settings').click();
    await page
      .getByTestId('settings-dialog')
      .locator('.field.number', { hasText: 'Bed length' })
      .locator('input')
      .fill('1500');
    await page.getByTestId('settings-close').click();

    await expect(page.getByTestId('verdict')).toContainText('Export blocked');
    await expect(page.getByTestId('export-dxf')).toBeDisabled();
  });

  test('the placeholder caveat clears only when the machine is confirmed', async ({ page }) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('verdict')).toContainText('Ready to export', { timeout: 20_000 });

    await page.getByTestId('open-settings').click();
    await expect(page.getByTestId('placeholder-warning')).toBeVisible();
    await page.getByTestId('machine-name').fill('Amada HFE 3-file');
    await page.getByTestId('machine-confirmed').check();
    await expect(page.getByTestId('placeholder-warning')).toHaveCount(0);
    await page.getByTestId('settings-close').click();

    await expect(page.getByTestId('machine-caveat')).toHaveCount(0);
    // The brake's name is what the toolbar reports checking against.
    await expect(page.locator('.brand')).toContainText('Amada HFE 3-file');
  });

  test('a broken machine is reported and blocks confirming it', async ({ page }) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('verdict')).toContainText('Ready to export', { timeout: 20_000 });
    await page.getByTestId('open-settings').click();

    await page.getByTestId('die-widths').fill('10, 10');
    await expect(page.getByTestId('machine-problems')).toContainText('same V opening twice');
    await expect(page.getByTestId('machine-confirmed')).toBeDisabled();
  });

  test('settings survive a reload', async ({ page }) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('verdict')).toContainText('Ready to export', { timeout: 20_000 });
    await page.getByTestId('open-settings').click();
    await page.getByTestId('machine-name').fill('Durma AD-S');
    await page.getByTestId('settings-close').click();

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('.brand')).toContainText('Durma AD-S');
  });

  test('a test strip solves for K and joins the bend table', async ({ page }) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('verdict')).toContainText('Ready to export', { timeout: 20_000 });
    // Where the allowance came from, before any calibration exists.
    await expect(page.getByTestId('bend-table')).toContainText('material-default');

    await page.getByTestId('open-settings').click();
    await page.getByRole('button', { name: 'Bend calibration' }).click();
    await expect(page.getByTestId('calibration-k')).toHaveText(/0\.\d+/);
    await page.getByTestId('calibration-save').click();
    await expect(page.getByTestId('bend-table-rows')).toBeVisible();
    await page.getByTestId('settings-close').click();

    // The measured row now drives the flat pattern, which is the whole point.
    await expect(page.getByTestId('bend-table')).toContainText('bend-table-deduction');
  });

  test('a mismeasured strip is explained rather than silently accepted', async ({ page }) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('verdict')).toContainText('Ready to export', { timeout: 20_000 });
    await page.getByTestId('open-settings').click();
    await page.getByRole('button', { name: 'Bend calibration' }).click();

    // Legs measured to the outside of the radius instead of the apex.
    await page
      .getByTestId('settings-dialog')
      .locator('.field.number', { hasText: 'Blank length' })
      .locator('input')
      .fill('200');
    await expect(page.getByTestId('calibration-result')).toContainText('apex');
    await expect(page.getByTestId('calibration-save')).toBeDisabled();
  });
});

test('the flat pattern draws arcs rather than polylines', async ({ page }) => {
  await page.goto(url, { waitUntil: 'networkidle' });
  await expect(page.getByTestId('verdict')).toContainText('Ready to export', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Add sink' }).click();
  await page.getByRole('button', { name: 'Flat pattern' }).click();
  const inner = page.locator('.flat-preview path.cut-inner').first();
  await expect(inner).toHaveAttribute('d', /A /);
});
