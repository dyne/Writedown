import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import release from '../../compiler-release.json' with { type: 'json' };
import { createCompilationRequest } from '../../src/compiler/contracts.ts';
import { createProjectSnapshot } from '../../src/project/snapshot.ts';
import type { TextFile, TexEngine } from '../../src/project/snapshot.ts';
import { startStaticServer } from '../support/static-server.ts';

const run = promisify(execFile);
const dist = resolve('dist');
const source = (path: string, text: string): TextFile => ({ kind: 'text', path, text });
const document = (body: string, preamble = '') =>
  [String.raw`\documentclass{article}`, preamble, String.raw`\begin{document}`, body, String.raw`\end{document}`].join('\n');

const fixtures = {
  pdflatex: {
    entry: 'paper/main.tex',
    files: [
      source('main.tex', document('Wrong root marker.')),
      source('paper/main.tex', document(String.raw`Nested root marker. \input{chapters/intro.tex} \input{../shared.tex}`)),
      source('chapters/intro.tex', 'Wrong chapter marker.'),
      source('paper/chapters/intro.tex', 'Nested chapter marker.'),
      source('shared.tex', 'Parent directory marker.'),
    ],
    markers: ['Nested root marker.', 'Nested chapter marker.', 'Parent directory marker.'],
    banner: 'This is pdfTeX, Version',
    passes: ['pdflatex', 'pdflatex', 'pdflatex'],
  },
  xelatex: {
    entry: 'main.tex',
    files: [source('main.tex', document(String.raw`\pinned XeLaTeX pinned font marker.`,
      String.raw`\font\pinned="[lmsans10-regular.otf]" at 10pt`))],
    markers: ['XeLaTeX pinned font marker.'],
    banner: 'This is XeTeX, Version',
    passes: ['xelatex', 'xelatex', 'xdvipdfmx'],
  },
  lualatex: {
    entry: 'main.tex',
    files: [source('main.tex', document('LuaLaTeX engine marker.'))],
    markers: ['LuaLaTeX engine marker.'],
    banner: 'This is LuaHBTeX, Version',
    passes: ['luahblatex', 'luahblatex', 'luahblatex'],
  },
} satisfies Record<TexEngine, { entry: string; files: TextFile[]; markers: string[]; banner: string; passes: string[] }>;

for (const engine of ['pdflatex', 'xelatex', 'lualatex'] as const) {
  test(`compiler release runs ${engine} in a production worker`, async ({ page, context }, testInfo) => {
    test.setTimeout(120_000);
    const fixture = fixtures[engine];
    const chunks = (await readdir(join(dist, 'assets'))).filter(name => /^busytex-.*\.js$/.test(name));
    expect(chunks, 'production BusyTexCompiler chunk').toHaveLength(1);
    const server = await startStaticServer(dist);
    const workerUrls: string[] = [];
    const foreignRequests: string[] = [];
    page.on('worker', worker => workerUrls.push(worker.url()));
    await context.route('**/*', route => {
      const url = route.request().url();
      if (new URL(url).origin === new URL(server.url).origin) return route.continue();
      foreignRequests.push(url);
      return route.abort();
    });
    try {
      const request = createCompilationRequest(createProjectSnapshot({
        projectId: 'engine-proof', revision: 1, entryPath: fixture.entry,
        engine, bibliography: 'none', releaseId: release.id, files: fixture.files,
      }), { workerGeneration: 1, jobId: engine });
      await page.goto(server.url);
      const output = await page.evaluate(async ({ chunk, request, assetBase }) => {
        const { BusyTexCompiler } = await import(chunk) as typeof import('../../src/compiler/busytex.ts');
        const compiler = new BusyTexCompiler(assetBase);
        try {
          const result = await compiler.compile(request);
          const metadata = { attempt: result.attempt, passLogs: result.passLogs, diagnostics: result.diagnostics };
          if (result.status === 'failure') return { ...metadata, status: result.status, reason: result.reason };
          const sidecar = result.syncTex;
          const syncText = sidecar
            ? await new Response(sidecar.stream().pipeThrough(new DecompressionStream('gzip'))).text()
            : '';
          const syncPaths = Array.from(syncText.matchAll(/^Input:\d+:(.+)$/gm), ([, path]) => ({
            raw: path, project: result.pathMap?.resolve(path) ?? null,
          }));
          const texLog = result.passLogs.map(pass => (JSON.parse(pass.text) as { log: string }).log).join('\n');
          const logPaths = Array.from(texLog.matchAll(/\((\.\.?\/[^\s()]+\.tex)(?=[\s)])/g), ([, path]) => ({
            raw: path, project: result.pathMap?.resolve(path) ?? null,
          }));
          return {
            ...metadata, status: result.status, texLog, syncPaths, logPaths, syncText,
            pdf: Array.from(new Uint8Array(await result.pdf.arrayBuffer())),
            syncTex: sidecar ? Array.from(new Uint8Array(await sidecar.arrayBuffer())) : null,
          };
        } finally {
          compiler.terminate();
        }
      }, {
        chunk: new URL('assets/' + chunks[0], server.url).href,
        assetBase: new URL('compiler/' + release.id, server.url).href,
        request: { ...request, snapshot: { ...request.snapshot, files: fixture.files } },
      });

      if (output.status === 'failure') {
        await writeFile(testInfo.outputPath('result.json'), JSON.stringify(output, null, 2));
        throw new Error(output.reason);
      }
      const { pdf, syncTex, ...reported } = output;
      await writeFile(testInfo.outputPath('result.json'), JSON.stringify(reported, null, 2));
      expect(output.attempt).toEqual(request.attempt);
      expect(output.passLogs.map(pass => [pass.tool.split(' ')[0], pass.exitCode]))
        .toEqual(fixture.passes.map(tool => [tool, 0]));
      expect(output.texLog).toContain(fixture.banner);
      expect(output.texLog).toContain(release.coverage.texLive);
      expect(workerUrls).toEqual([new URL('compiler/' + release.id + '/busytex_worker.js', server.url).href]);
      expect(foreignRequests).toEqual([]);
      expect(server.requests.filter(request => request.status !== 200)).toEqual([]);
      expect(server.requests.some(request => request.path.endsWith('/texlive-basic.data'))).toBe(true);

      const pdfPath = testInfo.outputPath(engine + '.pdf');
      await writeFile(pdfPath, Buffer.from(pdf));
      const { stdout: text } = await run('pdftotext', [pdfPath, '-']);
      await writeFile(testInfo.outputPath('pdf.txt'), text);
      for (const marker of fixture.markers) expect(text.replace(/\s+/g, ' ')).toContain(marker);
      expect(text).not.toContain('Wrong');
      if (engine === 'xelatex') {
        const { stdout: fonts } = await run('pdffonts', [pdfPath]);
        await writeFile(testInfo.outputPath('fonts.txt'), fonts);
        expect(fonts).toMatch(/^\w{6}\+LMSans10-Regular-Identity-H\s+CID Type 0C\s+Identity-H\s+yes\s+yes/m);
      }

      if (!syncTex?.length) throw new Error('Expected a SyncTeX sidecar');
      await writeFile(testInfo.outputPath('result.synctex.gz'), Buffer.from(syncTex));
      expect(output.syncText).toMatch(/^SyncTeX Version:1\n/);
      expect(output.syncPaths[0].project).toBe(fixture.entry);
      expect(output.syncPaths.find(path => path.raw.endsWith('/article.cls'))?.project).toBeNull();
      if (engine === 'pdflatex') {
        const expected = ['paper/main.tex', 'paper/chapters/intro.tex', 'shared.tex'];
        expect(output.syncPaths.flatMap(({ project }) => project ?? [])).toEqual(expected);
        expect(output.logPaths.flatMap(({ project }) => project ?? [])).toEqual(expected);
      }
    } finally {
      await writeFile(testInfo.outputPath('requests.json'), JSON.stringify({ workerUrls, foreignRequests, serverRequests: server.requests }, null, 2));
      await server.close();
    }
  });
}

test('compiler release identifies a missing production worker asset', async ({ page }, testInfo) => {
  const workerPath = join('compiler', release.id, 'busytex_worker.js');
  const root = await mkdtemp(join(tmpdir(), 'writedown-missing-worker-'));
  try {
    await cp(dist, root, { recursive: true });
    await rm(join(root, workerPath));
    const server = await startStaticServer(root);
    try {
      await page.goto(server.url);
      await page.getByRole('button', { name: 'Compile example', exact: true }).click();
      const status = page.getByRole('status');
      await expect(status).toContainText('Could not initialize the BusyTeX worker for ' + release.id + ' (busytex_worker.js)');
      await writeFile(testInfo.outputPath('status.txt'), (await status.textContent()) ?? '');
      await expect(page.getByRole('link', { name: 'Download PDF' })).toHaveCount(0);
      expect(server.requests.filter(request => request.status >= 400)).toEqual([
        { method: 'GET', path: '/writedown/' + workerPath, status: 404 },
      ]);
    } finally {
      await writeFile(testInfo.outputPath('requests.json'), JSON.stringify(server.requests, null, 2));
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
