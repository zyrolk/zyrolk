import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(process.env.ZYRO_SOURCE_ROOT || path.resolve(fixtureRoot, '../../../../../../..'));
const viteEntry = path.join(sourceRoot, 'node_modules', 'vite', 'bin', 'vite.js');

export default defineConfig({
  testDir: fixtureRoot,
  testMatch: 'homepage.visual.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: path.join(fixtureRoot, 'playwright-report'), open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4177',
    browserName: 'chromium',
    headless: true,
    contextOptions: { reducedMotion: 'reduce' },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node "${viteEntry}" --config "${path.join(fixtureRoot, 'vite.config.ts')}"`,
    cwd: sourceRoot,
    url: 'http://127.0.0.1:4177/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
