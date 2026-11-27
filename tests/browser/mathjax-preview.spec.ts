import { test, expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startStaticServer } from '../support/static-server.ts';
import type { StaticServerOptions } from '../support/static-server.ts';
import { mathJaxEntry, mathJaxPath, mathJaxScripts } from '../../src/formula/mathjax-assets.ts';

const renderer = (page: Page) => page.getByRole('combobox', { name: 'Formula renderer' });
const source = (page: Page) => page.getByRole('textbox', { name: 'Source code' });
const formula = (page: Page) => page.getByRole('region', { name: 'Formula preview' });
const output = (page: Page) => formula(page).locator('.formula-result');
const status = (page: Page) => formula(page).getByRole('status');
const svg = (page: Page) => output(page).locator('svg');
const ready = (page: Page) => page.locator('#offline-status');
const fraction = String.raw`\[\frac{1}{3}\]`;

async function importFiles(page: Page, files: Record<string, string>) {
  await expect(page.getByRole('button', { name: 'Import files' })).toBeEnabled();
  await page.locator('#file-input').setInputFiles(Object.entries(files).map(([name, text]) => ({
    name, mimeType: 'text/plain', buffer: Buffer.from(text),
  })));
  await expect(source(page)).toHaveValue(Object.values(files)[0]);
}

async function selectFormula(page: Page, expression: string) {
  await source(page).focus();
  await source(page).evaluate((input: HTMLTextAreaElement, tex) => {
    const start = input.value.indexOf(tex);
    if (start < 0) throw new Error('Missing fixture expression.');
    input.setSelectionRange(start, start + tex.length);
  }, expression);
}

async function trafficLab(page: Page, info: TestInfo, options?: StaticServerOptions) {
  const server = await startStaticServer(resolve('dist'), options);
  const workers: string[] = [];
  const browserRequests: { url: string; serviceWorker: string | null; phase: string }[] = [];
  let phase = 'install';
  page.on('worker', worker => workers.push(worker.url()));
  page.context().on('request', request => {
    browserRequests.push({ url: request.url(), serviceWorker: request.serviceWorker()?.url() ?? null, phase });
  });
  const isMathJax = (path: string) => path.includes('/' + mathJaxPath);
  return {
    url: server.url,
    phase(name: string) { phase = name; },
    mathJaxRequests: () => server.requests.filter(request => isMathJax(request.path)),
    browserMathJaxRequests: () => browserRequests.filter(request => isMathJax(request.url)),
    async close() {
      await server.close();
      await writeFile(info.outputPath('mathjax-requests.json'), JSON.stringify({ workers, browserRequests, requests: server.requests }));
      expect(browserRequests.every(request => request.url.startsWith(server.url))).toBe(true);
    },
  };
}

async function expectSvgFraction(page: Page, digits: string[]) {
  await expect(svg(page)).toBeVisible();
  await expect(svg(page)).toHaveAttribute('viewBox', /.+/);
  const values = svg(page).locator('g[data-mml-node="mn"] path[data-c]');
  await expect.poll(() => values.evaluateAll(paths => paths.map(path => path.getAttribute('data-c')))).toEqual(
    digits.map(value => value.charCodeAt(0).toString(16).toUpperCase()),
  );
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  for (const scale of [100, 200]) {
    test(`formula SVG ${viewport.width}x${viewport.height} text-${scale}`, async ({ page }, info) => {
      const lab = await trafficLab(page, info);
      try {
        await page.setViewportSize(viewport);
        await page.addInitScript(value => {
          document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = `${value}%`; });
        }, scale);
        await page.goto(lab.url);
        await importFiles(page, { 'notes.bib': fraction });
        await renderer(page).selectOption('svg');
        await selectFormula(page, fraction);
        await expectSvgFraction(page, ['1', '3']);
        await expect(output(page).getByRole('img', { name: String.raw`\frac{1}{3}` })).toBeVisible();
        await expect(source(page)).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
        await page.screenshot({ path: info.outputPath('formula-svg.png'), fullPage: true });
        await expect(source(page)).toBeFocused();
      } finally {
        await lab.close();
      }
    });
  }
}

async function cachedMathJax(page: Page) {
  return await page.evaluate(async prefix => {
    const names = (await caches.keys()).filter(name => name.startsWith('writedown-runtime:'));
    if (names.length !== 1) throw new Error('Expected one active release runtime cache.');
    const cache = await caches.open(names[0]);
    return (await cache.keys()).map(request => new URL(request.url).pathname)
      .filter(path => path.includes('/' + prefix)).sort();
  }, mathJaxPath);
}

const undefinedMacro = String.raw`\ProjectRatio{2}`;

test('fresh install, KaTeX and compilation fetch no MathJax, then only warmed SVG works offline', async ({ page, context }, info) => {
  test.setTimeout(120_000);
  const lab = await trafficLab(page, info);
  const base = new URL(lab.url).pathname;
  const expected = Object.keys(mathJaxScripts).map(path => base + mathJaxPath + path).sort();
  try {
    await page.goto(lab.url);
    await expect(ready(page)).toHaveText('Offline access is ready.', { timeout: 30_000 });
    expect(lab.mathJaxRequests()).toEqual([]);
    expect(lab.browserMathJaxRequests()).toEqual([]);
    expect(await cachedMathJax(page)).toEqual([]);

    lab.phase('default-katex');
    const requiresExtension = String.raw`\require{html}`;
    const notes = [fraction, undefinedMacro, requiresExtension].join('\n');
    await importFiles(page, { 'notes.bib': notes });
    await selectFormula(page, fraction);
    await expect(renderer(page)).toHaveValue('katex');
    await expect(output(page).locator('math mfrac')).toHaveCount(1);
    expect(lab.browserMathJaxRequests()).toEqual([]);

    lab.phase('default-compiler');
    const tex = String.raw`\documentclass{article}\begin{document}SVG isolation marker.\end{document}`;
    await page.locator('#file-input').setInputFiles([
      { name: 'main.tex', mimeType: 'text/plain', buffer: Buffer.from(tex) },
      { name: 'formula-macros.tex', mimeType: 'text/plain', buffer: Buffer.from(String.raw`\newcommand{\ProjectRatio}[1]{\frac{#1}{5}}`) },
    ]);
    await expect(page.locator('#project-compile-status')).toContainText('compiled.', { timeout: 60_000 });
    await expect(page.locator('.pdf-text').getByText('SVG isolation marker.', { exact: true })).toBeVisible();
    expect(lab.mathJaxRequests()).toEqual([]);
    expect(lab.browserMathJaxRequests()).toEqual([]);
    expect(await cachedMathJax(page)).toEqual([]);

    lab.phase('cold-offline');
    await context.setOffline(true);
    await renderer(page).selectOption('svg');
    await selectFormula(page, fraction);
    await expect(status(page)).toContainText('SVG renderer unavailable. Go online to load it, or choose KaTeX.');
    await expect(ready(page)).toHaveText('Offline access is ready.');
    expect(await cachedMathJax(page)).toEqual([]);
    expect(lab.mathJaxRequests()).toEqual([]);
    await renderer(page).selectOption('katex');
    await expect(output(page).locator('math mfrac')).toHaveCount(1);

    lab.phase('warm-online');
    await context.setOffline(false);
    await renderer(page).selectOption('svg');
    await expectSvgFraction(page, ['1', '3']);
    await selectFormula(page, undefinedMacro);
    await expectSvgFraction(page, ['2', '5']);
    await selectFormula(page, requiresExtension);
    await expect(status(page)).toContainText('Undefined control sequence');
    const mathJaxNetwork = lab.mathJaxRequests();
    expect(mathJaxNetwork.map(row => row.path).sort()).toEqual(expected);
    expect(mathJaxNetwork.every(row => row.status === 200 && row.method === 'GET' && row.bodyBytes === 0)).toBe(true);
    expect(lab.browserMathJaxRequests().filter(row => row.phase === 'warm-online' && row.serviceWorker)
      .map(row => new URL(row.url).pathname).sort()).toEqual(expected);
    expect(await cachedMathJax(page)).toEqual(expected);

    lab.phase('warm-offline');
    await context.setOffline(true);
    await page.reload();
    await expect(ready(page)).toHaveText('Offline access is ready.');
    await expect(renderer(page)).toHaveValue('katex');
    await page.getByRole('combobox', { name: 'File', exact: true }).selectOption('notes.bib');
    await expect(source(page)).toHaveValue(notes);
    await renderer(page).selectOption('svg');
    await selectFormula(page, undefinedMacro);
    await expectSvgFraction(page, ['2', '5']);
    await expect(source(page)).toBeFocused();
    expect(lab.mathJaxRequests()).toEqual(mathJaxNetwork);
    expect(await cachedMathJax(page)).toEqual(expected);
    await writeFile(info.outputPath('mathjax-cache.json'), JSON.stringify({ installed: [], cold: [], warmed: expected }));
  } finally {
    await context.setOffline(false);
    await lab.close();
  }
});

test('a corrupted optional response never enters the verified cache and can be retried', async ({ page }, info) => {
  const entry = mathJaxPath + mathJaxEntry;
  const damaged = await readFile(join('dist', entry));
  damaged[0] ^= 1;
  let corrupt = true;
  const lab = await trafficLab(page, info, {
    intercept: path => (path === entry && corrupt ? damaged : undefined),
  });
  try {
    await page.goto(lab.url);
    await expect(ready(page)).toHaveText('Offline access is ready.', { timeout: 30_000 });
    await importFiles(page, { 'notes.bib': fraction });
    await selectFormula(page, fraction);
    lab.phase('same-size-corruption');
    const failed = page.waitForResponse(response => response.url() === lab.url + entry && response.status() === 503);
    await renderer(page).selectOption('svg');
    await failed;
    // The browser hides the SRI-protected script's rejected body. Read the
    // same response through the service worker to identify its rejection.
    const receipt = await page.evaluate(async url => {
      const response = await fetch(url);
      return { status: response.status, message: await response.text() };
    }, lab.url + entry);
    expect(receipt.status).toBe(503);
    expect(receipt.message).toContain('Offline asset SHA-256 mismatch');
    await expect(status(page)).toContainText('SVG renderer unavailable.');
    expect(await cachedMathJax(page)).toEqual([]);
    await expect(ready(page)).toHaveText('Offline access is ready.');

    await renderer(page).selectOption('katex');
    await expect(output(page).locator('math mfrac')).toHaveCount(1);
    corrupt = false;
    lab.phase('retry');
    await renderer(page).selectOption('svg');
    await expectSvgFraction(page, ['1', '3']);
    expect(await cachedMathJax(page)).toContain(new URL(entry, lab.url).pathname);
  } finally {
    await lab.close();
  }
});

interface SvgGate {
  hold: string[];
  release: Record<string, () => void>;
  completed: string[];
}

declare global {
  interface Window { svgGate?: SvgGate; }
}

test('a delayed SVG conversion cannot replace a newer expression, renderer or project', async ({ page }, info) => {
  const lab = await trafficLab(page, info);
  const held = [String.raw`\frac{4}{7}`, String.raw`\frac{5}{7}`, String.raw`\frac{8}{7}`];
  const recent = String.raw`\frac{6}{7}`;
  const other = String.raw`\frac{9}{7}`;
  const localDefinition = String.raw`\newcommand{\FragmentOnly}{9}\FragmentOnly`;
  const undefinedCommand = String.raw`\FragmentOnly`;
  async function begin(tex: string) {
    await selectFormula(page, tex);
    await expect.poll(() => page.evaluate(value => !!window.svgGate?.release[value], tex)).toBe(true);
  }
  async function letFinish(tex: string) {
    await page.evaluate(async value => {
      window.svgGate?.release[value]?.();
      await new Promise<void>(done => requestAnimationFrame(() => done()));
    }, tex);
    await expect.poll(() => page.evaluate(value => window.svgGate?.completed.includes(value), tex)).toBe(true);
  }
  try {
    await page.goto(lab.url);
    await importFiles(page, { 'notes.bib': [fraction, ...held, recent, undefinedCommand, localDefinition].join('\n') });
    await renderer(page).selectOption('svg');
    await selectFormula(page, fraction);
    await expectSvgFraction(page, ['1', '3']);

    await page.evaluate(hold => {
      const host = window as Window & { MathJax?: { startup: { mathjax: {
        document: (...args: unknown[]) => { convertPromise: (tex: string, options: unknown) => Promise<Node> };
      } } } };
      const gate: SvgGate = { hold, release: {}, completed: [] };
      host.svgGate = gate;
      const mathjax = host.MathJax?.startup.mathjax;
      if (!mathjax) throw new Error('MathJax must be ready before installing the conversion gate.');
      const create = mathjax.document;
      mathjax.document = function (...args) {
        const document = create.apply(this, args);
        const convert = document.convertPromise;
        document.convertPromise = async function (tex, options) {
          const rendered = await convert.call(this, tex, options);
          const pending = gate.hold.indexOf(tex);
          if (pending !== -1) {
            gate.hold.splice(pending, 1);
            await new Promise<void>(finish => { gate.release[tex] = finish; });
            delete gate.release[tex];
            gate.completed.push(tex);
          }
          return rendered;
        };
        return document;
      };
    }, held);

    await begin(held[0]);
    await selectFormula(page, recent);
    await expectSvgFraction(page, ['6', '7']);
    await letFinish(held[0]);
    await expectSvgFraction(page, ['6', '7']);

    await begin(held[1]);
    await renderer(page).selectOption('katex');
    await expect(output(page).locator('math mfrac mn')).toHaveText(['5', '7']);
    await letFinish(held[1]);
    await expect(svg(page)).toHaveCount(0);
    await expect(output(page).locator('math mfrac mn')).toHaveText(['5', '7']);

    await renderer(page).selectOption('svg');
    await selectFormula(page, localDefinition);
    await expectSvgFraction(page, ['9']);
    await selectFormula(page, undefinedCommand);
    await expect(status(page)).toContainText('Undefined control sequence');
    await begin(held[2]);
    await page.getByText('New project', { exact: true }).press('Enter');
    await page.getByRole('textbox', { name: 'Project name' }).fill('Other formulas');
    await page.getByRole('button', { name: 'Create project' }).press('Enter');
    await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('Other formulas');
    await importFiles(page, { 'other.bib': other });
    await selectFormula(page, other);
    await expectSvgFraction(page, ['9', '7']);
    await letFinish(held[2]);
    await expectSvgFraction(page, ['9', '7']);
    await expect(source(page)).toBeFocused();
    const settled = await page.evaluate(() => ({
      completed: window.svgGate?.completed,
      remaining: Object.keys(window.svgGate?.release ?? {}),
    }));
    expect(settled).toEqual({ completed: held, remaining: [] });
    await writeFile(info.outputPath('mathjax-gates.json'), JSON.stringify(settled));
  } finally {
    try {
      if (!page.isClosed()) {
        await page.evaluate(async () => {
          for (const finish of Object.values(window.svgGate?.release ?? {})) finish();
          await new Promise<void>(done => requestAnimationFrame(() => done()));
          if (Object.keys(window.svgGate?.release ?? {}).length) throw new Error('An SVG conversion is still held.');
        });
      }
    } finally {
      await lab.close();
    }
  }
});
