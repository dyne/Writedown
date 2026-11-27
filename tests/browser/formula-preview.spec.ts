import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startStaticServer } from '../support/static-server.ts';

type StaticServer = Awaited<ReturnType<typeof startStaticServer>>;
const test = base.extend<{ staticUrl: string }>({
  staticUrl: async ({ page }, use, info) => {
    const server: StaticServer = await startStaticServer(resolve('dist'));
    const workers: string[] = [];
    const browserRequests: string[] = [];
    page.on('worker', worker => workers.push(worker.url()));
    page.on('request', request => browserRequests.push(request.url()));
    try {
      await use(server.url);
      expect(browserRequests.every(url => url.startsWith(server.url))).toBe(true);
      expect(server.requests.every(row => row.method === 'GET' && row.bodyBytes === 0)).toBe(true);
      expect(server.requests.some(row => /\/assets\/KaTeX_[^/]+\.woff2$/.test(row.path) && row.status === 200)).toBe(true);
    } finally {
      await server.close();
      await writeFile(info.outputPath('formula-requests.json'), JSON.stringify({ workers, browserRequests, requests: server.requests }));
    }
  },
});

const source = (page: Page) => page.getByRole('textbox', { name: 'Source code' });
const formula = (page: Page) => page.getByRole('region', { name: 'Formula preview' });
const math = (page: Page) => formula(page).locator('math');
const formulaStatus = (page: Page) => formula(page).getByRole('status');
const compileStatus = (page: Page) => page.locator('#project-compile-status');
const pdfStatus = (page: Page) => page.locator('#pdf-revision');

async function selectMath(page: Page, expression: string) {
  await source(page).focus();
  await source(page).evaluate((textarea: HTMLTextAreaElement, value) => {
    const start = textarea.value.indexOf(value);
    if (start === -1) throw new Error('The expression is missing from the source fixture.');
    textarea.setSelectionRange(start, start + value.length);
  }, expression);
}

async function replaceSelection(page: Page, expression: string) {
  await source(page).evaluate((textarea: HTMLTextAreaElement, text) => {
    textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'select');
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }, expression);
}

async function importFiles(page: Page, files: Record<string, string>) {
  await expect(page.getByRole('button', { name: 'Import files' })).toBeEnabled();
  await page.locator('#file-input').setInputFiles(Object.entries(files).map(([name, text]) => ({
    name, mimeType: 'text/plain', buffer: Buffer.from(text),
  })));
  await expect(source(page)).toHaveValue(Object.values(files)[0]);
}

const fraction = String.raw`\[\frac{1}{3}\]`;
const editedFraction = String.raw`\[\frac{2}{3}\]`;
const malformed = String.raw`\frac{7}{`;
const projectMacro = String.raw`\PreviewRatio{6}`;

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  for (const scale of [100, 200]) {
    test(`formula default and error ${viewport.width}x${viewport.height} text-${scale}`, async ({ page, staticUrl }, info) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(value => {
        document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = `${value}%`; });
      }, scale);
      await page.goto(staticUrl);
      await importFiles(page, { 'formula-examples.bib': [fraction, malformed, projectMacro].join('\n') });
      await expect(formulaStatus(page)).toHaveText('Select a math expression in the source.');
      await selectMath(page, fraction);
      await expect(math(page)).toHaveAttribute('display', 'block');
      await expect(math(page).locator('mfrac')).toHaveCount(1);
      await expect(source(page)).toBeFocused();
      await page.screenshot({ path: info.outputPath('formula-default.png'), fullPage: true });
      await expect(source(page)).toBeFocused();

      await selectMath(page, malformed);
      await expect(formulaStatus(page)).toContainText('Could not preview this formula.');
      await expect(math(page)).toHaveCount(0);
      await expect(source(page)).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
      await page.screenshot({ path: info.outputPath('formula-error.png'), fullPage: true });
      await expect(source(page)).toBeFocused();
    });
  }
}

declare global {
  interface Window {
    formulaCompileProof: {
      posted: number;
      settled: number;
      holding: boolean;
      heldReplyReceived: boolean;
      release?: () => void;
    };
  }
}

test('selection renders and errors during a held worker compile, with isolated project macros', async ({ page, staticUrl }, info) => {
  test.setTimeout(150_000);
  await page.addInitScript(() => {
    const proof: Window['formulaCompileProof'] = {
      posted: 0, settled: 0, holding: false, heldReplyReceived: false,
    };
    window.formulaCompileProof = proof;
    window.addEventListener('writedown:compilation-state', event => {
      if ((event as CustomEvent<{ status: string }>).detail.status === 'settled') proof.settled += 1;
    });
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: { files?: unknown }) {
      if (message?.files && ++proof.posted === 2) {
        const worker = this;
        const receive = worker.onmessage;
        // Delay delivery of this genuine job to the initialized worker so the
        // selection update is guaranteed to precede its completion.
        proof.holding = true;
        proof.release = () => {
          proof.holding = false;
          proof.release = undefined;
          worker.onmessage = event => {
            if (event.data.pdf instanceof Uint8Array) {
              proof.heldReplyReceived = true;
              worker.onmessage = receive;
            }
            receive?.call(worker, event);
          };
          Reflect.apply(post, worker, arguments);
        };
        return;
      }
      return Reflect.apply(post, this, arguments);
    };
  });
  const document = (marker: string) => String.raw`\documentclass{article}
\begin{document}
${marker}
% ${fraction}
% ${malformed}
% ${projectMacro}
\end{document}`;
  const proof = () => page.evaluate(() => ({
    posted: window.formulaCompileProof.posted, settled: window.formulaCompileProof.settled,
    holding: window.formulaCompileProof.holding, heldReplyReceived: window.formulaCompileProof.heldReplyReceived,
  }));
  const release = () => page.evaluate(() => window.formulaCompileProof?.release?.());

  try {
    await page.goto(staticUrl);
    await importFiles(page, {
      'main.tex': document('Original PDF marker.'),
      'formula-macros.tex': String.raw`\newcommand{\PreviewRatio}[1]{\frac{#1}{5}}`,
    });
    await expect(pdfStatus(page)).toContainText('Current', { timeout: 60_000 });
    const originalPdf = (await pdfStatus(page).innerText()).replace('Current', 'Stale');
    const marker = page.locator('.pdf-text').getByText('Original PDF marker.', { exact: true });
    await expect(marker).toBeVisible();
    await selectMath(page, projectMacro);
    await expect(math(page).locator('mfrac mn')).toHaveText(['6', '5']);

    await source(page).fill(document('Pending PDF marker.'));
    await selectMath(page, fraction);
    await expect(math(page).locator('mfrac mn')).toHaveText(['1', '3']);
    const pending = { posted: 2, settled: 1, holding: true, heldReplyReceived: false };
    await expect.poll(proof, { timeout: 60_000 }).toEqual(pending);
    await expect(compileStatus(page)).toHaveAttribute('data-state', 'compiling');
    await replaceSelection(page, editedFraction);
    await expect(math(page).locator('mfrac mn')).toHaveText(['2', '3']);
    await expect(compileStatus(page)).toHaveAttribute('data-state', 'queued');
    await expect(source(page)).toBeFocused();

    await selectMath(page, malformed);
    await expect(formulaStatus(page)).toContainText('Could not preview this formula.');
    await expect(pdfStatus(page)).toHaveText(originalPdf);
    await expect(marker).toBeVisible();
    await expect(source(page)).toBeFocused();
    const beforeRelease = await proof();
    expect(beforeRelease).toEqual(pending);

    await selectMath(page, editedFraction);
    await expect(math(page).locator('mfrac mn')).toHaveText(['2', '3']);
    await release();
    await expect(pdfStatus(page)).toContainText('Current', { timeout: 60_000 });
    await expect(page.locator('.pdf-text').getByText('Pending PDF marker.', { exact: true })).toBeVisible();
    const afterRelease = await proof();
    expect(afterRelease).toEqual({ posted: 3, settled: 2, holding: false, heldReplyReceived: true });
    await writeFile(info.outputPath('formula-compiler-gate.json'), JSON.stringify({ beforeRelease, afterRelease }));

    await page.getByText('New project', { exact: true }).press('Enter');
    await page.getByRole('textbox', { name: 'Project name' }).fill('Project without macros');
    await page.getByRole('button', { name: 'Create project' }).press('Enter');
    await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('Project without macros');
    await expect(formulaStatus(page)).toHaveText('Select a math expression in the source.');
    await importFiles(page, { 'notes.bib': projectMacro + '\n' + String.raw`\gdef\PreviewRatio{9}\PreviewRatio` });
    await selectMath(page, projectMacro);
    await expect(formulaStatus(page)).toContainText('\\PreviewRatio is undefined in this preview.');
    await expect(source(page)).toBeFocused();
    await selectMath(page, String.raw`\gdef\PreviewRatio{9}\PreviewRatio`);
    await expect(math(page).locator('mn')).toHaveText('9');
    await selectMath(page, projectMacro);
    await expect(formulaStatus(page)).toContainText('\\PreviewRatio is undefined in this preview.');
    await replaceSelection(page, String.raw`\(\frac{6}{5}\)`);
    await expect(math(page).locator('mfrac mn')).toHaveText(['6', '5']);
    await expect(formula(page).locator('.katex-display')).toHaveCount(0);
    await expect(source(page)).toBeFocused();
  } finally {
    if (!page.isClosed()) {
      const released = await page.evaluate(() => {
        const proof = window.formulaCompileProof;
        if (!proof?.holding) return false;
        proof.release?.();
        return true;
      });
      if (released) await expect(compileStatus(page)).toHaveAttribute('data-state', 'settled', { timeout: 15_000 });
    }
  }
});

test('formula preview and local fonts work after an offline reload', async ({ page, context, staticUrl }) => {
  test.setTimeout(90_000);
  const untrusted = String.raw`\includegraphics{https://example.invalid/preview.png}`;
  await page.goto(staticUrl);
  await importFiles(page, { 'notes.bib': fraction + '\n' + untrusted });
  await page.getByRole('button', { name: 'Save now' }).click();
  await expect(page.locator('#project-save-status')).toHaveText('Saved on this device.');
  await expect(page.locator('#offline-status')).toHaveText('Offline access is ready.', { timeout: 60_000 });
  await context.setOffline(true);
  try {
    await page.reload();
    await expect(source(page)).toHaveValue(fraction + '\n' + untrusted);
    await selectMath(page, fraction);
    await expect(math(page).locator('mfrac')).toHaveCount(1);
    await expect.poll(() => page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].some(font => font.family === 'KaTeX_Main' && font.status === 'loaded');
    })).toBe(true);
    await selectMath(page, untrusted);
    await expect(formulaStatus(page)).toContainText('\\includegraphics is unavailable in formula previews.');
    await expect(formula(page).locator('img')).toHaveCount(0);
    await expect(source(page)).toBeFocused();
  } finally {
    await context.setOffline(false);
  }
});
