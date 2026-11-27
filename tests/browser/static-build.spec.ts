import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startStaticServer } from '../support/static-server.ts';

async function assertApplicationLoaded(page: Page, url: string) {
  const failures: string[] = [];
  page.on('response', response => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
  });
  page.on('requestfailed', request => failures.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on('pageerror', error => failures.push(error.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  expect(failures, 'all production assets load successfully').toEqual([]);
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByRole('heading', { name: 'Writedown', exact: true })).toBeVisible();
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  for (const scale of [100, 200]) {
    test(`production smoke ${viewport.width}x${viewport.height} text-${scale}`, async ({ page }, testInfo) => {
      const server = await startStaticServer(resolve('dist'));
      try {
        await page.setViewportSize(viewport);
        await page.addInitScript(value => {
          document.addEventListener('DOMContentLoaded', () => {
            document.documentElement.style.fontSize = `${value}%`;
          });
        }, scale);
        await assertApplicationLoaded(page, server.url);
        expect(server.requests.some(request => /\/assets\/.*\.js/.test(request.path))).toBe(true);
        expect(server.requests.filter(request => request.status >= 400)).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath('static-build.png'), fullPage: true });
      } finally {
        await testInfo.attach('server-requests', { body: JSON.stringify(server.requests), contentType: 'application/json' });
        await server.close();
      }
    });
  }
}

test('smoke gate rejects a deliberately missing production entry asset', async ({ page }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'writedown-broken-'));
  await cp(resolve('dist'), root, { recursive: true });
  const html = await readFile(join(root, 'index.html'), 'utf8');
  const entry = html.match(/<script[^>]+src="\/writedown\/([^\"]+)"/);
  expect(entry, 'build has a module entry').not.toBeNull();
  await rm(join(root, entry![1]));
  const server = await startStaticServer(root);
  try {
    await expect(assertApplicationLoaded(page, server.url)).rejects.toThrow('all production assets load successfully');
    expect(server.requests.some(request => request.status === 404 && request.path.endsWith(entry![1]))).toBe(true);
    await expect(page.locator('#app')).not.toHaveAttribute('data-ready', 'true');
  } finally {
    await testInfo.attach('server-requests', { body: JSON.stringify(server.requests), contentType: 'application/json' });
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
