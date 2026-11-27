import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { startStaticServer } from '../support/static-server.ts';
import release from '../../compiler-release.json' with { type: 'json' };

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
for (const scale of [100, 200]) {
test(`production worker compiles reference PDF and SyncTeX ${viewport.width}x${viewport.height} text-${scale}`, async ({ page, context }, testInfo) => {
  test.setTimeout(120_000);
  const server = await startStaticServer(resolve('dist'));
  const workers: string[] = [];
  const requests: string[] = [];
  const consoleMessages: string[] = [];
  const errors: string[] = [];
  context.on('request', request => requests.push(request.url()));
  page.on('worker', worker => workers.push(worker.url()));
  page.on('console', message => consoleMessages.push(message.text()));
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(server.url).origin ? route.continue() : route.abort());
  try {
    await page.setViewportSize(viewport);
    await page.addInitScript(value => {
      document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.style.fontSize = `${value}%`;
      });
    }, scale);
    await page.goto(server.url);
    await page.getByRole('button', { name: 'Compile example', exact: true }).click();
    const status = page.locator('.reference-compiler').getByRole('status');
    await expect(status).toHaveText('Example compiled successfully.', { timeout: 100_000 });
    expect(workers).toContain(new URL(`compiler/${release.id}/busytex_worker.js`, server.url).href);
    expect(errors).toEqual([]);
    expect(requests.every(url => new URL(url).origin === new URL(server.url).origin)).toBe(true);
    expect(server.requests.filter(request => request.status !== 200)).toEqual([]);
    expect(server.requests.some(request => request.path.endsWith('/texlive-basic.data'))).toBe(true);

    async function download(name: string, filename: string) {
      const pending = page.waitForEvent('download');
      await page.getByRole('link', { name, exact: true }).click();
      const result = await pending;
      const path = testInfo.outputPath(filename);
      await result.saveAs(path);
      return path;
    }
    const pdf = await download('Download PDF', 'reference.pdf');
    const syncTex = await download('Download SyncTeX', 'reference.synctex.gz');
    const logs = await download('Download compilation log', 'pass-logs.json');
    const passes = JSON.parse(await readFile(logs, 'utf8')) as { exitCode: number; text: string }[];
    expect(passes.length).toBeGreaterThan(0);
    expect(passes.every(pass => pass.exitCode === 0)).toBe(true);
    const { stdout } = await promisify(execFile)('pdftotext', [pdf, '-']);
    await writeFile(testInfo.outputPath('reference.txt'), stdout);
    expect(stdout).toContain('Writedown compiler proof 2026.');
    const decoded = gunzipSync(await readFile(syncTex)).toString('utf8');
    await writeFile(testInfo.outputPath('reference.synctex'), decoded);
    expect(decoded).toMatch(/^SyncTeX Version:1\n/);
    expect(decoded).toMatch(/Input:1:.*main\.tex/);
    expect(decoded).toContain('Output:pdf');
    expect(decoded).toContain('Content:');
    expect(decoded).toContain('Postamble:');
    await expect(page.getByRole('button', { name: 'Compile example', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('compiler-proof.png'), fullPage: true });
  } finally {
    await writeFile(testInfo.outputPath('worker-console.json'), JSON.stringify(consoleMessages, null, 2));
    await writeFile(testInfo.outputPath('requests.json'), JSON.stringify({ workers, requests, serverRequests: server.requests, errors }, null, 2));
    await server.close();
  }
});
}
}
