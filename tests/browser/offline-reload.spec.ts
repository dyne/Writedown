import { test as base, expect } from '@playwright/test';
import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import release from '../../compiler-release.json' with { type: 'json' };
import catalog from '../../compiler-dependencies.json' with { type: 'json' };
import { prepareDependencies } from '../../scripts/prepare-dependencies.ts';
import type { CompilationResult } from '../../src/compiler/contracts.ts';
import { dependencyFiles, dependencyPath } from '../../src/compiler/dependency-catalog.ts';
import type { CompilationState } from '../../src/compiler/service.ts';
import type { ProjectSnapshot } from '../../src/project/snapshot.ts';
import { startDependencyServer } from '../support/dependency-server.ts';
import { startStaticServer } from '../support/static-server.ts';
import type { StaticServerOptions } from '../support/static-server.ts';

declare global {
  interface Window {
    offlineProof: {
      snapshot?: ProjectSnapshot;
      settled?: CompilationResult;
      deletedWrapperCache: number;
      rejectDependencyWrite: boolean;
    };
  }
}

const run = promisify(execFile);
const repository = resolve('.');
const dependency = dependencyFiles.find(file => file.name === 'booktabs.sty')!;
const upgradeRelease = 'busytex-1.4.1-upgrade-fixture';
const entry = 'PrivateOfflineEntry57413.tex';
const document = (marker: string) => String.raw`\documentclass{article}
\usepackage{booktabs}
\begin{document}
\begin{tabular}{l}\toprule ${marker}\\\bottomrule\end{tabular}
\end{document}`;
let verifiedBytes: Buffer;

async function createLab(info: TestInfo) {
  const scratch = await mkdtemp(info.outputPath('release-builds-'));
  let staticPort: number | undefined;
  let packagePort: number | undefined;
  let staticServer: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  let packageServer: Awaited<ReturnType<typeof startDependencyServer>> | undefined;
  const staticHistory: NonNullable<typeof staticServer>[] = [];
  const packageHistory: NonNullable<typeof packageServer>[] = [];
  const pages: { phase: string; workers: string[] }[] = [];

  async function stopStatic() {
    const closing = staticServer;
    staticServer = undefined;
    await closing?.close();
  }

  async function stopPackages() {
    const closing = packageServer;
    packageServer = undefined;
    await closing?.close();
  }

  return {
    async build(endpoint: string, id = release.id) {
      let cwd = repository;
      if (id !== release.id) {
        cwd = join(scratch, id + '-source');
        await mkdir(cwd);
        for (const file of ['index.html', 'package.json', 'vite.config.ts', 'tsconfig.json', 'src', 'scripts']) {
          await cp(join(repository, file), join(cwd, file), { recursive: true });
        }
        await writeFile(join(cwd, 'compiler-release.json'), JSON.stringify({ ...release, id }));
        await writeFile(join(cwd, 'compiler-dependencies.json'), JSON.stringify({ ...catalog, releaseId: id }));
        await symlink(join(repository, 'node_modules'), join(cwd, 'node_modules'), 'dir');
        await mkdir(join(cwd, 'public/compiler'), { recursive: true });
        await symlink(join(repository, 'public/compiler', release.id), join(cwd, 'public/compiler', id), 'dir');
      }
      const output = join(scratch, id);
      const build = await run('npm', ['run', 'build', '--', '--outDir', output], {
        cwd, env: { ...process.env, VITE_TEX_DEPENDENCY_ENDPOINT: endpoint },
      });
      await writeFile(info.outputPath(`build-${id}.log`), build.stdout + build.stderr);
      await writeFile(info.outputPath(`service-worker-${id}.js`), await readFile(join(output, 'service-worker.js')));
      return output;
    },
    async serveStatic(root: string, intercept?: StaticServerOptions['intercept']) {
      if (staticServer) throw new Error('Stop the active static fixture first.');
      staticServer = await startStaticServer(root, { port: staticPort, intercept });
      staticPort = Number(new URL(staticServer.url).port);
      staticHistory.push(staticServer);
      return staticServer;
    },
    async servePackages(id = release.id) {
      if (packageServer) throw new Error('Stop the active package fixture first.');
      packageServer = await startDependencyServer(
        `${id}/${dependency.sha256}/${dependency.name}`, verifiedBytes, packagePort,
      );
      packagePort = Number(new URL(packageServer.url).port);
      packageHistory.push(packageServer);
      return packageServer;
    },
    async open(context: BrowserContext, phase: string, url: string) {
      const page = await context.newPage();
      const workers: string[] = [];
      pages.push({ phase, workers });
      page.on('worker', worker => workers.push(worker.url()));
      await page.goto(url);
      return { page, workers };
    },
    async assertPrivate(markers: string[]) {
      // Inspect both real fixture servers, including their service-worker and
      // dedicated-worker traffic.
      for (const endpoint of packageHistory) {
        expect(endpoint.requests.every(row => row.path === endpoint.path && row.status === 200)).toBe(true);
      }
      for (const server of [...staticHistory, ...packageHistory]) {
        for (const row of server.requests) {
          expect(row.method).toBe('GET');
          expect(row.bodyBytes).toBe(0);
          for (const marker of [entry, ...markers]) {
            expect(JSON.stringify(row).toLowerCase()).not.toContain(marker.toLowerCase());
          }
        }
      }
    },
    stopStatic,
    stopPackages,
    async dispose() {
      await Promise.all([stopStatic(), stopPackages()]);
      await writeFile(info.outputPath('network-and-workers.json'), JSON.stringify({
        pages, static: staticHistory.map(server => ({ url: server.url, requests: server.requests })),
        packages: packageHistory.map(server => ({ url: server.url, requests: server.requests })),
      }, null, 2));
      await rm(scratch, { recursive: true, force: true });
    },
  };
}

const test = base.extend<{ lab: Awaited<ReturnType<typeof createLab>> }>({
  lab: async ({ context }, use, info) => {
    await context.addInitScript(() => {
      const proof: Window['offlineProof'] = { deletedWrapperCache: 0, rejectDependencyWrite: false };
      window.offlineProof = proof;
      window.addEventListener('writedown:snapshot', event => {
        proof.snapshot = (event as CustomEvent<ProjectSnapshot>).detail;
      });
      window.addEventListener('writedown:compilation-state', event => {
        const state = (event as CustomEvent<CompilationState>).detail;
        if (state.status === 'settled') proof.settled = state.result;
      });
      const deleteDatabase = IDBFactory.prototype.deleteDatabase;
      IDBFactory.prototype.deleteDatabase = function (name) {
        if (name === 'EM_PRELOAD_CACHE') proof.deletedWrapperCache++;
        return deleteDatabase.call(this, name);
      };
      const put = Cache.prototype.put;
      Cache.prototype.put = function (request, response) {
        const url = request instanceof Request ? request.url : String(request);
        if (proof.rejectDependencyWrite && url.endsWith('/booktabs.sty')) {
          return Promise.reject(new DOMException('Fixture quota failure', 'QuotaExceededError'));
        }
        return put.call(this, request, response);
      };
    });
    const lab = await createLab(info);
    try {
      await use(lab);
    } finally {
      await lab.dispose();
    }
  },
});

test.beforeAll(async ({}, info) => {
  const directory = join(info.project.outputDir, 'offline-dependency-fixture');
  await prepareDependencies(directory);
  verifiedBytes = await readFile(join(directory, dependencyPath(dependency)));
});

async function createSource(page: Page, marker: string) {
  await page.getByText('New source file', { exact: true }).press('Enter');
  await page.getByRole('textbox', { name: 'File path' }).fill(entry);
  await page.getByRole('button', { name: 'Create file', exact: true }).press('Enter');
  await editSource(page, marker);
}

async function editSource(page: Page, marker: string) {
  await page.getByRole('textbox', { name: 'Source code' }).fill(document(marker));
  await page.getByRole('button', { name: 'Save now' }).click();
  await expect(page.locator('#project-save-status')).toHaveText('Saved on this device.');
}

async function proofPdf(page: Page, info: TestInfo, name: string, latest: string, previous?: string) {
  const revision = await page.evaluate(() => window.offlineProof.snapshot?.revision);
  expect(revision).toBeGreaterThan(0);
  await expect(page.locator('#project-compile-status')).toContainText(`Revision ${revision} compiled.`, { timeout: 45_000 });
  const result = await page.evaluate(async () => {
    const result = window.offlineProof.settled;
    if (result?.status !== 'success') throw new Error('Expected the PDF for the current project revision.');
    const { pdf, syncTex, ...metadata } = result;
    return { ...metadata, pdf: [...new Uint8Array(await pdf.arrayBuffer())] };
  });
  const { pdf, ...receipt } = result;
  expect(receipt.attempt.revision).toBe(revision);
  const pdfPath = info.outputPath(name + '.pdf');
  await writeFile(pdfPath, Buffer.from(pdf));
  const { stdout } = await run('pdftotext', [pdfPath, '-']);
  expect(stdout).toContain(latest);
  if (previous) expect(stdout).not.toContain(previous);
  await writeFile(info.outputPath(name + '.txt'), stdout);
  await writeFile(info.outputPath(name + '-result.json'), JSON.stringify(receipt, null, 2));
  return receipt;
}

async function cacheState(page: Page) {
  return page.evaluate(async () => ({
    controller: navigator.serviceWorker.controller?.scriptURL ?? null,
    caches: await Promise.all((await caches.keys()).map(async name => ({
      name, paths: (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname).sort(),
    }))),
  }));
}

async function waitForOffline(page: Page, url: string, id = release.id) {
  await expect(page.locator('#offline-status')).toHaveAttribute('data-state', 'ready', { timeout: 45_000 });
  const state = await cacheState(page);
  expect(state.controller).toBe(new URL('service-worker.js', url).href);
  const runtime = state.caches.find(cache => cache.name.startsWith('writedown-runtime:') && cache.name.includes(`:${id}:`));
  expect(runtime?.paths.some(path => path.startsWith('/writedown/__writedown-ready/'))).toBe(true);
  expect(runtime?.paths).toContain('/writedown/index.html');
  expect(runtime?.paths).toContain(`/writedown/compiler/${id}/texlive-basic.data`);
  return state;
}

async function wrapperCacheFiles(page: Page) {
  return page.evaluate(async () => {
    if (!(await indexedDB.databases()).some(db => db.name === 'EM_PRELOAD_CACHE')) return [];
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('EM_PRELOAD_CACHE');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!database.objectStoreNames.contains('METADATA')) return [];
      return await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = database.transaction('METADATA').objectStore('METADATA').getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
}

test('offline reload compiles an edited cached dependency in a fresh worker and recovers a cold miss', async ({ context, lab }, info) => {
  test.setTimeout(150_000);
  const before = 'PrivateWarmMarker63951';
  const after = 'PrivateOfflineEdit87129';
  const cold = 'PrivateColdEdit36515';
  const packages = await lab.servePackages();
  const build = await lab.build(packages.url);
  const staticServer = await lab.serveStatic(build);
  const { url } = staticServer;
  const online = await lab.open(context, 'warm', url);
  await waitForOffline(online.page, url);
  await createSource(online.page, before);
  await proofPdf(online.page, info, 'warm', before);
  const warm = await cacheState(online.page);
  expect(warm.caches.find(cache => cache.name.startsWith('writedown-tex-dependencies:'))?.paths.some(path => path.endsWith('/booktabs.sty'))).toBe(true);
  expect(packages.requests).toHaveLength(1);
  await expect.poll(() => wrapperCacheFiles(online.page)).toEqual([expect.stringMatching(/\/texlive-basic\.data$/)]);
  await online.page.evaluate(() => { localStorage.setItem('texlyre-busytex-version', 'fixture-obsolete-version'); });
  await online.page.close();
  await Promise.all([lab.stopStatic(), lab.stopPackages()]);
  await expect(fetch(url)).rejects.toThrow();
  await expect(fetch(new URL(dependencyPath(dependency), packages.url))).rejects.toThrow();
  await context.setOffline(true);

  const offline = await lab.open(context, 'offline re-open', url);
  await waitForOffline(offline.page, url);
  await expect(offline.page.getByRole('textbox', { name: 'Source code' })).toHaveValue(document(before));
  await editSource(offline.page, after);
  await proofPdf(offline.page, info, 'edited-offline', after, before);
  expect(offline.workers).toEqual([new URL(`compiler/${release.id}/busytex_worker.js`, url).href]);
  expect(await offline.page.evaluate(() => window.offlineProof.deletedWrapperCache)).toBe(1);
  await expect.poll(() => wrapperCacheFiles(offline.page)).toEqual([expect.stringMatching(/\/texlive-basic\.data$/)]);
  await writeFile(info.outputPath('verified-cache-inventory.json'), JSON.stringify({ warm, rebuilt: await cacheState(offline.page) }, null, 2));
  // Lose only the dependency bytes, as on a cold or evicted dependency cache.
  await offline.page.evaluate(name => caches.delete(name), `writedown-tex-dependencies:${release.id}`);
  await offline.page.close();
  const missing = await lab.open(context, 'offline cold miss', url);
  await expect(missing.page.getByRole('textbox', { name: 'Source code' })).toHaveValue(document(after));
  await editSource(missing.page, cold);
  await expect(missing.page.locator('#project-compile-status')).toContainText('Could not fetch TeX dependency booktabs.sty.', { timeout: 45_000 });
  expect(packages.requests).toHaveLength(1);

  expect((await lab.serveStatic(build)).url).toBe(url);
  const restoredPackages = await lab.servePackages();
  expect(restoredPackages.url).toBe(packages.url);
  await context.setOffline(false);
  await missing.page.getByRole('button', { name: 'Retry compilation' }).click();
  await proofPdf(missing.page, info, 'cold-recovered', cold, after);
  expect(restoredPackages.requests).toHaveLength(1);
  await lab.assertPrivate([before, after, cold]);
});

test('an interrupted release installation leaves the prior release usable offline and switches pins only on request', async ({ context, lab }, info) => {
  test.setTimeout(150_000);
  const initialMarker = 'PrivatePriorRelease11254';
  const editedMarker = 'PrivateOldReleaseEdit31975';
  const packages = await lab.servePackages();
  const initial = await lab.build(packages.url);
  const candidate = await lab.build(packages.url, upgradeRelease);
  const { url } = await lab.serveStatic(initial);
  const previous = await lab.open(context, 'previous release', url);
  const activeBefore = await waitForOffline(previous.page, url);
  await createSource(previous.page, initialMarker);
  await proofPdf(previous.page, info, 'prior-release', initialMarker);
  expect(packages.requests).toHaveLength(1);

  await lab.stopStatic();
  let releaseGate!: () => void;
  const blocked = new Promise<void>(resolve => { releaseGate = resolve; });
  let held = false;
  const gatePath = `compiler/${upgradeRelease}/texlive-basic.data`;
  let staged: Awaited<ReturnType<typeof cacheState>>;
  let interrupted: Awaited<ReturnType<typeof lab.serveStatic>>;
  try {
    interrupted = await lab.serveStatic(candidate, async path => {
      if (path === gatePath) {
        held = true;
        await blocked;
      }
      return undefined;
    });
    await previous.page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      void registration?.update().catch(() => undefined);
    });
    await expect.poll(() => held, { timeout: 35_000 }).toBe(true);
    staged = await cacheState(previous.page);
    const next = staged.caches.find(cache => cache.name.includes(`:${upgradeRelease}:`));
    expect(next?.paths).toContain(`/writedown/compiler/${upgradeRelease}/texlive-basic.js`);
    expect(next?.paths.some(path => path.startsWith('/writedown/__writedown-ready/'))).toBe(false);
    expect(staged.caches.some(cache => cache.name.includes(`:${release.id}:`) &&
      cache.paths.some(path => path.startsWith('/writedown/__writedown-ready/')))).toBe(true);
    await Promise.all([lab.stopStatic(), lab.stopPackages()]);
  } finally {
    releaseGate();
  }
  await expect.poll(() => interrupted.requests.find(request => request.path.endsWith('/' + gatePath))?.status).toBe(0);
  await expect(previous.page.locator('#offline-status')).toHaveAttribute('data-state', 'failed', { timeout: 30_000 });
  await expect(previous.page.locator('#offline-status')).toContainText('Could not load offline asset ' + gatePath);
  const afterInterruption = await cacheState(previous.page);
  expect(afterInterruption.caches.some(cache => cache.name.includes(`:${upgradeRelease}:`))).toBe(false);
  await previous.page.close();
  await context.setOffline(true);

  const oldOffline = await lab.open(context, 'old release after failed update', url);
  await waitForOffline(oldOffline.page, url, release.id);
  await expect(oldOffline.page.getByRole('textbox', { name: 'Source code' })).toHaveValue(document(initialMarker));
  await editSource(oldOffline.page, editedMarker);
  const oldResult = await proofPdf(oldOffline.page, info, 'prior-offline-edited', editedMarker, initialMarker);
  expect(oldResult.attempt.releaseId).toBe(release.id);
  expect(oldOffline.workers).toEqual([new URL(`compiler/${release.id}/busytex_worker.js`, url).href]);

  expect((await lab.serveStatic(candidate)).url).toBe(url);
  const newPackages = await lab.servePackages(upgradeRelease);
  expect(newPackages.url).toBe(packages.url);
  await context.setOffline(false);
  await oldOffline.page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())?.update();
  });
  await expect.poll(() => oldOffline.page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistration())?.waiting?.state,
  ), { timeout: 45_000 }).toBe('installed');
  const readyToActivate = await cacheState(oldOffline.page);
  expect(readyToActivate.caches.some(cache => cache.name.includes(`:${upgradeRelease}:`) &&
    cache.paths.some(path => path.startsWith('/writedown/__writedown-ready/')))).toBe(true);
  expect(await oldOffline.page.evaluate(() => window.offlineProof.snapshot?.releaseId)).toBe(release.id);
  await oldOffline.page.close();
  const observer = await context.newPage();
  try {
    await observer.goto(new URL('/', url).href);
    await expect.poll(() => observer.evaluate(async scope => {
      const registration = await navigator.serviceWorker.getRegistration(scope);
      return !registration?.waiting && registration?.active?.state === 'activated';
    }, url), { timeout: 20_000 }).toBe(true);
  } finally {
    await observer.close();
  }

  const next = await lab.open(context, 'activated release with prior pinned project', url);
  await waitForOffline(next.page, url, upgradeRelease);
  await expect(next.page.getByRole('textbox', { name: 'Source code' })).toHaveValue(document(editedMarker));
  await expect(next.page.locator('#compiler-release-status')).toContainText(`Compiler release ${release.id} is unavailable.`);
  expect(await next.page.evaluate(() => window.offlineProof.snapshot?.releaseId)).toBe(release.id);
  expect(newPackages.requests).toHaveLength(0);
  const switcher = next.page.getByRole('button', { name: 'Switch to ' + upgradeRelease });
  await expect(switcher).toBeVisible();
  await switcher.click();
  await expect(switcher).toBeHidden();
  await expect(next.page.locator('#project-save-status')).toHaveText('Saved on this device.');
  const upgraded = await proofPdf(next.page, info, 'explicitly-upgraded', editedMarker, initialMarker);
  expect(upgraded.attempt.releaseId).toBe(upgradeRelease);
  expect(upgraded.attempt.revision).toBe(oldResult.attempt.revision + 1);
  expect(newPackages.requests).toHaveLength(1);
  await writeFile(info.outputPath('upgrade-readiness.json'), JSON.stringify({
    gatePath, held, activeBefore, staged, afterInterruption, readyToActivate, activated: await cacheState(next.page),
    priorAttempt: oldResult.attempt, installedAttempt: upgraded.attempt,
  }, null, 2));
  await lab.assertPrivate([initialMarker, editedMarker]);
});

test('failed runtime and dependency cache writes can be retried without losing the project', async ({ context, lab }, info) => {
  test.setTimeout(150_000);
  const marker = 'PrivateWriteRetry57512';
  const edited = 'PrivateAfterWriteRetry65693';
  const packages = await lab.servePackages();
  const build = await lab.build(packages.url);
  const rejectedAsset = `compiler/${release.id}/texlive-basic.js`;
  const fault = Buffer.concat([Buffer.from(`
    const originalCachePut = Cache.prototype.put;
    Cache.prototype.put = function (request, response) {
      if (String(request).endsWith(${JSON.stringify('/' + rejectedAsset)})) {
        return Promise.reject(new DOMException('Fixture quota failure', 'QuotaExceededError'));
      }
      return originalCachePut.call(this, request, response);
    };
  `), await readFile(join(build, 'service-worker.js'))]);
  const { url } = await lab.serveStatic(build, path => path === 'service-worker.js' ? fault : undefined);
  const online = await lab.open(context, 'cache write fault', url);
  await expect(online.page.locator('#offline-status')).toContainText(
    'Could not save offline asset ' + rejectedAsset, { timeout: 30_000 },
  );
  const rejected = await cacheState(online.page);
  expect(rejected.controller).toBe(null);
  expect(rejected.caches.some(cache => cache.name.startsWith('writedown-runtime:'))).toBe(false);

  await online.page.evaluate(() => { window.offlineProof.rejectDependencyWrite = true; });
  await createSource(online.page, marker);
  const projected = await proofPdf(online.page, info, 'online-write-fault', marker);
  await expect(online.page.locator('#project-compile-status')).toContainText('Could not save verified TeX dependency booktabs.sty for offline use.');
  expect(projected.diagnostics.some(item => item.code === 'dependency-cache-write')).toBe(true);
  expect(packages.requests).toHaveLength(1);
  const dependencyRejected = await cacheState(online.page);
  expect(dependencyRejected.caches.some(cache => cache.paths.some(path => path.endsWith('/booktabs.sty')))).toBe(false);
  const oldRevision = projected.attempt.revision;

  await lab.stopStatic();
  expect((await lab.serveStatic(build)).url).toBe(url);
  await online.page.getByRole('button', { name: 'Retry offline setup' }).click();
  await waitForOffline(online.page, url);
  await online.page.evaluate(() => { window.offlineProof.rejectDependencyWrite = false; });
  await online.page.getByRole('button', { name: 'Retry dependency cache' }).click();
  await expect(online.page.locator('#project-compile-status')).toHaveText(`Revision ${oldRevision} compiled.`, { timeout: 45_000 });
  const repaired = await cacheState(online.page);
  expect(repaired.caches.some(cache => cache.paths.some(path => path.endsWith('/booktabs.sty')))).toBe(true);
  expect(packages.requests).toHaveLength(2);
  await online.page.close();
  await Promise.all([lab.stopStatic(), lab.stopPackages()]);
  await context.setOffline(true);
  const offline = await lab.open(context, 'offline after both repairs', url);
  await expect(offline.page.getByRole('textbox', { name: 'Source code' })).toHaveValue(document(marker));
  expect(await offline.page.evaluate(() => window.offlineProof.snapshot?.revision)).toBe(oldRevision);
  await editSource(offline.page, edited);
  const changed = await proofPdf(offline.page, info, 'offline-after-write-retry', edited, marker);
  expect(changed.attempt.revision).toBeGreaterThan(oldRevision);
  await writeFile(info.outputPath('write-recovery.json'), JSON.stringify({
    rejectedAsset, rejected, dependencyRejected, repaired, before: projected.attempt, after: changed.attempt,
  }, null, 2));
  await lab.assertPrivate([marker, edited]);
});
