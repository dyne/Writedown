import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';

const storeModule: string = '/writedown/src/project/store.ts';
let server: ViteDevServer;
let url: string;

test.beforeAll(async () => {
  // Exercise the store in a browser before the editor includes it in the production entry point.
  server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Project store fixture has no HTTP address');
  url = `http://127.0.0.1:${address.port}/writedown/`;
});

test.afterAll(async () => { await server?.close(); });

test('restores project revisions and original binary bytes on reload', async ({ page }) => {
  await page.goto(url);
  const initialEngines = await page.evaluate(async moduleUrl => {
    const { IndexedDbProjectStorage, WorkingProject } = await import(moduleUrl) as typeof import('../../src/project/store.ts');
    const storage = new IndexedDbProjectStorage();
    const bytes = new Uint8Array([0, 128, 255, 8]);
    const one = WorkingProject.create(storage, {
      projectId: 'first', entryPath: '.\\main.tex', releaseId: 'release-a', files: [
        { kind: 'text', path: 'main.tex', text: 'Project one' },
        { kind: 'binary', path: 'img//figure.png', bytes },
      ],
    });
    const two = WorkingProject.create(storage, {
      projectId: 'second', entryPath: 'main.tex', engine: 'lualatex', bibliography: 'bibtex', releaseId: 'release-b',
      files: [{ kind: 'text', path: 'main.tex', text: 'Project two' }],
    });
    const engines = [one.snapshot.engine, two.snapshot.engine];
    bytes.fill(4);
    await Promise.all([one.save(), two.save()]);
    one.update({ engine: 'xelatex', bibliography: 'bibtex', releaseId: 'release-c' });
    await one.save();
    return engines;
  }, storeModule);
  expect(initialEngines).toEqual(['pdflatex', 'lualatex']);

  await page.reload();
  const saved = await page.evaluate(async moduleUrl => {
    const { IndexedDbProjectStorage, WorkingProject } = await import(moduleUrl) as typeof import('../../src/project/store.ts');
    const storage = new IndexedDbProjectStorage();
    const one = await WorkingProject.open(storage, 'first');
    const two = await WorkingProject.open(storage, 'second');
    if (!one || !two) throw new Error('A saved project is missing');
    const figure = one.snapshot.files[1];
    if (figure.kind !== 'binary') throw new Error('Binary figure was not restored');
    return {
      first: { ...one.snapshot, files: [one.snapshot.files[0]] }, second: two.snapshot,
      figure: { path: figure.path, bytes: [...new Uint8Array(await figure.bytes.arrayBuffer())] },
      frozen: Object.isFrozen(one.snapshot) && Object.isFrozen(one.snapshot.files) && Object.isFrozen(figure),
      savedRevisions: [one.savedRevision, two.savedRevision],
    };
  }, storeModule);
  expect(saved).toEqual({
    first: {
      projectId: 'first', revision: 2, entryPath: 'main.tex', engine: 'xelatex', bibliography: 'bibtex', releaseId: 'release-c',
      files: [{ kind: 'text', path: 'main.tex', text: 'Project one' }],
    },
    second: {
      projectId: 'second', revision: 1, entryPath: 'main.tex', engine: 'lualatex', bibliography: 'bibtex', releaseId: 'release-b',
      files: [{ kind: 'text', path: 'main.tex', text: 'Project two' }],
    },
    figure: { path: 'img/figure.png', bytes: [0, 128, 255, 8] }, frozen: true, savedRevisions: [2, 1],
  });
});

test('sequences delayed saves and prevents stale writes from another working copy', async ({ page }) => {
  await page.goto(url);
  const result = await page.evaluate(async moduleUrl => {
    const { IndexedDbProjectStorage, WorkingProject } = await import(moduleUrl) as typeof import('../../src/project/store.ts');
    type Snapshot = import('../../src/project/snapshot.ts').ProjectSnapshot;
    const database = new IndexedDbProjectStorage();
    let notifyStarted!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    let releaseFirstSave!: () => void;
    const firstSaveGate = new Promise<void>(resolve => { releaseFirstSave = resolve; });
    const calls: number[] = [];
    const completions: number[] = [];
    const storage = {
      load: (id: string) => database.load(id),
      async save(snapshot: Snapshot) {
        calls.push(snapshot.revision);
        if (snapshot.revision === 2) {
          notifyStarted();
          await firstSaveGate;
        }
        await database.save(snapshot);
        completions.push(snapshot.revision);
      },
    };
    const project = WorkingProject.create(storage, {
      projectId: 'delayed', entryPath: 'main.tex', releaseId: 'test',
      files: [{ kind: 'text', path: 'main.tex', text: 'saved' }],
    });
    await project.save();
    const stale = await WorkingProject.open(new IndexedDbProjectStorage(), 'delayed');
    if (!stale) throw new Error('Missing initial revision');
    stale.update({ engine: 'xelatex' });
    const firstEdit = project.update({ files: [{ kind: 'text', path: 'main.tex', text: 'first edit' }] });
    const firstSave = project.save();
    const latest = project.update({ files: [{ kind: 'text', path: 'main.tex', text: 'latest edit' }] });
    const secondSave = project.save();
    const settled = Promise.allSettled([firstSave, secondSave]);
    let duringDelay;
    let outcomes;
    const abort = AbortSignal.timeout(3_000);
    const timeout = new Promise<never>((_, reject) => abort.addEventListener('abort', () => reject(abort.reason), { once: true }));
    try {
      await Promise.race([started, timeout]);
      duringDelay = {
        working: project.snapshot.revision,
        saved: (await Promise.race([database.load('delayed'), timeout]))?.revision,
        calls: [...calls], completions: [...completions],
      };
    } finally {
      releaseFirstSave();
      outcomes = await settled;
    }
    const collision = await stale.save().then(() => '', error => error.message as string);
    return {
      duringDelay, calls, completions, outcomes: outcomes.map(item => item.status),
      firstEdit: firstEdit.files[0], latest: latest.files[0], collision,
      staleWorkingEngine: stale.snapshot.engine,
      persisted: await database.load('delayed'),
    };
  }, storeModule);
  expect(result.duringDelay).toEqual({ working: 3, saved: 1, calls: [1, 2], completions: [1] });
  expect(result.calls).toEqual([1, 2, 3]);
  expect(result.completions).toEqual([1, 2, 3]);
  expect(result.outcomes).toEqual(['fulfilled', 'fulfilled']);
  expect(result.firstEdit).toEqual({ kind: 'text', path: 'main.tex', text: 'first edit' });
  expect(result.latest).toEqual({ kind: 'text', path: 'main.tex', text: 'latest edit' });
  expect(result.collision).toContain('already has revision 3');
  expect(result.staleWorkingEngine).toBe('xelatex');
  expect(result.persisted).toMatchObject({ revision: 3, files: [result.latest], engine: 'pdflatex' });
});

test('compiles unsaved source after an aborted save while saved bytes remain recoverable', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.goto(url);
  const result = await page.evaluate(async moduleUrl => {
    const { IndexedDbProjectStorage, WorkingProject } = await import(moduleUrl) as typeof import('../../src/project/store.ts');
    const compilerModule: string = '/writedown/src/compiler/busytex.ts';
    const contractsModule: string = '/writedown/src/compiler/contracts.ts';
    const { BusyTexCompiler, compilerReleaseId } = await import(compilerModule) as typeof import('../../src/compiler/busytex.ts');
    const { createCompilationRequest } = await import(contractsModule) as typeof import('../../src/compiler/contracts.ts');
    const storage = new IndexedDbProjectStorage();
    const savedFile = { kind: 'text' as const, path: 'main.tex', text: String.raw`\documentclass{article}\begin{document}Saved source.\end{document}` };
    const editedFile = { ...savedFile, text: savedFile.text.replace('Saved source.', 'Unsaved local project edit.') };
    const project = WorkingProject.create(storage, {
      projectId: 'aborted', entryPath: savedFile.path, releaseId: compilerReleaseId, files: [savedFile],
    });
    await project.save();
    project.update({ files: [editedFile], entryPath: './main.tex' });

    // A successful put does not mean the transaction committed.
    const put = IDBObjectStore.prototype.put;
    let abortedAfterPut = false;
    IDBObjectStore.prototype.put = function (value, key) {
      const request = put.call(this, value, key);
      request.addEventListener('success', () => {
        this.transaction.abort();
        abortedAfterPut = true;
      }, { once: true });
      return request;
    };
    let failure: string | undefined;
    try {
      await project.save();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      IDBObjectStore.prototype.put = put;
    }

    const saved = await WorkingProject.open(new IndexedDbProjectStorage(), 'aborted');
    const afterFailure = { savedRevision: project.savedRevision, workingRevision: project.snapshot.revision,
      workingFile: project.snapshot.files[0], persistedRevision: saved?.snapshot.revision, persistedFile: saved?.snapshot.files[0] };
    const compiler = new BusyTexCompiler(new URL(`compiler/${compilerReleaseId}`, location.href).href);
    let pdf: number[];
    let compiledRevision: number;
    try {
      const result = await compiler.compile(createCompilationRequest(project.snapshot, { workerGeneration: 1, jobId: 'unsaved' }));
      if (result.status === 'failure') throw new Error(result.reason);
      compiledRevision = result.attempt.revision;
      pdf = [...new Uint8Array(await result.pdf.arrayBuffer())];
    } finally {
      compiler.terminate();
    }

    const finalFile = { ...editedFile, text: `${editedFile.text}\n% later local edit` };
    project.update({ files: [finalFile] });
    await project.save();
    const recovered = await storage.load('aborted');
    return { abortedAfterPut, failure, afterFailure, pdf, compiledRevision, final: recovered, finalFile, savedFile, editedFile };
  }, storeModule);
  expect(result.abortedAfterPut).toBe(true);
  expect(result.failure).toContain('Saving the local project was interrupted.');
  expect(result.afterFailure).toEqual({
    savedRevision: 1, workingRevision: 2, workingFile: result.editedFile,
    persistedRevision: 1, persistedFile: result.savedFile,
  });
  expect(result.compiledRevision).toBe(2);
  const pdfPath = testInfo.outputPath('unsaved.pdf');
  await writeFile(pdfPath, Buffer.from(result.pdf));
  const { stdout } = await promisify(execFile)('pdftotext', [pdfPath, '-']);
  expect(stdout).toContain('Unsaved local project edit.');
  expect(result.final).toMatchObject({ revision: 3, files: [result.finalFile] });
});
