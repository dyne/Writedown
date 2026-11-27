import { test, expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import release from '../../compiler-release.json' with { type: 'json' };
import { prepareDependencies } from '../../scripts/prepare-dependencies.ts';
import type { CompilationResult } from '../../src/compiler/contracts.ts';
import { dependencyFiles, dependencyPath } from '../../src/compiler/dependency-catalog.ts';
import type { CompilationState } from '../../src/compiler/service.ts';
import { startDependencyServer } from '../support/dependency-server.ts';
import { startStaticServer } from '../support/static-server.ts';

const run = promisify(execFile);
const dependency = dependencyFiles.find(file => file.name === 'booktabs.sty')!;
const packagePath = dependencyPath(dependency);
const entry = 'StaticPrivate421/main.tex';
const chapter = 'StaticPrivate421/chapters/fixture-topic.tex';
const bibliography = 'StaticPrivate421/fixture-works.bib';
const expression = String.raw`$\frac{7}{11}$`;
const markerLine = 2;
const initialMarker = 'Initial chapter marker.';
const editedMarker = 'Edited chapter marker.';
const repairedMarker = 'Repaired chapter marker.';
const offlineMarker = 'Fresh offline marker.';
const initialTitle = 'Initial Fixture Citation';
const newTitle = 'Updated Fixture Citation';
const fault = String.raw`\StaticFixtureUndefined872`;
const canaries = [entry, chapter, bibliography, initialMarker, editedMarker, repairedMarker, offlineMarker,
  initialTitle, newTitle, fault.slice(1), 'fixture-topic.tex', 'fixture-works.bib', 'StaticPrivate421'];
const mainSource = String.raw`\documentclass{article}
\usepackage{booktabs}
\begin{document}
\input{chapters/fixture-topic.tex}
Citation: \cite{guide}.
\begin{tabular}{l}\toprule Cached package table.\\\bottomrule\end{tabular}
\bibliographystyle{plain}
\bibliography{fixture-works}
\end{document}`;
const chapterSource = (marker: string) => `% Static session chapter\n\\noindent ${marker}\\par\n${expression}\n`;
const bibSource = (title: string) =>
  `@book{guide, author={Quinn, Alex}, title={${title}}, publisher={Fixture Press}, year={2026}}\n`;

const editor = (page: Page) => page.getByRole('textbox', { name: 'Source code' });
const fileChoice = (page: Page) => page.getByRole('combobox', { name: 'File', exact: true });
const compileStatus = (page: Page) => page.locator('#project-compile-status');
const pdfStatus = (page: Page) => page.locator('#pdf-revision');
const pdfPreview = (page: Page) => page.getByRole('region', { name: 'PDF preview' });
const marker = (page: Page, value: string) => pdfPreview(page).locator('.pdf-text').getByText(value, { exact: true });
type Phase = 'online' | 'offline';

declare global {
  interface Window { staticSessionResult?: CompilationResult }
}

async function createFile(page: Page, path: string, contents: string) {
  await page.getByText('New source file', { exact: true }).press('Enter');
  await page.getByRole('textbox', { name: 'File path' }).fill(path);
  await page.getByRole('button', { name: 'Create file', exact: true }).press('Enter');
  await editor(page).fill(contents);
}

async function save(page: Page) {
  await page.getByRole('button', { name: 'Save now' }).click();
  await expect(page.locator('#project-save-status')).toHaveText('Saved on this device.');
}

async function renderEquation(page: Page) {
  await editor(page).focus();
  await editor(page).evaluate((textarea: HTMLTextAreaElement, tex) => {
    const start = textarea.value.indexOf(tex);
    if (start < 0) throw new Error('Expected the fixture equation in the chapter.');
    textarea.setSelectionRange(start, start + tex.length);
  }, expression);
  const fraction = page.getByRole('region', { name: 'Formula preview' }).locator('math mfrac');
  await expect(fraction).toHaveCount(1);
  await expect(fraction.locator('mn')).toHaveText(['7', '11']);
}

async function revision(page: Page) {
  const value = Number(await compileStatus(page).getAttribute('data-revision'));
  expect(value).toBeGreaterThan(0);
  return value;
}

async function assertCurrent(page: Page, value: string) {
  const rev = await revision(page);
  await expect(compileStatus(page)).toHaveText(`Revision ${rev} compiled.`, { timeout: 60_000 });
  await expect(pdfStatus(page)).toHaveText(`PDF revision ${rev} · Current`, { timeout: 30_000 });
  await expect(marker(page, value)).toBeVisible();
  return rev;
}

async function saveProof(page: Page, info: TestInfo, phase: string, rev: number, value: string, previous: string) {
  const { attempt, pdf, synctex, tools } = await page.evaluate(async () => {
    const result = window.staticSessionResult;
    if (result?.status !== 'success' || !result.syncTex?.size) throw new Error('Expected the compiled PDF and SyncTeX.');
    return {
      attempt: result.attempt,
      pdf: [...new Uint8Array(await result.pdf.arrayBuffer())],
      synctex: [...new Uint8Array(await result.syncTex.arrayBuffer())],
      tools: result.passLogs.map(pass => ({ name: pass.tool.split(' ')[0], exitCode: pass.exitCode })),
    };
  });
  expect(attempt.revision).toBe(rev);
  expect(tools).toContainEqual({ name: 'bibtex8', exitCode: 0 });
  const pdfPath = info.outputPath(phase + '.pdf');
  await writeFile(pdfPath, Buffer.from(pdf));
  await writeFile(info.outputPath(phase + '.synctex.gz'), Buffer.from(synctex));
  const { stdout } = await run('pdftotext', [pdfPath, '-']);
  const text = stdout.replace(/\s+/g, ' ');
  expect(text).toContain(value);
  expect(text).not.toContain(previous);
  expect(text).toContain('Citation: [1].');
  expect(text).toContain(newTitle);
  expect(text).not.toContain(initialTitle);
  expect(text).toContain('Cached package table.');
  await writeFile(info.outputPath(phase + '.txt'), stdout);
  return { attempt, tools };
}

async function assertOfflineReady(page: Page, site: string) {
  await expect(page.locator('#offline-status')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  const key = new URL(`compiler/${release.id}/verified-dependencies/${packagePath}`, site).href;
  const cacheState = await page.evaluate(async ({ releaseId, key }) => {
    const response = await (await caches.open('writedown-tex-dependencies:' + releaseId)).match(key);
    const digest = response && await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
    return {
      controller: navigator.serviceWorker.controller?.scriptURL,
      dependencySha256: digest
        ? Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
        : null,
    };
  }, { releaseId: release.id, key });
  expect(cacheState).toEqual({
    controller: new URL('service-worker.js', site).href,
    dependencySha256: dependency.sha256,
  });
  return cacheState;
}

function assertPrivate(record: unknown) {
  const wire = JSON.stringify(record).toLowerCase();
  for (const value of canaries) {
    expect(wire).not.toContain(value.toLowerCase());
    expect(wire).not.toContain(encodeURIComponent(value).toLowerCase());
  }
}

let dependencyBytes: Buffer;
test.beforeAll(async ({}, info) => {
  const staging = join(info.project.outputDir, 'static-session-dependency-fixture');
  await prepareDependencies(staging);
  dependencyBytes = await readFile(join(staging, packagePath));
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  for (const scale of [100, 200]) {
    test(`static-session ${viewport.width}x${viewport.height} text-${scale}`, async ({ page, context }, info) => {
      test.setTimeout(150_000);
      const scratch = await mkdtemp(info.outputPath('production-'));
      const packages = await startDependencyServer(packagePath, dependencyBytes);
      const approvedUrl = new URL(packagePath, packages.url).href;
      let site: Awaited<ReturnType<typeof startStaticServer>> | undefined;
      let stopped: Promise<void[]> | undefined;
      const stop = () => stopped ??= Promise.all([site?.close() ?? Promise.resolve(), packages.close()]);
      let phase: Phase = 'online';
      const workers: { phase: Phase; url: string }[] = [];
      const browserRequests: { phase: Phase; method: string; url: string; body: string | null; worker: boolean }[] = [];
      const rejected: string[] = [];
      const pageErrors: string[] = [];
      page.on('worker', worker => workers.push({ phase, url: worker.url() }));
      page.on('pageerror', error => pageErrors.push(error.message));
      context.on('request', request => browserRequests.push({
        phase, method: request.method(), url: request.url(), body: request.postData(), worker: !!request.serviceWorker(),
      }));
      try {
        const dist = join(scratch, 'dist');
        const build = await run('npm', ['run', 'build', '--', '--outDir', dist], {
          // An earlier Vite dev-server fixture can set NODE_ENV in this worker.
          env: { ...process.env, NODE_ENV: 'production', VITE_TEX_DEPENDENCY_ENDPOINT: packages.url },
        });
        await writeFile(info.outputPath('production-build.log'), build.stdout + build.stderr);
        site = await startStaticServer(dist);
        const { url } = site;
        const staticFiles = new Set(['/writedown/']);
        for (const file of await readdir(dist, { recursive: true, withFileTypes: true })) {
          if (file.isFile()) staticFiles.add('/writedown/' + relative(dist, join(file.parentPath, file.name)));
        }
        const allowed = (requestUrl: string) => {
          const target = new URL(requestUrl);
          return requestUrl === approvedUrl
            || (target.origin === new URL(url).origin && !target.search && staticFiles.has(target.pathname));
        };
        await context.route(/^https?:/, route => {
          const attempted = route.request();
          if (attempted.method() === 'GET' && allowed(attempted.url()) && !attempted.postData()) return route.continue();
          rejected.push(attempted.url());
          return route.abort();
        });
        await page.setViewportSize(viewport);
        await page.addInitScript(textScale => {
          document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = textScale + '%'; });
          window.addEventListener('writedown:compilation-state', event => {
            const state = (event as CustomEvent<CompilationState>).detail;
            if (state.status === 'settled') window.staticSessionResult = state.result;
          });
        }, scale);
        await page.goto(url);
        await createFile(page, entry, mainSource);
        await createFile(page, chapter, chapterSource(initialMarker));
        await createFile(page, bibliography, bibSource(initialTitle));
        await page.getByRole('combobox', { name: 'Bibliography', exact: true }).selectOption('bibtex');
        const original = await assertCurrent(page, initialMarker);

        await editor(page).fill(bibSource(newTitle));
        await fileChoice(page).selectOption(chapter);
        await editor(page).fill(chapterSource(editedMarker));
        await renderEquation(page);
        const edited = await assertCurrent(page, editedMarker);
        expect(edited).toBeGreaterThan(original);
        await saveProof(page, info, 'cited', edited, editedMarker, initialMarker);

        await fileChoice(page).selectOption(entry);
        const target = marker(page, editedMarker);
        await target.scrollIntoViewIfNeeded();
        const box = (await target.boundingBox())!;
        await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
        await expect(fileChoice(page)).toHaveValue(chapter);
        await expect(editor(page)).toBeFocused();
        await expect(page.getByRole('spinbutton', { name: 'Line', exact: true })).toHaveValue(String(markerLine));

        await editor(page).fill(chapterSource(editedMarker).replace(editedMarker, fault));
        const failed = await revision(page);
        await expect(compileStatus(page)).toHaveText(`Revision ${failed} failed.`, { timeout: 60_000 });
        await expect(pdfStatus(page)).toHaveText(`PDF revision ${edited} · Stale`);
        await expect(marker(page, editedMarker)).toBeVisible();
        const diagnostic = pdfPreview(page).getByRole('button', { name: `Open ${chapter}, line ${markerLine}` });
        await expect(diagnostic).toBeVisible();
        await expect(pdfPreview(page).getByRole('list', { name: 'Compilation diagnostics' })).toContainText('Undefined control sequence.');

        await editor(page).fill(chapterSource(repairedMarker));
        const repaired = await assertCurrent(page, repairedMarker);
        expect(repaired).toBeGreaterThan(failed);
        await expect(diagnostic).toHaveCount(0);
        await save(page);
        await renderEquation(page);
        const repairedProof = await saveProof(page, info, 'static-session', repaired, repairedMarker, editedMarker);
        const cache = await assertOfflineReady(page, url);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
        await page.screenshot({ path: info.outputPath('static-session.png'), fullPage: true });

        const expectedCompilerWorker = new URL(`compiler/${release.id}/busytex_worker.js`, url).href;
        const pdfWorker = /\/assets\/pdf\.worker\.min-[^/]+\.mjs$/;
        expect(workers.filter(worker => worker.phase === 'online' && worker.url === expectedCompilerWorker)).toHaveLength(1);
        expect(workers.some(worker => worker.phase === 'online' && pdfWorker.test(worker.url))).toBe(true);
        expect(site.requests.map(row => row.path)).toEqual(expect.arrayContaining([
          '/writedown/', '/writedown/service-worker.js',
          `/writedown/compiler/${release.id}/texlive-basic.data`,
          `/writedown/compiler/${release.id}/busytex.wasm`,
          expect.stringMatching(pdfWorker),
        ]));
        expect(packages.requests).toMatchObject([{ method: 'GET', path: packages.path, status: 200, bodyBytes: 0 }]);
        for (const row of packages.requests) {
          expect(row.headers.authorization).toBeUndefined();
          expect(row.headers.cookie).toBeUndefined();
          expect(row.headers.referer).toBeUndefined();
        }
        const onlineCounts = { static: site.requests.length, dependency: packages.requests.length };
        await stop();
        for (const endpoint of [url, approvedUrl]) {
          await expect(fetch(endpoint, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
        }
        phase = 'offline';
        await context.setOffline(true);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await assertOfflineReady(page, url);
        await fileChoice(page).selectOption(chapter);
        await expect(editor(page)).toHaveValue(chapterSource(repairedMarker));
        await assertCurrent(page, repairedMarker);
        await editor(page).fill(chapterSource(offlineMarker));
        await save(page);
        const offline = await assertCurrent(page, offlineMarker);
        expect(offline).toBeGreaterThan(repaired);
        const offlineProof = await saveProof(page, info, 'offline-fresh', offline, offlineMarker, repairedMarker);
        expect(offlineProof.attempt.projectId).toBe(repairedProof.attempt.projectId);
        expect(workers.filter(worker => worker.phase === 'offline' && worker.url === expectedCompilerWorker)).toHaveLength(1);
        expect(workers.some(worker => worker.phase === 'offline' && pdfWorker.test(worker.url))).toBe(true);
        expect({ static: site.requests.length, dependency: packages.requests.length }).toEqual(onlineCounts);

        expect(rejected).toEqual([]);
        expect(pageErrors).toEqual([]);
        for (const row of site.requests) {
          expect(staticFiles.has(row.path)).toBe(true);
          expect(row).toMatchObject({ method: 'GET', bodyBytes: 0, status: 200 });
          assertPrivate(row);
        }
        for (const row of packages.requests) assertPrivate(row);
        for (const row of browserRequests) {
          expect(allowed(row.url)).toBe(true);
          expect(row).toMatchObject({ method: 'GET', body: null });
          assertPrivate(row);
        }
        await writeFile(info.outputPath('static-session-revisions.json'), JSON.stringify({
          viewport, textScale: scale, original, edited, jump: { file: chapter, line: markerLine },
          failed, repaired, offline, repairedProof, offlineProof, cache, onlineCounts,
          serversStopped: true,
        }, null, 2));
      } finally {
        await stop();
        await writeFile(info.outputPath('static-session-traffic.json'), JSON.stringify({
          static: site?.requests ?? [], dependencies: packages.requests, browserRequests, workers, rejected, pageErrors,
        }, null, 2));
        await rm(scratch, { recursive: true, force: true });
      }
    });
  }
}
