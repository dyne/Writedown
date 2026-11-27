import { test as base, expect } from '@playwright/test';
import type { JSHandle, Page, TestInfo } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import release from '../../compiler-release.json' with { type: 'json' };
import { prepareDependencies } from '../../scripts/prepare-dependencies.ts';
import type { BusyTexCompiler } from '../../src/compiler/busytex.ts';
import { createCompilationRequest } from '../../src/compiler/contracts.ts';
import type { CompilationResult } from '../../src/compiler/contracts.ts';
import { dependencyFiles, dependencyPath } from '../../src/compiler/dependency-catalog.ts';
import type { CompilationState } from '../../src/compiler/service.ts';
import { createProjectSnapshot } from '../../src/project/snapshot.ts';
import { startDependencyServer } from '../support/dependency-server.ts';
import { startStaticServer } from '../support/static-server.ts';
import type { RecordedRequest } from '../support/static-server.ts';

declare global {
  interface Window { dependencyEditorResult?: CompilationResult }
}

const run = promisify(execFile);
const dist = resolve('dist');
const booktabs = dependencyFiles.find(entry => entry.name === 'booktabs.sty')!;
const approvedPath = dependencyPath(booktabs);
const missingInput = 'PrivateFilenameCanary91857.tex';
const privateBody = 'PrivateBodyCanary76231';
const privateRoot = 'PrivateEntryCanary30478.tex';
const privateOutput = 'PrivateOutputCanary75885';
const unknownStyle = 'PrivateStyleCanary15832';
const privateDirectory = 'PrivateDirectoryCanary62704';
const canaries = [missingInput, privateBody, privateRoot, privateOutput, unknownStyle, privateDirectory];
const tex = (body: string, preamble = '') =>
  [String.raw`\documentclass{article}`, preamble, String.raw`\begin{document}`, body, String.raw`\end{document}`].join('\n');
const table = (marker: string) => tex(
  String.raw`\begin{tabular}{l}\toprule ${marker}\\\bottomrule\end{tabular}`,
  String.raw`\usepackage{graphicx,booktabs}`,
);
const projectStyle = {
  path: 'paper/booktabs.sty', kind: 'text' as const,
  text: String.raw`\ProvidesPackage{booktabs}\newcommand{\toprule}{Project style marker.\space}\newcommand{\bottomrule}{}`,
};
let bytes: Buffer;

const test = base.extend<{ endpoint: Awaited<ReturnType<typeof startDependencyServer>> }>({
  endpoint: async ({}, use, testInfo) => {
    const endpoint = await startDependencyServer(approvedPath, bytes);
    try {
      await use(endpoint);
    } finally {
      await endpoint.close();
      await writeFile(testInfo.outputPath('package-requests.json'), JSON.stringify(endpoint.requests, null, 2));
    }
  },
});

test.beforeAll(async ({}, testInfo) => {
  const directory = join(testInfo.project.outputDir, 'dependency-fixtures');
  await prepareDependencies(directory);
  bytes = await readFile(join(directory, approvedPath));
});

async function withProduction(
  page: Page,
  testInfo: TestInfo,
  directory: string,
  use: (server: Awaited<ReturnType<typeof startStaticServer>>, workers: string[]) => Promise<void>,
) {
  const server = await startStaticServer(directory);
  const workers: string[] = [];
  page.on('worker', worker => workers.push(worker.url()));
  try {
    await page.goto(server.url);
    await use(server, workers);
  } finally {
    await server.close();
    await writeFile(testInfo.outputPath('static-requests.json'), JSON.stringify({ workers, requests: server.requests }, null, 2));
  }
}

async function openCompiler(page: Page, staticUrl: string, endpoint?: string) {
  const chunks = (await readdir(join(dist, 'assets'))).filter(name => /^busytex-.*\.js$/.test(name));
  expect(chunks, 'production BusyTexCompiler chunk').toHaveLength(1);
  return page.evaluateHandle(async ({ chunk, compilerBase, endpoint }) => {
    const { BusyTexCompiler } = await import(chunk) as typeof import('../../src/compiler/busytex.ts');
    return new BusyTexCompiler(compilerBase, endpoint);
  }, {
    chunk: new URL('assets/' + chunks[0], staticUrl).href,
    compilerBase: new URL('compiler/' + release.id, staticUrl).href,
    endpoint,
  });
}

async function closeCompiler(compiler: JSHandle<BusyTexCompiler>) {
  try {
    await compiler.evaluate(instance => instance.terminate());
  } finally {
    await compiler.dispose();
  }
}

async function extractPdf(testInfo: TestInfo, job: string, pdf: number[]): Promise<string> {
  const path = testInfo.outputPath(job + '.pdf');
  await writeFile(path, Buffer.from(pdf));
  const { stdout } = await run('pdftotext', [path, '-']);
  await writeFile(testInfo.outputPath(job + '-pdf.txt'), stdout);
  return stdout;
}

async function compile(
  compiler: JSHandle<BusyTexCompiler>, testInfo: TestInfo, job: string, source: string,
  entryPath = 'paper/main.tex', files: (typeof projectStyle)[] = [],
) {
  const textFiles = [{ kind: 'text' as const, path: entryPath, text: source }, ...files];
  const request = createCompilationRequest(createProjectSnapshot({
    projectId: 'dependency-test', revision: 1, entryPath, releaseId: release.id,
    engine: 'pdflatex', bibliography: 'none',
    files: textFiles,
  }), { jobId: job, workerGeneration: 1 });
  const result = await compiler.evaluate(async (instance, request) => {
    const result = await instance.compile(request);
    return {
      status: result.status, diagnostics: result.diagnostics, passLogs: result.passLogs,
      reason: result.status === 'failure' ? result.reason : null,
      pdf: result.status === 'success' ? Array.from(new Uint8Array(await result.pdf.arrayBuffer())) : null,
    };
  }, { ...request, snapshot: { ...request.snapshot, files: textFiles } });
  const { pdf, ...metadata } = result;
  await writeFile(testInfo.outputPath(job + '-result.json'), JSON.stringify(metadata, null, 2));
  return { ...metadata, text: pdf ? await extractPdf(testInfo, job, pdf) : '' };
}

function expectPrivateTraffic(staticRequests: RecordedRequest[], packageRequests: RecordedRequest[], expectedPaths: string[]) {
  expect(packageRequests.map(row => ({ path: row.path, method: row.method, status: row.status })))
    .toEqual(expectedPaths.map(path => ({ path, method: 'GET', status: 200 })));
  for (const row of packageRequests) {
    expect(row.headers.authorization).toBeUndefined();
    expect(row.headers.cookie).toBeUndefined();
    expect(row.headers.referer).toBeUndefined();
  }
  expect(staticRequests.filter(row => row.status !== 200)).toEqual([]);
  for (const row of [...staticRequests, ...packageRequests]) {
    expect(row.method).toBe('GET');
    expect(row.bodyBytes).toBe(0);
    const traffic = JSON.stringify(row).toLowerCase();
    for (const canary of canaries) {
      expect(traffic).not.toContain(canary.toLowerCase());
      expect(traffic).not.toContain(encodeURIComponent(canary).toLowerCase());
    }
  }
}

test('approved TeX dependency uses local files, then verified bytes and the cache after worker restart', async ({ page, endpoint }, testInfo) => {
  test.setTimeout(120_000);
  await withProduction(page, testInfo, dist, async (server, workers) => {
    const active = await openCompiler(page, server.url, endpoint.url);
    try {
      const local = await compile(active, testInfo, 'project-style', table('Before fetch.'), undefined, [projectStyle]);
      expect(local.status, local.reason ?? undefined).toBe('success');
      expect(local.text).toContain('Project style marker. Before fetch.');
      expect(endpoint.requests).toHaveLength(0);

      const cold = await compile(active, testInfo, 'cold-package', table('Cold verified table.'));
      expect(cold.status, cold.reason ?? undefined).toBe('success');
      expect(cold.text).toContain('Cold verified table.');
      expect(cold.text).not.toContain('Project style marker.');
      expect(cold.passLogs.some(pass => pass.exitCode !== 0 && pass.text.includes("File `booktabs.sty' not found."))).toBe(true);
      expect(endpoint.requests).toHaveLength(1);

      const overridden = await compile(active, testInfo, 'project-override', table(privateOutput), undefined, [projectStyle]);
      expect(overridden.status, overridden.reason ?? undefined).toBe('success');
      expect(overridden.text).toContain('Project style marker. ' + privateOutput);
      expect(endpoint.requests).toHaveLength(1);
    } finally {
      await closeCompiler(active);
    }

    // The new worker has no registered packages and no endpoint configured.
    const fresh = await openCompiler(page, server.url);
    try {
      const cached = await compile(fresh, testInfo, 'cached-package', table('Fresh worker cached table.'));
      expect(cached.status, cached.reason ?? undefined).toBe('success');
      expect(cached.text).toContain('Fresh worker cached table.');
      expect(cached.passLogs.some(pass => pass.exitCode !== 0 && pass.text.includes("File `booktabs.sty' not found."))).toBe(true);
    } finally {
      await closeCompiler(fresh);
    }
    expect(workers.filter(url => url.endsWith('/busytex_worker.js'))).toHaveLength(2);
    const workerRequests = server.requests.filter(row => row.path.endsWith('/busytex_worker.js'));
    expect(workerRequests.length).toBeGreaterThan(0);
    expect(workerRequests.filter(row => row.headers['sec-fetch-dest'] === 'worker').length).toBeLessThanOrEqual(2);
    expectPrivateTraffic(server.requests, endpoint.requests, [endpoint.path]);
  });
});

test('a disabled endpoint and private input stay local, and corrupt packages can be retried', async ({ page, context, endpoint }, testInfo) => {
  test.setTimeout(120_000);
  await context.addCookies([{ name: 'dependencyCookie', value: privateBody, url: endpoint.url }]);
  await withProduction(page, testInfo, dist, async (server, workers) => {
    const disabled = await openCompiler(page, server.url);
    try {
      const result = await compile(disabled, testInfo, 'disabled-endpoint', table('Unavailable style.'));
      expect(result.status).toBe('failure');
      expect(result.reason).toContain('booktabs.sty is absent from the verified cache and no endpoint is configured');
      expect(result.text).toBe('');
      expect(endpoint.requests).toHaveLength(0);
    } finally {
      await closeCompiler(disabled);
    }

    const enabled = await openCompiler(page, server.url, endpoint.url);
    try {
      const privateInput = tex(`${privateOutput}\n\\input{${missingInput}}\n% ${privateBody}`);
      const missing = await compile(enabled, testInfo, 'private-input', privateInput, privateRoot);
      expect(missing.status).toBe('failure');
      expect(missing.diagnostics.map(item => item.message).join('\n')).toContain(missingInput);
      expect(missing.passLogs[0].text).toContain(privateRoot);
      const style = await compile(enabled, testInfo, 'unknown-style', tex(privateBody, `\\usepackage{${unknownStyle}}`));
      expect(style.status).toBe('failure');
      expect(style.reason).toContain(unknownStyle + '.sty');
      const collision = await compile(enabled, testInfo, 'private-path-collision', tex(`\\input{${privateDirectory}/booktabs.sty}`));
      expect(collision.status).toBe('failure');
      expect(collision.reason).toContain(privateDirectory + '/booktabs.sty');
      expect(endpoint.requests).toHaveLength(0);

      endpoint.setCorrupt(true);
      const corrupt = await compile(enabled, testInfo, 'corrupt-package', table('No corrupt table.'));
      expect(corrupt.status).toBe('failure');
      expect(corrupt.reason).toBe('Size or SHA-256 mismatch for TeX dependency booktabs.sty.');
      expect(corrupt.text).toBe('');
      expect(endpoint.requests).toHaveLength(1);

      endpoint.setCorrupt(false);
      const retry = await compile(enabled, testInfo, 'retry-package', table('Recovered verified table.'));
      expect(retry.status, retry.reason ?? undefined).toBe('success');
      expect(retry.text).toContain('Recovered verified table.');
    } finally {
      await closeCompiler(enabled);
    }
    expect(workers.filter(url => url.endsWith('/busytex_worker.js'))).toHaveLength(2);
    expectPrivateTraffic(server.requests, endpoint.requests, [endpoint.path, endpoint.path]);
  });
});

test('the configured production editor compiles with the published dependency endpoint', async ({ page, endpoint }, testInfo) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(testInfo.outputPath('configured-build-'));
  try {
    const build = await run('npm', ['run', 'build', '--', '--outDir', directory], {
      env: { ...process.env, VITE_TEX_DEPENDENCY_ENDPOINT: endpoint.url },
    });
    await writeFile(testInfo.outputPath('configured-build.log'), build.stdout + build.stderr);
    await page.addInitScript(() => {
      window.addEventListener('writedown:compilation-state', event => {
        const state = (event as CustomEvent<CompilationState>).detail;
        if (state.status === 'settled') window.dependencyEditorResult = state.result;
      });
    });
    await withProduction(page, testInfo, directory, async (server, workers) => {
      await page.getByText('New source file', { exact: true }).press('Enter');
      await page.getByRole('textbox', { name: 'File path' }).fill('main.tex');
      await page.getByRole('button', { name: 'Create file', exact: true }).press('Enter');
      await page.getByRole('textbox', { name: 'Source code' }).fill(table('Editor dependency table.'));
      await expect(page.locator('#project-compile-status')).toHaveText(/^Revision \d+ compiled\.$/, { timeout: 90_000 });
      const pdf = await page.evaluate(async () => {
        const result = window.dependencyEditorResult;
        if (result?.status !== 'success') throw new Error('Expected the editor PDF of the current revision.');
        return Array.from(new Uint8Array(await result.pdf.arrayBuffer()));
      });
      expect(await extractPdf(testInfo, 'editor-package', pdf)).toContain('Editor dependency table.');
      expect(workers.filter(url => url.endsWith('/busytex_worker.js'))).toHaveLength(1);
      expectPrivateTraffic(server.requests, endpoint.requests, [endpoint.path]);
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
