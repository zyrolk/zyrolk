import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const artifactDirectory = fileURLToPath(new URL('./artifacts', import.meta.url));
mkdirSync(artifactDirectory, { recursive: true });

const viewports = [320, 390, 768, 1440] as const;

for (const width of viewports) {
  test(`captures the populated ProductCard fixture at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1200 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/?viewport=${width}`, { waitUntil: 'networkidle' });
    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation: none !important;
          transition: none !important;
          caret-color: transparent !important;
        }
      `,
    });

    await expect(page.locator('[data-fixture-case]')).toHaveCount(5);
    await expect(page.locator('[data-fixture-case="out-of-stock"]')).toContainText('Out of Stock');
    await expect(page.locator('[data-fixture-case="out-of-stock"]')).toContainText('View details');
    await expect(page.locator('[data-fixture-case="missing-image"] img')).toBeVisible();
    await expect(page.locator('[data-fixture-case="discount"]')).toContainText('Save');

    await page.screenshot({
      path: path.join(artifactDirectory, `product-card-${width}.png`),
      fullPage: true,
    });
  });
}
