import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectSnapshot } from '../../src/project/snapshot.ts';
import { createCompilationRequest } from '../../src/compiler/contracts.ts';
import type { CompilationFailure } from '../../src/compiler/contracts.ts';
import { compilerAdapter, ViewerAdapter } from '../contracts/preview-adapters.ts';

test('snapshot owns text, binary bytes and revision after editor buffers change', async () => {
  const text = { kind: 'text' as const, path: 'main.tex', text: 'Original text' };
  const bytes = new Uint8Array([0, 128, 255]);
  const figure = { kind: 'binary' as const, path: 'figure.png', bytes };
  const input = {
    projectId: 'project-a', revision: 3, entryPath: 'main.tex', files: [text, figure],
    engine: 'pdflatex' as const, bibliography: 'bibtex' as const, releaseId: 'test-release',
  };
  const snapshot = createProjectSnapshot(input);
  text.text = 'Edited text';
  text.path = 'renamed.tex';
  bytes.fill(7);
  figure.bytes = new Uint8Array([1]);
  input.files.length = 0;
  input.revision = 4;
  input.releaseId = 'later-release';

  assert.equal(snapshot.revision, 3);
  assert.equal(snapshot.releaseId, 'test-release');
  assert.equal(snapshot.entryPath, 'main.tex');
  assert.deepEqual(snapshot.files[0], { kind: 'text', path: 'main.tex', text: 'Original text' });
  const binary = snapshot.files[1];
  assert.equal(binary.kind, 'binary');
  if (binary.kind !== 'binary') throw new Error('Expected binary fixture');
  const readBytes = new Uint8Array(await binary.bytes.arrayBuffer());
  assert.deepEqual([...readBytes], [0, 128, 255]);
  readBytes.fill(9);
  assert.deepEqual([...new Uint8Array(await binary.bytes.arrayBuffer())], [0, 128, 255]);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.files));
  assert.ok(snapshot.files.every(Object.isFrozen));
  assert.equal(Reflect.set(snapshot, 'revision', 100), false);
  const transferred = structuredClone(snapshot);
  const transferredBinary = transferred.files[1];
  if (transferredBinary.kind !== 'binary') throw new Error('Expected cloned binary');
  assert.deepEqual([...new Uint8Array(await transferredBinary.bytes.arrayBuffer())], [0, 128, 255]);
});

test('submission identifies retries and worker replacement at the same revision', () => {
  const snapshot = createProjectSnapshot({
    projectId: 'project-a', revision: 3, entryPath: 'main.tex', files: [],
    engine: 'pdflatex', bibliography: 'none', releaseId: 'release-a',
  });
  const first = createCompilationRequest(snapshot, { workerGeneration: 1, jobId: 'job-1' });
  const retry = createCompilationRequest(snapshot, { workerGeneration: 1, jobId: 'job-2' });
  const replacement = createCompilationRequest(snapshot, { workerGeneration: 2, jobId: 'job-1' });
  assert.notDeepEqual(first.attempt, retry.attempt);
  assert.notDeepEqual(first.attempt, replacement.attempt);
  assert.deepEqual(first.attempt, {
    projectId: 'project-a', revision: 3, engine: 'pdflatex', releaseId: 'release-a', workerGeneration: 1, jobId: 'job-1',
  });
  assert.equal(first.snapshot, snapshot);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.attempt));
});

test('compiler and viewer adapters exchange success and failure using shared contracts', async () => {
  const snapshot = createProjectSnapshot({
    projectId: 'project-a', revision: 3, entryPath: 'main.tex', files: [],
    engine: 'pdflatex', bibliography: 'none', releaseId: 'release-a',
  });
  const request = createCompilationRequest(snapshot, { workerGeneration: 1, jobId: 'job-1' });
  const success = await compilerAdapter.compile(request);
  const viewer = new ViewerAdapter();
  viewer.present(success);
  assert.equal(viewer.current, success);
  assert.equal(success.status, 'success');
  if (success.status !== 'success') throw new Error('Expected success fixture');
  assert.equal(await success.pdf.text(), '%PDF-fixture');
  assert.equal(await success.syncTex?.text(), 'SyncTeX fixture');
  assert.equal(success.attempt, request.attempt);
  assert.equal(success.passLogs[0].exitCode, 0);

  const failure: CompilationFailure = {
    status: 'failure', attempt: request.attempt, reason: 'Undefined control sequence',
    diagnostics: [{ severity: 'error', message: 'Undefined control sequence', path: 'main.tex', line: 2 }],
    passLogs: [{ tool: 'pdflatex', pass: 1, text: '! Undefined control sequence', exitCode: 1 }],
  };
  viewer.present(failure);
  assert.equal(viewer.current, failure);
  assert.equal(viewer.current.attempt, request.attempt);
});
