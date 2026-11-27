import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { CompilationRequest, CompilationResult, ResidentProjectCompiler } from '../../src/compiler/contracts.ts';
import { CompilationService } from '../../src/compiler/service.ts';
import type { CompilationClock, CompilationState } from '../../src/compiler/service.ts';
import { createProjectSnapshot } from '../../src/project/snapshot.ts';
import type { TexEngine } from '../../src/project/snapshot.ts';

class ManualClock implements CompilationClock {
  time = 0;
  nextId = 0;
  readonly tasks = new Map<number, { at: number; fire: () => void }>();

  now(): number { return this.time; }

  after(ms: number, fire: () => void): () => void {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.time + ms, fire });
    return () => { this.tasks.delete(id); };
  }

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const next = [...this.tasks].sort(([, left], [, right]) => left.at - right.at)[0];
      if (!next || next[1].at > target) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.time = task.at;
      task.fire();
      await nextTurn();
    }
    this.time = target;
    await nextTurn();
  }
}

class Gate<T> {
  private finish!: (value: T) => void;
  private fail!: (reason: Error) => void;
  readonly promise = new Promise<T>((resolve, reject) => { this.finish = resolve; this.fail = reject; });
  resolve(value: T) { this.finish(value); }
  reject(message: string) { this.fail(new Error(message)); }
}

function proof(request: CompilationRequest): CompilationResult {
  return { status: 'success', attempt: request.attempt, diagnostics: [], passLogs: [], pdf: new Blob(['PDF']) };
}

function snapshot(revision: number, projectId = 'project', engine: TexEngine = 'pdflatex', releaseId = 'release') {
  return createProjectSnapshot({
    revision, projectId, engine, releaseId, bibliography: 'none', entryPath: 'main.tex',
    files: [{ kind: 'text', path: 'main.tex', text: 'Source ' + revision }],
  });
}

class ControlledWorker implements ResidentProjectCompiler {
  readonly init = new Gate<void>();
  readonly jobs: { request: CompilationRequest; reply: Gate<CompilationResult> }[] = [];
  initCalls = 0;
  terminations = 0;
  active = false;
  available = true;
  readonly #start: () => void;
  readonly #stop: () => void;

  constructor(start: () => void, stop: () => void) {
    this.#start = start;
    this.#stop = stop;
  }

  async initialize(): Promise<void> {
    this.initCalls++;
    this.enter();
    try {
      await this.init.promise;
    } finally {
      this.exit();
    }
  }

  async compile(request: CompilationRequest): Promise<CompilationResult> {
    this.enter();
    const reply = new Gate<CompilationResult>();
    this.jobs.push({ request, reply });
    try {
      return await reply.promise;
    } finally {
      this.exit();
    }
  }

  private enter() {
    assert.equal(this.active, false, 'initialize and compile are serialized');
    assert.equal(this.terminations, 0, 'retired workers cannot start more work');
    this.active = true;
    this.#start();
  }

  private exit() {
    if (this.active) {
      this.active = false;
      this.#stop();
    }
  }

  terminate() {
    this.terminations++;
    this.exit();
  }

  isReady() {
    return this.available && this.terminations === 0;
  }

  succeed(index = this.jobs.length - 1) {
    const job = this.jobs[index];
    job.reply.resolve(proof(job.request));
  }

  release() {
    this.init.resolve();
    for (let index = 0; index < this.jobs.length; index++) this.succeed(index);
  }
}

function fixture(t: TestContext, waitForFactory = false) {
  const clock = new ManualClock();
  const states: CompilationState[] = [];
  const workers: ControlledWorker[] = [];
  const factories: Gate<ResidentProjectCompiler>[] = [];
  let active = 0;
  let peak = 0;
  const service = new CompilationService(() => {
    const worker = new ControlledWorker(
      () => { peak = Math.max(peak, ++active); },
      () => { active--; },
    );
    workers.push(worker);
    if (!waitForFactory) return worker;
    const gate = new Gate<ResidentProjectCompiler>();
    factories.push(gate);
    return gate.promise;
  }, state => states.push(state), clock);
  const results = () => states.flatMap(state => state.status === 'settled' ? [state.result] : []);
  t.after(async () => {
    service.clear();
    for (const [index, gate] of factories.entries()) gate.resolve(workers[index]);
    for (const worker of workers) worker.release();
    await nextTurn();
    assert.equal(active, 0);
    assert.equal(clock.tasks.size, 0);
    assert(peak <= 1, 'no worker operations can overlap');
  });
  return { clock, states, workers, factories, service, results };
}

test('an edit fences running A immediately and only the latest B or C survives the debounce', async t => {
  const { service, clock, workers, states, results } = fixture(t);
  const a = snapshot(1);
  service.submit(a);
  await clock.advance(299);
  assert.equal(workers.length, 0);
  await clock.advance(1);
  const [worker] = workers;
  assert.equal(worker.initCalls, 1);
  worker.init.resolve();
  await nextTurn();
  assert.deepEqual(worker.jobs.map(job => job.request.snapshot), [a]);

  const b = snapshot(2);
  service.submit(b);
  assert.deepEqual(states.at(-1), { status: 'queued', snapshot: b });
  await clock.advance(100);
  worker.succeed();
  await nextTurn();
  assert.deepEqual(results(), []);
  assert.equal(worker.jobs.length, 1);

  const c = snapshot(3);
  service.submit(c);
  await clock.advance(299);
  assert.equal(worker.jobs.length, 1);
  await clock.advance(1);
  assert.deepEqual(worker.jobs.map(job => job.request.snapshot), [a, c]);
  assert.equal(worker.initCalls, 1);
  assert.equal(worker.terminations, 0);
  worker.succeed();
  await nextTurn();
  assert.deepEqual(results().map(result => result.attempt.revision), [3]);
});

test('a project switch cancels initialization and an old initialization cannot dispatch', async t => {
  const { service, clock, workers, results } = fixture(t);
  service.submit(snapshot(1, 'first'));
  await clock.advance(300);
  const [old] = workers;
  assert.equal(old.initCalls, 1);
  assert.equal(old.jobs.length, 0);

  const current = snapshot(1, 'second');
  service.submit(current);
  assert.equal(old.terminations, 1);
  await clock.advance(300);
  const replacement = workers[1];
  assert.equal(replacement.initCalls, 1);
  old.init.resolve();
  await nextTurn();
  assert.equal(old.jobs.length, 0);
  assert.deepEqual(results(), []);
  replacement.init.resolve();
  await nextTurn();
  assert.equal(replacement.jobs[0].request.snapshot, current);
  replacement.succeed();
  await nextTurn();
  assert.deepEqual(results().map(result => result.attempt.projectId), ['second']);
});

test('an engine or release change resets the resident worker and fences its context', async t => {
  const { service, clock, workers, results } = fixture(t);
  for (const [index, selected] of [
    snapshot(1), snapshot(2, 'project', 'xelatex'), snapshot(3, 'project', 'xelatex', 'other-release'),
  ].entries()) {
    service.submit(selected);
    if (index > 0) assert.equal(workers[index - 1].terminations, 1);
    await clock.advance(300);
    workers[index].init.resolve();
    await nextTurn();
    assert.equal(workers[index].jobs[0].request.snapshot, selected);
    workers[index].succeed();
    await nextTurn();
  }
  assert.deepEqual(results().map(({ attempt }) => [attempt.engine, attempt.releaseId, attempt.workerGeneration]),
    [['pdflatex', 'release', 1], ['xelatex', 'release', 2], ['xelatex', 'other-release', 3]]);
});

test('same-revision retry gets a new job and generation before the old reply arrives', async t => {
  const { service, clock, workers, results } = fixture(t);
  const selected = snapshot(1);
  service.submit(selected);
  await clock.advance(300);
  const [old] = workers;
  old.init.resolve();
  await nextTurn();
  assert.equal(old.jobs.length, 1);
  service.retry();
  await clock.advance(0);
  const successor = workers[1];
  successor.init.resolve();
  await nextTurn();
  assert.equal(successor.jobs.length, 1);
  const previous = old.jobs[0].request;
  const retry = successor.jobs[0].request;
  assert.equal(previous.snapshot, retry.snapshot);
  assert.notEqual(previous.attempt.jobId, retry.attempt.jobId);
  assert.notEqual(previous.attempt.workerGeneration, retry.attempt.workerGeneration);

  old.succeed();
  await nextTurn();
  assert.deepEqual(results(), []);
  successor.succeed();
  await nextTurn();
  assert.deepEqual(results().map(result => result.attempt), [retry.attempt]);
});

test('a hung initialization times out at 180 seconds and waits for an explicit retry', async t => {
  const { service, clock, workers, results } = fixture(t);
  const selected = snapshot(1);
  service.submit(selected);
  await clock.advance(300);
  assert.equal(workers[0].initCalls, 1);
  await clock.advance(179_999);
  assert.equal(workers[0].terminations, 0);
  assert.deepEqual(results(), []);
  await clock.advance(1);
  assert.equal(workers[0].terminations, 1);
  const failure = results()[0];
  assert.equal(failure.status, 'failure');
  assert.match(failure.reason, /initialization timed out after 180 seconds/);
  assert.equal(clock.tasks.size, 0);

  workers[0].init.reject('late initialization rejection');
  await clock.advance(360_000);
  assert.equal(workers.length, 1);
  assert.equal(results().length, 1);
  service.retry();
  await clock.advance(0);
  workers[1].init.resolve();
  await nextTurn();
  assert.equal(workers[1].jobs[0].request.snapshot, selected);
  workers[1].succeed();
  await nextTurn();
  assert.equal(results().at(-1)?.status, 'success');
});

test('compilation gets a separate 120-second deadline and releases a debounced queued revision', async t => {
  const { service, clock, workers, results } = fixture(t);
  service.submit(snapshot(1));
  await clock.advance(300);
  const [old] = workers;
  await clock.advance(170_000);
  old.init.resolve();
  await nextTurn();
  assert.equal(old.jobs.length, 1);

  const next = snapshot(2);
  service.submit(next);
  await clock.advance(119_999);
  assert.equal(old.terminations, 0, 'the compile deadline starts after initialization');
  assert.equal(workers.length, 1, 'an eligible revision must wait for the current job');
  await clock.advance(1);
  assert.equal(old.terminations, 1);
  assert.equal(workers[1].initCalls, 1);
  assert.deepEqual(results(), [], 'the superseded deadline must not publish a result');
  workers[1].init.resolve();
  await nextTurn();
  assert.equal(workers[1].jobs[0].request.snapshot, next);
  old.jobs[0].reply.reject('late compile rejection');
  workers[1].succeed();
  await nextTurn();
  assert.deepEqual(results().map(result => result.attempt.revision), [2]);
});

test('a native crash or inconsistent attempt reply retires the worker without retry loops', async t => {
  const { service, clock, workers, results } = fixture(t);
  const selected = snapshot(1);
  service.submit(selected);
  await clock.advance(300);
  workers[0].init.resolve();
  await nextTurn();
  workers[0].jobs[0].reply.reject('worker crashed');
  await nextTurn();
  assert.equal(workers[0].terminations, 1);
  const crash = results()[0];
  assert.equal(crash.status, 'failure');
  assert.equal(crash.reason, 'worker crashed');
  await clock.advance(240_000);
  assert.equal(workers.length, 1);

  service.retry();
  await clock.advance(0);
  workers[1].init.resolve();
  await nextTurn();
  const { request, reply } = workers[1].jobs[0];
  reply.resolve({ ...proof(request), attempt: { ...request.attempt, jobId: 'other-attempt' } });
  await nextTurn();
  const fenced = results().at(-1);
  assert.equal(fenced?.status, 'failure');
  assert.equal(fenced.attempt.jobId, request.attempt.jobId);
  assert.match(fenced.reason, /different compilation attempt/);
  assert.equal(workers[1].terminations, 1);
  assert.equal(clock.tasks.size, 0);
});

test('a stale async compiler factory cannot start a worker after the startup deadline', async t => {
  const { service, clock, workers, factories, results } = fixture(t, true);
  service.submit(snapshot(1));
  await clock.advance(300);
  assert.equal(factories.length, 1);
  assert.equal(workers[0].initCalls, 0);
  await clock.advance(180_000);
  assert.equal(results().at(-1)?.status, 'failure');
  assert.equal(clock.tasks.size, 0);
  service.retry();
  await clock.advance(0);
  factories[1].resolve(workers[1]);
  await nextTurn();

  factories[0].resolve(workers[0]);
  await nextTurn();
  assert.equal(workers[0].initCalls, 0);
  assert.equal(workers[0].terminations, 1);
  assert.equal(workers[1].initCalls, 1);
  workers[1].init.resolve();
  await nextTurn();
  workers[1].succeed();
  await nextTurn();
  assert.equal(results().at(-1)?.status, 'success');
});

test('an idle worker crash is replaced before dispatching the next eligible revision', async t => {
  const { service, clock, workers, results } = fixture(t);
  service.submit(snapshot(1));
  await clock.advance(300);
  workers[0].init.resolve();
  await nextTurn();
  workers[0].succeed();
  await nextTurn();
  workers[0].available = false;
  await clock.advance(300);
  assert.equal(workers.length, 1);

  service.submit(snapshot(2));
  await clock.advance(300);
  assert.equal(workers[0].terminations, 1);
  assert.equal(workers[0].jobs.length, 1);
  workers[1].init.resolve();
  await nextTurn();
  workers[1].succeed();
  await nextTurn();
  assert.deepEqual(results().map(result => [result.attempt.revision, result.attempt.workerGeneration]), [[1, 1], [2, 2]]);
});
