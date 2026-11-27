import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CompilationState } from '../../src/compiler/service.ts';
import type { CompilationSuccess } from '../../src/compiler/contracts.ts';
import { startStaticServer } from '../support/static-server.ts';

const rootPath = 'paper/main.tex';
const firstPath = 'paper/chapters/first/topic.tex';
const secondPath = 'paper/chapters/second/topic.tex';
const markerLine = 5;
const fixtures = [
  { path: firstPath, name: 'Amber locator.', label: 'amber', page: 1, rotation: 0 },
  { path: secondPath, name: 'Indigo locator.', label: 'indigo', page: 2, rotation: 90 },
] as const;
const chapter = ({ label, name }: typeof fixtures[number]) => String.raw`% Nested source
\section{${label} chapter}\label{sec:${label}}
\vspace*{365pt}
\noindent
{\LARGE ${name}}\par`;
const root = String.raw`\documentclass{article}
\begin{document}
\input{chapters/first/topic.tex}
\newpage
\pdfpageattr{/Rotate 90}
\input{chapters/second/topic.tex}
\end{document}`;

const editor = (page: Page) => page.getByRole('textbox', { name: 'Source code' });
const files = (page: Page) => page.getByRole('combobox', { name: 'File', exact: true });
const toPdf = (page: Page) => page.getByRole('button', { name: 'Show in PDF' });
const toSource = (page: Page) => page.getByRole('button', { name: 'Open source', exact: true });
const syncStatus = (page: Page) => page.locator('#pdf-sync-status');
const highlight = (page: Page) => page.locator('.pdf-source-highlight');
const zoom = (page: Page) => page.getByRole('combobox', { name: 'PDF zoom' });
const marker = (page: Page, text: string) => page.locator('.pdf-text').getByText(text, { exact: true });
const scroller = (page: Page) => page.getByRole('region', { name: 'PDF page' });

declare global {
  interface Window {
    synctexFixture: { output?: CompilationSuccess; remove: boolean; removed: number; corrupt: boolean; corrupted: number };
  }
}

const test = base.extend<{ site: string }>({
  site: async ({ page }, use, info) => {
    const server = await startStaticServer(resolve('dist'));
    const browserRequests: string[] = [];
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.context().on('request', request => browserRequests.push(request.url()));
    await page.addInitScript(() => {
      window.synctexFixture = { remove: false, removed: 0, corrupt: false, corrupted: 0 };
      window.addEventListener('writedown:compilation-state', event => {
        const state = (event as CustomEvent<CompilationState>).detail;
        if (state.status === 'settled' && state.result.status === 'success') window.synctexFixture.output = state.result;
      });
    });
    try {
      await use(server.url);
      expect(pageErrors).toEqual([]);
      expect(browserRequests.every(url => url.startsWith(server.url))).toBe(true);
      expect(server.requests.every(request => request.method === 'GET' && request.bodyBytes === 0 && request.status === 200)).toBe(true);
      expect(JSON.stringify(server.requests)).not.toMatch(/first\/topic\.tex|second\/topic\.tex|Amber locator|Indigo locator/);
    } finally {
      await server.close();
      await writeFile(info.outputPath('source-jump-traffic.json'), JSON.stringify({ pageErrors, browserRequests, requests: server.requests }, null, 2));
    }
  },
});

async function createFile(page: Page, path: string, contents: string) {
  await page.getByText('New source file', { exact: true }).press('Enter');
  await page.getByRole('textbox', { name: 'File path' }).fill(path);
  await page.getByRole('button', { name: 'Create file', exact: true }).press('Enter');
  await editor(page).fill(contents);
}

async function startDocument(page: Page, site: string) {
  await page.goto(site);
  await createFile(page, rootPath, root);
  for (const item of fixtures) await createFile(page, item.path, chapter(item));
  await expect(page.locator('#pdf-revision')).toContainText('Current', { timeout: 60_000 });
}

async function selectLine(page: Page, path: string, line: number) {
  await files(page).selectOption(path);
  await page.getByRole('spinbutton', { name: 'Line', exact: true }).fill(String(line));
  await page.getByRole('button', { name: 'Go to line' }).press('Enter');
  await expect(editor(page)).toBeFocused();
}

async function assertForward(page: Page, item: typeof fixtures[number]) {
  await selectLine(page, item.path, markerLine);
  await toPdf(page).press('Enter');
  await expect(page.locator('#pdf-page-number')).toHaveText(`Page ${item.page} of 2`);
  await expect(highlight(page)).toBeVisible();
  await expect(page.locator('.pdf-text')).toHaveAttribute('data-main-rotation', String(item.rotation));
  const found = marker(page, item.name);
  await expect(found).toBeVisible();
  await found.scrollIntoViewIfNeeded();
  const mark = await highlight(page).boundingBox();
  const text = await found.boundingBox();
  expect(mark).not.toBeNull();
  expect(text).not.toBeNull();
  const intersectionWidth = Math.min(mark!.x + mark!.width, text!.x + text!.width) - Math.max(mark!.x, text!.x);
  const intersectionHeight = Math.min(mark!.y + mark!.height, text!.y + text!.height) - Math.max(mark!.y, text!.y);
  expect(intersectionWidth, `${item.name} highlight covers the text horizontally`).toBeGreaterThan(1);
  expect(intersectionHeight, `${item.name} highlight covers the text vertically`).toBeGreaterThan(1);
  expect(intersectionWidth * intersectionHeight / (text!.width * text!.height)).toBeGreaterThan(0.45);
  return { mark, text, intersectionWidth, intersectionHeight };
}

async function assertInverse(page: Page, item: typeof fixtures[number], zoomFactor: number) {
  await files(page).selectOption(rootPath);
  if (zoomFactor === 200) {
    await scroller(page).evaluate((element, rotated) => {
      if (rotated) element.scrollLeft = 48;
      else element.scrollTop = 48;
    }, Boolean(item.rotation));
  }
  await marker(page, item.name).scrollIntoViewIfNeeded();
  const scroll = await scroller(page).evaluate(node => ({ left: node.scrollLeft, top: node.scrollTop, windowY: window.scrollY }));
  if (zoomFactor === 200) expect(item.rotation ? scroll.left : scroll.top).toBeGreaterThan(10);
  const position = (await marker(page, item.name).boundingBox())!;
  const x = position.x + position.width / 2;
  const y = position.y + position.height / 2;
  await page.mouse.dblclick(x, y);
  await expect(files(page)).toHaveValue(item.path);
  await expect(editor(page)).toBeFocused();
  const line = Number(await page.getByRole('spinbutton', { name: 'Line', exact: true }).inputValue());
  expect(Math.abs(line - markerLine)).toBeLessThanOrEqual(1);
  return { x, y, line, scroll };
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  for (const scale of [100, 200]) {
    test(`source-jump ${viewport.width}x${viewport.height} text-${scale}`, async ({ page, site }, info) => {
      test.setTimeout(120_000);
      await page.setViewportSize(viewport);
      await page.addInitScript(value => {
        document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = `${value}%`; });
      }, scale);
      await startDocument(page, site);
      const artifacts = await page.evaluate(async () => {
        const output = window.synctexFixture.output;
        if (!output?.syncTex?.size) throw new Error('Expected a real BusyTeX PDF+SyncTeX pair');
        return {
          attempt: output.attempt, pdf: Array.from(new Uint8Array(await output.pdf.arrayBuffer())),
          sidecar: Array.from(new Uint8Array(await output.syncTex.arrayBuffer())),
        };
      });
      await writeFile(info.outputPath('source-jump.pdf'), Buffer.from(artifacts.pdf));
      await writeFile(info.outputPath('source-jump.synctex.gz'), Buffer.from(artifacts.sidecar));
      await expect(toPdf(page)).toBeEnabled();
      await expect(toSource(page)).toBeEnabled();

      const observations = [];
      for (const factor of [100, 200]) {
        const width = await page.locator('.pdf-page').evaluate(element => element.clientWidth);
        await zoom(page).selectOption(String(factor));
        if (factor === 200) await expect.poll(() => page.locator('.pdf-page').evaluate(element => element.clientWidth)).toBeGreaterThan(width);
        for (const item of [...fixtures].reverse()) {
          const forward = await assertForward(page, item);
          if (factor === 200 && item.page === 1) {
            await page.getByRole('region', { name: 'PDF preview' }).screenshot({ path: info.outputPath('source-jump.png') });
          }
          const inverse = await assertInverse(page, item, factor);
          observations.push({ path: item.path, page: item.page, rotation: item.rotation, zoom: factor, forward, inverse });
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
      await writeFile(info.outputPath('source-jump-geometry.json'), JSON.stringify({
        viewport, textScale: scale, attempt: artifacts.attempt, observations,
      }, null, 2));
    });
  }
}

test('stale mappings disappear immediately and return only for the repaired revision', async ({ page, site }) => {
  test.setTimeout(90_000);
  await startDocument(page, site);
  await expect(toPdf(page)).toBeEnabled();
  await assertForward(page, fixtures[1]);
  await editor(page).fill(String.raw`Broken source
\NotARealCommand`);
  await expect(page.locator('#pdf-revision')).toContainText('Stale');
  await expect(highlight(page)).toHaveCount(0);
  await expect(toPdf(page)).toBeDisabled();
  await expect(toSource(page)).toBeDisabled();
  await expect(syncStatus(page)).toHaveText('Source navigation is unavailable while the PDF is stale.');
  await expect(page.locator('#project-compile-status')).toContainText('failed.');
  await files(page).selectOption(rootPath);
  await marker(page, fixtures[1].name).dblclick();
  await expect(files(page)).toHaveValue(rootPath);
  await toPdf(page).press('Enter');
  await expect(highlight(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Previous page' }).press('Enter');
  await expect(marker(page, fixtures[0].name)).toBeVisible();
  await files(page).selectOption(secondPath);
  await editor(page).fill(chapter(fixtures[1]));
  await expect(page.locator('#pdf-revision')).toContainText('Current', { timeout: 30_000 });
  await expect(toPdf(page)).toBeEnabled();
  await assertForward(page, fixtures[1]);
  await files(page).selectOption(rootPath);
  await toSource(page).press('Enter');
  await expect(files(page)).toHaveValue(secondPath);
  await expect(editor(page)).toBeFocused();
});

test('missing and unreadable sidecars leave the current PDF usable', async ({ page, site }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (!String(url).endsWith('/busytex_worker.js')) return;
        this.addEventListener('message', event => {
          const fixture = window.synctexFixture;
          if (!event.data.synctex?.length || event.data.exit_code !== 0) return;
          if (fixture.remove) {
            event.data.synctex = null;
            fixture.removed++;
          }
          if (fixture.corrupt) {
            event.data.synctex = new Uint8Array([0x1f, 0x8b, 0x00]);
            fixture.corrupted++;
          }
        });
      }
    };
    document.addEventListener('DOMContentLoaded', () => { window.synctexFixture.remove = true; });
  });
  await startDocument(page, site);
  await expect(syncStatus(page)).toContainText('this PDF has no SyncTeX sidecar');
  await expect(toPdf(page)).toBeDisabled();
  await expect(toSource(page)).toBeDisabled();
  await expect(marker(page, fixtures[0].name)).toBeVisible();
  expect(await page.evaluate(() => window.synctexFixture.removed)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Next page' }).press('Enter');
  await expect(marker(page, fixtures[1].name)).toBeVisible();
  await zoom(page).selectOption('200');
  await page.evaluate(() => {
    window.synctexFixture.remove = false;
    window.synctexFixture.corrupt = true;
  });
  await editor(page).fill(chapter(fixtures[1]) + '\n% another revision');
  await expect(syncStatus(page)).toContainText('Source locations could not be read');
  await expect(page.locator('#pdf-revision')).toContainText('Current');
  await expect(highlight(page)).toHaveCount(0);
  await expect(toSource(page)).toBeDisabled();
  await expect(editor(page)).toBeFocused();
  await expect(marker(page, fixtures[1].name)).toBeVisible();
  expect(await page.evaluate(() => window.synctexFixture.corrupted)).toBeGreaterThan(0);
});
