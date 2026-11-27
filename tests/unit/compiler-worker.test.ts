import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { PdfLatex } from 'texlyre-busytex';
import { BusyTexWorkerRunner } from '../../src/compiler/worker-runner.ts';

class ControlledNativeWorker {
  onmessage: ((event: { data: object }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly messages: object[] = [];
  terminations = 0;

  postMessage(message: object) { this.messages.push(message); }
  terminate() { this.terminations++; }
}

function replaceGlobal(t: TestContext, key: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { value, configurable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, key, previous);
    else Reflect.deleteProperty(globalThis, key);
  });
}

function fixture(t: TestContext, holdCache = false) {
  const workers: ControlledNativeWorker[] = [];
  const deletes: { onsuccess?: () => void }[] = [];
  replaceGlobal(t, 'Worker', class extends ControlledNativeWorker {
    constructor() { super(); workers.push(this); }
  });
  replaceGlobal(t, 'localStorage', { getItem: () => holdCache ? null : '1.4', setItem() {} });
  replaceGlobal(t, 'indexedDB', { deleteDatabase() {
    const operation: { onsuccess?: () => void } = {};
    deletes.push(operation);
    return operation;
  } });
  const runner = new BusyTexWorkerRunner('http://127.0.0.1/compiler');
  t.after(async () => {
    runner.terminate();
    for (const operation of deletes) operation.onsuccess?.();
    await nextTurn();
    assert(workers.every(worker => worker.terminations === 1));
  });
  return { runner, workers, deletes };
}

test('terminating during the cache preflight settles startup and prevents a late native worker', async t => {
  const { runner, workers, deletes } = fixture(t, true);
  const starting = runner.initialize();
  const outcome = assert.rejects(starting, /worker terminated/);
  assert.equal(deletes.length, 1);
  assert.equal(workers.length, 0);
  runner.terminate();
  await outcome;

  deletes[0].onsuccess?.();
  await nextTurn();
  assert.equal(workers.length, 0);
  assert.equal(runner.isInitialized(), false);
});

test('terminating after worker creation settles a pending preload and removes native callbacks', async t => {
  const { runner, workers } = fixture(t);
  const starting = runner.initialize();
  const outcome = assert.rejects(starting, /worker terminated/);
  await nextTurn();
  const [worker] = workers;
  assert.equal(worker.messages.length, 1);
  assert.match(JSON.stringify(worker.messages[0]), /texlive-basic\.js/);
  const oldReply = worker.onmessage;
  assert.ok(oldReply);

  runner.terminate();
  await outcome;
  assert.equal(worker.terminations, 1);
  assert.equal(worker.onmessage, null);
  assert.equal(worker.onerror, null);
  assert.equal(worker.onmessageerror, null);
  oldReply({ data: { initialized: {} } });
  assert.equal(runner.isInitialized(), false);
});

test('a native worker crash rejects the pending compile and removes every callback', async t => {
  const { runner, workers } = fixture(t);
  const starting = runner.initialize();
  void starting.catch(() => {});
  await nextTurn();
  const [worker] = workers;
  worker.onmessage?.({ data: { initialized: {} } });
  await starting;
  assert.equal(runner.isInitialized(), true);

  const compiling = new PdfLatex(runner).compile({ input: 'document', mainTexPath: 'main.tex' });
  const outcome = assert.rejects(compiling, /native failure/);
  assert.equal(worker.messages.length, 2);
  const oldReply = worker.onmessage;
  assert.ok(oldReply);
  assert.ok(worker.onerror);
  worker.onerror({ message: 'native failure', preventDefault() {} });
  await outcome;

  assert.equal(worker.terminations, 1);
  assert.equal(runner.isInitialized(), false);
  assert.equal(worker.onmessage, null);
  assert.equal(worker.onerror, null);
  assert.equal(worker.onmessageerror, null);
  oldReply({ data: { pdf: new Uint8Array([1]), exit_code: 0, log: '', logs: [] } });
});
