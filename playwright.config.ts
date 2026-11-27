import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

const outputDir = process.env.WRITEDOWN_TEST_OUTPUT ?? 'test-results';

export default defineConfig({
  testDir: './tests/browser',
  outputDir,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: join(outputDir, 'results.json') }]],
  use: {
    browserName: 'chromium',
    headless: true,
    launchOptions: process.env.WRITEDOWN_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WRITEDOWN_BROWSER_EXECUTABLE }
      : {},
    trace: 'retain-on-failure',
  },
});
