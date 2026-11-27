import { test, expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { execFile } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import release from '../../compiler-release.json' with { type: 'json' };
import { createCompilationRequest } from '../../src/compiler/contracts.ts';
import { createProjectSnapshot } from '../../src/project/snapshot.ts';
import type { BibliographyMode, TextFile } from '../../src/project/snapshot.ts';
import { startStaticServer } from '../support/static-server.ts';

const run = promisify(execFile);
const dist = resolve('dist');
const entry = 'paper/main.tex';
const chapter = 'paper/chapters/intro.tex';
const bibliography = 'paper/references.bib';
const figure = 'paper/images/figure.png';
const figureBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGPwnngJiBggFAAs+ga5rRVBzQAAAABJRU5ErkJggg==', 'base64');
const source = (path: string, text: string): TextFile => ({ kind: 'text', path, text });
const document = (body: string, preamble = '') =>
  [String.raw`\documentclass{article}`, preamble, String.raw`\begin{document}`, body, String.raw`\end{document}`].join('\n');
type FileFixture = TextFile | { kind: 'binary'; path: string; data: number[] };
type Job = {
  name: string;
  files: FileFixture[];
  projectId?: string;
  bibliography?: BibliographyMode;
};

async function compileJobs(page: Page, testInfo: TestInfo, jobs: Job[]) {
  const chunks = (await readdir(join(dist, 'assets'))).filter(name => /^busytex-.*\.js$/.test(name));
  expect(chunks, 'production BusyTexCompiler chunk').toHaveLength(1);
  const server = await startStaticServer(dist);
  const workerUrls: string[] = [];
  page.on('worker', worker => workerUrls.push(worker.url()));
  try {
    await page.goto(server.url);
    const requests = jobs.map((job, index) => {
      const snapshot = createProjectSnapshot({
        projectId: job.projectId ?? 'paper', revision: index + 1, entryPath: entry, releaseId: release.id,
        engine: 'pdflatex', bibliography: job.bibliography ?? 'none',
        files: job.files.map(file => file.kind === 'text' ? file : { ...file, bytes: Uint8Array.from(file.data) }),
      });
      const request = createCompilationRequest(snapshot, { workerGeneration: 1, jobId: job.name });
      return { ...request, snapshot: { ...request.snapshot, files: job.files } };
    });
    const results = await page.evaluate(async ({ chunk, assetBase, requests }) => {
      const { BusyTexCompiler } = await import(chunk) as typeof import('../../src/compiler/busytex.ts');
      const compiler = new BusyTexCompiler(assetBase);
      try {
        const results = [];
        for (const { attempt, snapshot } of requests) {
          const files = snapshot.files.map(file => file.kind === 'text' ? file : {
            kind: file.kind, path: file.path, bytes: new Blob([Uint8Array.from(file.data)]),
          });
          const result = await compiler.compile({ attempt, snapshot: { ...snapshot, files } });
          results.push({
            status: result.status, attempt: result.attempt, passLogs: result.passLogs,
            diagnostics: result.diagnostics,
            reason: result.status === 'failure' ? result.reason : null,
            pdf: result.status === 'success' ? Array.from(new Uint8Array(await result.pdf.arrayBuffer())) : null,
          });
        }
        return results;
      } finally {
        compiler.terminate();
      }
    }, {
      chunk: new URL('assets/' + chunks[0], server.url).href,
      assetBase: new URL('compiler/' + release.id, server.url).href,
      requests,
    });

    const evidence = [];
    for (const result of results) {
      const { pdf, ...metadata } = result;
      const name = metadata.attempt.jobId;
      await writeFile(testInfo.outputPath(name + '-result.json'), JSON.stringify(metadata, null, 2));
      let text = '';
      if (pdf) {
        const path = testInfo.outputPath(name + '.pdf');
        await writeFile(path, Buffer.from(pdf));
        text = (await run('pdftotext', [path, '-'])).stdout;
        await writeFile(testInfo.outputPath(name + '-pdf.txt'), text);
      }
      const tools = result.passLogs.map(pass => pass.tool.split(' ')[0]);
      for (const pass of result.passLogs.filter(pass => pass.tool.startsWith('pdflatex '))) {
        expect(pass.tool.split(' ')).toContain('--no-shell-escape');
      }
      evidence.push({ ...metadata, text, tools });
    }
    return { results: evidence, workerUrls: [...workerUrls], requests: [...server.requests] };
  } finally {
    await writeFile(testInfo.outputPath('requests.json'), JSON.stringify({ workerUrls, requests: server.requests }, null, 2));
    await server.close();
  }
}

const paper = document(String.raw`\input{chapters/intro.tex}
\includegraphics[width=1cm]{images/figure.png}
Forward reference: \ref{sec:findings}. Citation: \cite{memo}.
\newpage
\section{Findings}\label{sec:findings}
Page two marker.
\bibliographystyle{plain}\bibliography{references}`, String.raw`\usepackage{graphicx}`);

const referenceFile = (title: string) => source(bibliography,
  '@book{memo, title={' + title + '}, author={Quinn, Alex}, publisher={Fixture Press}, year={2026}}');

function paperFiles(title: string): FileFixture[] {
  return [
    source(entry, paper),
    source(chapter, 'Nested chapter marker.'),
    { kind: 'binary', path: figure, data: [...figureBytes] },
    referenceFile(title),
  ];
}

test('one warm production worker compiles complete snapshots and fresh citations across projects', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const original = paperFiles('Original Evidence');
  const revised = paperFiles('Revised Evidence');
  const otherProject = document(String.raw`\input{chapters/intro.tex}
\makeatletter
\@ifundefined{r@sec:findings}{}{\PackageError{Isolation}{Stale auxiliary label}{}}
\makeatother
Replacement project marker.`, String.raw`\IfFileExists{main.bbl}{\PackageError{Isolation}{Stale bibliography}{}}{}`);
  const run = await compileJobs(page, testInfo, [
    { name: 'original', bibliography: 'bibtex', files: original },
    { name: 'revised', bibliography: 'bibtex', files: revised },
    { name: 'removed', bibliography: 'bibtex', files: revised.filter(file => file.path !== chapter) },
    { name: 'restored', bibliography: 'bibtex', files: revised },
    { name: 'switched', projectId: 'replacement', files: [source(entry, otherProject), source(chapter, 'Replacement chapter marker.')] },
  ]);
  const [first, changed, removed, restored, switched] = run.results;
  expect(run.workerUrls).toHaveLength(1);
  for (const name of ['busytex_worker.js', 'texlive-basic.data']) {
    const requests = run.requests.filter(request => request.path.endsWith('/' + name));
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.filter(request => !request.headers.referer?.endsWith('/service-worker.js')).length).toBeLessThanOrEqual(1);
  }
  expect(run.requests.every(request => request.status === 200)).toBe(true);
  for (const result of [first, changed, restored]) {
    expect(result.status, result.reason ?? undefined).toBe('success');
    expect(result.tools).toEqual(['pdflatex', 'bibtex8', 'pdflatex', 'pdflatex', 'pdflatex']);
    const pages = result.text.split('\f').map(text => text.replace(/\s+/g, ' ').trim()).filter(Boolean);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain('Nested chapter marker.');
    expect(pages[0]).toContain('Forward reference: 1. Citation: [1].');
    expect(pages[1]).toContain('Page two marker.');
    expect(result.passLogs.at(-1)?.text).toContain('./images/figure.png');
    expect(result.diagnostics.filter(diagnostic => /undefined|rerun/i.test(diagnostic.message))).toEqual([]);
  }
  expect(first.text).toContain('Original Evidence');
  expect(changed.text).toContain('Revised Evidence');
  expect(changed.text).not.toContain('Original Evidence');

  expect(removed.status).toBe('failure');
  expect(removed.text).toBe('');
  expect(removed.diagnostics).toContainEqual({
    severity: 'error', message: "LaTeX Error: File `chapters/intro.tex' not found.", path: entry,
    line: paper.split('\n').findIndex(line => line.includes('chapters/intro.tex')) + 1,
  });
  expect(removed.passLogs.length).toBeGreaterThan(0);
  expect(switched.attempt.projectId).toBe('replacement');
  expect(switched.status, switched.reason ?? undefined).toBe('success');
  expect(switched.text).toContain('Replacement chapter marker.');
  expect(switched.text).not.toContain('Revised Evidence');
  expect(switched.tools).not.toContain('bibtex8');
});

test('production diagnostics locate nested source errors and retain unlocated BibTeX warnings', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const cited = document(String.raw`Citation \cite{memo,absent}.
\bibliographystyle{plain}\bibliography{references}`);
  const { results: [nested, unresolved] } = await compileJobs(page, testInfo, [
    { name: 'nested-error', files: [
      source(entry, document(String.raw`\input{chapters/intro.tex}`)),
      source(chapter, 'First line.\n\\NotDefinedHere'),
    ] },
    { name: 'unresolved', bibliography: 'bibtex', files: [source(entry, cited), referenceFile('Known Evidence')] },
  ]);
  expect(nested.status).toBe('failure');
  expect(nested.diagnostics).toContainEqual({
    severity: 'error', message: 'Undefined control sequence.', path: chapter, line: 2,
  });
  expect(nested.passLogs.at(-1)?.text).toContain('NotDefinedHere');
  expect(unresolved.status, unresolved.reason ?? undefined).toBe('success');
  expect(unresolved.diagnostics).toContainEqual({
    severity: 'warning', message: "I didn't find a database entry for \"absent\"",
  });
  expect(unresolved.diagnostics).toContainEqual({
    severity: 'warning', message: "Citation `absent' on page 1 undefined on input line 4.", path: entry, line: 4,
  });
  expect(unresolved.passLogs.find(pass => pass.tool.startsWith('bibtex8 '))?.text).toContain('Warning--I didn');
});

test('a nonconverging reference returns its final warning and stops after four TeX passes', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const flip = document(String.raw`\newcounter{flip}
\newread\lastfile
\openin\lastfile=flip.txt
\ifeof\lastfile\def\last{0}\else\read\lastfile to \last\fi
\closein\lastfile
\ifnum\last=0 \setcounter{flip}{0}\else\setcounter{flip}{-1}\fi
\refstepcounter{flip}\label{flip}
\newwrite\thisfile
\immediate\openout\thisfile=flip.txt
\immediate\write\thisfile{\arabic{flip}}
\immediate\closeout\thisfile
The value is \ref{flip}.`);
  const { results: [result] } = await compileJobs(page, testInfo, [{ name: 'flip', files: [source(entry, flip)] }]);
  expect(result.status, result.reason ?? undefined).toBe('success');
  expect(result.tools).toEqual(Array.from({ length: 4 }, () => 'pdflatex'));
  expect(result.diagnostics).toContainEqual({
    severity: 'warning', message: 'Label(s) may have changed. Rerun to get cross-references right.',
  });
  expect(result.passLogs.at(-1)?.text).toContain('Rerun to get cross-references right');
});

test('MakeIndex runs as a separate production pass when TeX produces index entries', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const indexed = document(String.raw`Page body.\index{FixtureIndexEntry}\printindex`, String.raw`\usepackage{makeidx}\makeindex`);
  const { results: [result] } = await compileJobs(page, testInfo, [{ name: 'index', files: [source(entry, indexed)] }]);
  expect(result.status, result.reason ?? undefined).toBe('success');
  expect(result.tools).toEqual(['pdflatex', 'makeindex', 'pdflatex', 'pdflatex']);
  expect(result.text).toContain('FixtureIndexEntry');
  expect(result.passLogs.find(pass => pass.tool.startsWith('makeindex '))?.exitCode).toBe(0);
});

test('the basic production release reports unavailable Biber assets without falling back to BibTeX', async ({ page }, testInfo) => {
  const { results: [result], workerUrls, requests } = await compileJobs(page, testInfo, [
    { name: 'biber', bibliography: 'biber', files: [source(entry, document('Biber probe.'))] },
  ]);
  expect(result.status).toBe('failure');
  expect(result.reason).toBe('Biber is unavailable in ' + release.id + '. Missing assets: biber.js, biber.wasm, biber.data.');
  expect(result.diagnostics).toEqual([{ severity: 'error', message: result.reason }]);
  expect(result.passLogs).toEqual([]);
  expect(workerUrls).toEqual([]);
  expect(requests.some(request =>
    /\/compiler\//.test(request.path) && !request.headers.referer?.endsWith('/service-worker.js'),
  )).toBe(false);
});

test('the adapter discards a worker after a malformed figure traps the engine', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  // Grayscale with alpha and an invalid IDAT checksum. Decoding this image
  // forces the pinned pdfTeX applet through its libpng failure path.
  const malformed = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCy0AAAAASUVORK5CYII=', 'base64');
  const corrected = paperFiles('Recovery Evidence');
  const damaged = corrected.map((file): FileFixture => file.path === figure
    ? { kind: 'binary', path: figure, data: [...malformed] }
    : file);
  const { results: [trapped, recovered], workerUrls } = await compileJobs(page, testInfo, [
    { name: 'trapped', bibliography: 'bibtex', files: damaged },
    { name: 'recovered', bibliography: 'bibtex', files: corrected },
  ]);
  expect(trapped.status).toBe('failure');
  expect(trapped.reason).toContain('Exception during compilation');
  expect(recovered.status, recovered.reason ?? undefined).toBe('success');
  expect(recovered.text).toContain('Recovery Evidence');
  expect(workerUrls).toHaveLength(2);
});
