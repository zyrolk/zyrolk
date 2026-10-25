import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const viewports = [
  { name: '320', width: 320, height: 900 },
  { name: '390', width: 390, height: 900 },
  { name: '768', width: 768, height: 900 },
  { name: '1440', width: 1440, height: 1000 },
] as const;

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(process.env.VISUAL_OUTPUT_DIR || path.join(fixtureRoot, 'screenshots'));

test.describe('Zyro homepage premium visual preview', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('.zy-launch-home')).toBeVisible();
    await expect(page.locator('.zy-home-category-promo')).toHaveCount(4);
    await page.evaluate(() => document.fonts?.ready);
    await page.waitForLoadState('networkidle');
  });

  for (const viewport of viewports) {
    test(`captures ${viewport.name}px homepage`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.reload({ waitUntil: 'networkidle' });
      await expect(page.locator('.zy-launch-home')).toBeVisible();

      const overflow = await page.evaluate(() => ({
        body: document.body.scrollWidth,
        viewport: document.documentElement.clientWidth,
      }));
      expect(overflow.body, `horizontal overflow at ${viewport.name}px`).toBeLessThanOrEqual(overflow.viewport + 1);

      const cards = page.locator('.zy-home-category-promo');
      await expect(cards).toHaveCount(4);
      const mobileDock = page.locator('.zy-mobile-dock');
      if (viewport.width < 768) {
        await expect(mobileDock).toBeVisible();
      } else {
        await expect(mobileDock).toBeHidden();
      }

      await fs.mkdir(outputDir, { recursive: true });
      await page.screenshot({
        path: path.join(outputDir, `homepage-${viewport.name}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    });
  }

  test('opens and closes the existing mobile search with focus restoration', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.reload({ waitUntil: 'networkidle' });
    const trigger = page.getByRole('button', { name: 'Search products' });
    await expect(trigger).toHaveCSS('min-height', '44px');
    await trigger.click();
    const input = page.locator('#mobile-product-search');
    await expect(input).toBeFocused();
    await expect(input).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(input).toBeHidden();
  });
});
