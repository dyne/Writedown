import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startStaticServer } from '../support/static-server.ts';

const entry = 'paper/main.tex';
const chapter = 'paper/chapters/intro.tex';
const original = 'Original page two marker.';
const repaired = 'Repaired page two marker.';
const fault = String.raw`\noindent
\NotDefinedHere`;
const nestedSource = (marker: string) => String.raw`\noindent
{\LARGE ${marker}}`;
const sourceDocument = (body: string) => String.raw`\documentclass{article}
\begin{document}
${body}
\end{document}`;
const rootSource = sourceDocument(String.raw`{\LARGE First page marker.}
\newpage
\input{chapters/intro.tex}`);

const source = (page: Page) => page.getByRole('textbox', { name: 'Source code' });
const preview = (page: Page) => page.getByRole('region', { name: 'PDF preview' });
const pdfStatus = (page: Page) => page.locator('#pdf-revision');
const compileStatus = (page: Page) => page.locator('#project-compile-status');
const zoom = (page: Page) => preview(page).getByRole('combobox', { name: 'PDF zoom' });
const text = (page: Page, marker: string) => preview(page).locator('.pdf-text').getByText(marker, { exact: true });
const revision = async (page: Page) => Number(await compileStatus(page).getAttribute('data-revision'));
const pdfWorker = /\/assets\/pdf\.worker\.min-[^/]+\.mjs$/;

const test = base.extend<{
  lab: { url: string; workers: string[]; requests: Awaited<ReturnType<typeof startStaticServer>>['requests'] };
}>({
  lab: async ({ page }, use, info) => {
    const server = await startStaticServer(resolve('dist'));
    const workers: string[] = [];
    const browserRequests: string[] = [];
    page.on('worker', worker => workers.push(worker.url()));
    page.context().on('request', request => browserRequests.push(request.url()));
    try {
      await use({ ...server, workers });
      expect(browserRequests.every(url => url.startsWith(server.url))).toBe(true);
      for (const row of server.requests) {
        expect(row.method).toBe('GET');
        expect(row.bodyBytes).toBe(0);
        expect(row.status).toBe(200);
        expect(JSON.stringify(row)).not.toMatch(/Original page two marker|Repaired page two marker|NotDefinedHere|paper\/chapters\/intro\.tex/);
      }
    } finally {
      await server.close();
      await writeFile(info.outputPath('pdf-traffic.json'), JSON.stringify({ workers, browserRequests, requests: server.requests }, null, 2));
    }
  },
});

async function createFile(page: Page, path: string, value: string) {
  await page.getByText('New source file', { exact: true }).press('Enter');
  await page.getByRole('textbox', { name: 'File path' }).fill(path);
  await page.getByRole('button', { name: 'Create file', exact: true }).press('Enter');
  await source(page).fill(value);
}

async function assertCurrent(page: Page, revision: number, marker: string) {
  await expect(compileStatus(page)).toHaveText(`Revision ${revision} compiled.`, { timeout: 60_000 });
  await expect(pdfStatus(page)).toHaveText(`PDF revision ${revision} · Current`, { timeout: 30_000 });
  const mark = text(page, marker);
  await expect(mark).toBeVisible();
  await mark.scrollIntoViewIfNeeded();
  await expect(mark).toBeInViewport();
  // Text geometry must overlay the real ink, not merely exist in a DOM layer.
  const ink = await mark.evaluate(element => {
    const canvas = element.closest('.pdf-page')!.querySelector('canvas')!;
    const box = element.getBoundingClientRect();
    const page = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.floor((box.left - page.left) * canvas.width / page.width));
    const y = Math.max(0, Math.floor((box.top - page.top) * canvas.height / page.height));
    const width = Math.min(canvas.width - x, Math.ceil(box.width * canvas.width / page.width));
    const height = Math.min(canvas.height - y, Math.ceil(box.height * canvas.height / page.height));
    if (width < 1 || height < 1) return 0;
    const rgba = canvas.getContext('2d')!.getImageData(x, y, width, height).data;
    return rgba.filter((value, index) => index % 4 === 0 && value < 128).length;
  });
  expect(ink).toBeGreaterThan(12);
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  for (const scale of [100, 200]) {
    test(`pdf current and stale ${viewport.width}x${viewport.height} text-${scale}`, async ({ page, lab }, info) => {
      test.setTimeout(120_000);
      await page.setViewportSize(viewport);
      await page.addInitScript(value => {
        document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = `${value}%`; });
      }, scale);
      await page.goto(lab.url);
      await createFile(page, entry, rootSource);
      await createFile(page, chapter, nestedSource(original));
      const first = await revision(page);
      await assertCurrent(page, first, 'First page marker.');
      const next = preview(page).getByRole('button', { name: 'Next page' });
      await next.press('Enter');
      await expect(text(page, original)).toBeVisible();
      await expect(next).toBeFocused();
      await expect(next).toBeDisabled();
      const previous = preview(page).getByRole('button', { name: 'Previous page' });
      expect((await previous.boundingBox())?.y).toBe((await next.boundingBox())?.y);
      const fitted = Number(await preview(page).locator('canvas').evaluate(element => (element as HTMLCanvasElement).width));
      await zoom(page).selectOption('125');
      await expect.poll(() => preview(page).locator('canvas').evaluate(element => (element as HTMLCanvasElement).width)).toBeGreaterThan(fitted);
      await expect(page.locator('#pdf-page-number')).toHaveText('Page 2 of 2');

      await source(page).fill(fault);
      const failed = await revision(page);
      await expect(compileStatus(page)).toHaveText(`Revision ${failed} failed.`, { timeout: 45_000 });
      await expect(pdfStatus(page)).toHaveText(`PDF revision ${first} · Stale`);
      await expect(source(page)).toBeFocused();
      await expect(text(page, original)).toBeVisible();
      await expect(page.locator('#pdf-page-number')).toHaveText('Page 2 of 2');
      await expect(zoom(page)).toHaveValue('125');
      const jump = preview(page).getByRole('button', { name: `Open ${chapter}, line 2` });
      await expect(jump).toBeVisible();
      await expect(preview(page).getByRole('list', { name: 'Compilation diagnostics' })).toContainText('Undefined control sequence.');
      await preview(page).screenshot({ path: info.outputPath('pdf-stale.png') });

      const raw = preview(page).getByText('Raw pass logs', { exact: true });
      await raw.press('Enter');
      await expect(preview(page).locator('pre').last()).toContainText('NotDefinedHere');
      await raw.press('Enter');
      await expect(preview(page).locator('pre').last()).toBeHidden();
      const file = page.getByRole('combobox', { name: 'File', exact: true });
      await file.selectOption(entry);
      await jump.press('Enter');
      await expect(file).toHaveValue(chapter);
      await expect(source(page)).toBeFocused();
      expect(await source(page).evaluate((textarea: HTMLTextAreaElement) =>
        textarea.value.slice(textarea.selectionStart, textarea.selectionEnd))).toBe('\\NotDefinedHere');

      await source(page).fill(nestedSource(repaired));
      const fixed = await revision(page);
      await assertCurrent(page, fixed, repaired);
      await expect(source(page)).toBeFocused();
      await expect(text(page, original)).toHaveCount(0);
      await expect(jump).toHaveCount(0);
      await expect(page.locator('#pdf-page-number')).toHaveText('Page 2 of 2');
      await expect(zoom(page)).toHaveValue('125');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
      await preview(page).screenshot({ path: info.outputPath('pdf-current.png') });
      expect(lab.workers.filter(url => pdfWorker.test(url))).toHaveLength(2);
    });
  }
}

test('a first-build error leaves diagnostics and source editing available', async ({ page, lab }) => {
  test.setTimeout(90_000);
  await page.goto(lab.url);
  await createFile(page, entry, sourceDocument(fault));
  const failed = await revision(page);
  await expect(compileStatus(page)).toHaveText(`Revision ${failed} failed.`, { timeout: 60_000 });
  await expect(preview(page).getByRole('list', { name: 'Compilation diagnostics' })).toContainText('Undefined control sequence.');
  await expect(preview(page).getByText('No PDF to display.')).toBeVisible();
  await expect(pdfStatus(page)).toBeHidden();
  await expect(preview(page).locator('canvas')).toHaveCount(0);
  await expect(source(page)).toBeFocused();
  expect(lab.workers.filter(url => pdfWorker.test(url))).toEqual([]);
});

declare global {
  interface Window {
    pdfFixture: {
      corruptNext: boolean;
      corruptions: number;
      holdNext: boolean;
      held: number;
      heldWorker: number | undefined;
      terminated: number[];
      published: string[];
      release?: () => void;
    };
  }
}

test('unreadable and superseded PDFs preserve the last good page and retire their workers', async ({ page, lab }, info) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const proof: Window['pdfFixture'] = {
      corruptNext: false, corruptions: 0, holdNext: false, held: 0, heldWorker: undefined, terminated: [], published: [],
    };
    window.pdfFixture = proof;
    const WorkerConstructor = window.Worker;
    let pdfWorkers = 0;
    window.Worker = class extends WorkerConstructor {
      readonly id: number | undefined;
      private gate?: { stream: number; source: string; held: MessageEvent[] };
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (/\/pdf\.worker\.min-[^/]+\.mjs$/.test(String(url))) {
          this.id = ++pdfWorkers;
          this.addEventListener('message', event => {
            const { streamId, targetName, stream } = event.data;
            const gate = this.gate;
            // Hold genuine operator-list data and EOF after the worker has parsed the PDF.
            if (gate && gate.stream === streamId && gate.source === targetName && (stream === 3 || stream === 4)) {
              event.stopImmediatePropagation();
              gate.held.push(event);
              proof.held++;
            }
          });
        }
        if (String(url).endsWith('/busytex_worker.js')) {
          this.addEventListener('message', event => {
            if (proof.corruptNext && event.data.exit_code === 0 && event.data.pdf?.length) {
              proof.corruptNext = false;
              proof.corruptions++;
              event.data.pdf = new Uint8Array([1, 2, 3, 4]);
            }
          });
        }
      }
      override postMessage(data: { action?: string; streamId: number; sourceName: string }) {
        if (this.id && proof.holdNext && data.action === 'GetOperatorList') {
          proof.holdNext = false;
          proof.heldWorker = this.id;
          const gate: NonNullable<typeof this.gate> = { stream: data.streamId, source: data.sourceName, held: [] };
          this.gate = gate;
          proof.release = () => {
            this.gate = undefined;
            for (const held of gate.held.splice(0)) this.dispatchEvent(new MessageEvent('message', { data: held.data }));
            proof.held = 0;
            proof.release = undefined;
          };
        }
        Reflect.apply(WorkerConstructor.prototype.postMessage, this, arguments);
      }
      override terminate() {
        if (this.id) proof.terminated.push(this.id);
        super.terminate();
      }
    };
    document.addEventListener('DOMContentLoaded', () => {
      const observer = new MutationObserver(records => {
        for (const { addedNodes } of records) {
          for (const node of addedNodes) {
            if (node instanceof Element && node.matches('.pdf-page')) proof.published.push(node.textContent ?? '');
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  });

  try {
    await page.goto(lab.url);
    await createFile(page, entry, sourceDocument(original));
    const first = await revision(page);
    await assertCurrent(page, first, original);
    await page.evaluate(() => { window.pdfFixture.corruptNext = true; });
    await source(page).fill(sourceDocument('Unreadable revision marker.'));
    const unreadable = await revision(page);
    await expect(compileStatus(page)).toHaveText(`Revision ${unreadable} compiled.`);
    await expect(preview(page).getByText(`Could not display the PDF for revision ${unreadable}.`)).toBeVisible();
    await expect(pdfStatus(page)).toHaveText(`PDF revision ${first} · Stale`);
    await expect(source(page)).toBeFocused();
    await expect(text(page, original)).toBeVisible();
    await expect(preview(page).getByRole('button', { name: 'Retry compilation' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.pdfFixture.terminated)).toContain(2);
    expect(await page.evaluate(() => window.pdfFixture.corruptions)).toBe(1);

    await page.evaluate(() => { window.pdfFixture.holdNext = true; });
    await source(page).fill(sourceDocument('Superseded revision marker.'));
    const slow = await revision(page);
    await expect(compileStatus(page)).toHaveText(`Revision ${slow} compiled.`);
    await expect.poll(() => page.evaluate(() => window.pdfFixture.held), { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(preview(page).getByText(`Opening PDF for revision ${slow}…`)).toBeVisible();
    await expect(pdfStatus(page)).toHaveText(`PDF revision ${first} · Stale`);
    await expect(text(page, original)).toBeVisible();
    expect(await page.evaluate(() => window.pdfFixture.heldWorker)).toBe(3);
    await source(page).fill(sourceDocument(repaired));
    const fixed = await revision(page);
    await expect.poll(() => page.evaluate(() => window.pdfFixture.terminated)).toContain(3);
    await page.evaluate(() => window.pdfFixture.release?.());
    await assertCurrent(page, fixed, repaired);
    await expect.poll(() => page.evaluate(() => window.pdfFixture.terminated)).toContain(1);
    await expect(source(page)).toBeFocused();

    await zoom(page).selectOption('150');
    await page.getByText('New project', { exact: true }).press('Enter');
    await page.getByRole('textbox', { name: 'Project name' }).fill('Replacement');
    await page.getByRole('button', { name: 'Create project' }).press('Enter');
    const projects = page.getByRole('combobox', { name: 'Project', exact: true });
    await expect(projects).toHaveValue('Replacement');
    await expect(pdfStatus(page)).toBeHidden();
    await expect(preview(page).locator('canvas')).toHaveCount(0);
    await expect(preview(page).getByText('No compiled PDF yet.')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.pdfFixture.terminated)).toContain(4);
    await createFile(page, entry, sourceDocument('Replacement project marker.'));
    await assertCurrent(page, await revision(page), 'Replacement project marker.');
    await expect(zoom(page)).toHaveValue('100');
    await expect(text(page, repaired)).toHaveCount(0);
    await projects.selectOption('Untitled project');
    await expect(projects).toHaveValue('Untitled project');
    await expect(text(page, 'Replacement project marker.')).toHaveCount(0);
    await assertCurrent(page, fixed, repaired);
    const evidence = await page.evaluate(() => {
      const { corruptions, held, heldWorker, terminated, published } = window.pdfFixture;
      return { corruptions, held, heldWorker, terminated, published };
    });
    expect(evidence.held).toBe(0);
    expect(evidence.published).not.toEqual(expect.arrayContaining([expect.stringContaining('Superseded revision marker.')]));
    expect(pageErrors).toEqual([]);
    await writeFile(info.outputPath('pdf-render-lifecycle.json'), JSON.stringify(evidence, null, 2));
  } finally {
    await page.evaluate(() => {
      const proof = window.pdfFixture;
      if (!proof) return;
      proof.holdNext = false;
      proof.release?.();
      if (proof.held) throw new Error('The PDF operator-list gate is still held.');
    }).catch(error => { if (!page.isClosed()) throw error; });
  }
});
