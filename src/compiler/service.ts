import { createCompilationRequest } from './contracts.ts';
import type { CompilationAttempt, CompilationRequest, CompilationResult, ResidentProjectCompiler } from './contracts.ts';
import type { ProjectSnapshot } from '../project/snapshot.ts';

export type CompilationState =
  | { readonly status: 'idle' }
  | { readonly status: 'queued'; readonly snapshot: ProjectSnapshot }
  | { readonly status: 'initializing' | 'compiling'; readonly snapshot: ProjectSnapshot; readonly attempt: CompilationAttempt }
  | { readonly status: 'settled'; readonly snapshot: ProjectSnapshot; readonly result: CompilationResult };

export interface CompilationClock {
  now(): number;
  after(ms: number, callback: () => void): () => void;
}

const browserClock: CompilationClock = {
  now: () => performance.now(),
  after(ms, callback) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

const debounceMs = 300;
const initializeMs = 180_000;
const compileMs = 120_000;

interface WorkerSession {
  readonly generation: number;
  compiler?: ResidentProjectCompiler;
  ready: boolean;
}

interface ActiveJob {
  readonly request: CompilationRequest;
  readonly session: WorkerSession;
  readonly cancellation: AbortController;
}

function sameContext(left: ProjectSnapshot, right: ProjectSnapshot): boolean {
  return left.projectId === right.projectId && left.engine === right.engine && left.releaseId === right.releaseId;
}

function sameAttempt(left: CompilationAttempt, right: CompilationAttempt): boolean {
  return left.projectId === right.projectId && left.revision === right.revision &&
    left.engine === right.engine && left.releaseId === right.releaseId &&
    left.workerGeneration === right.workerGeneration && left.jobId === right.jobId;
}

/** Serial owner of the initialized compiler and its single queued snapshot. */
export class CompilationService {
  private readonly createCompiler: (snapshot: ProjectSnapshot) => ResidentProjectCompiler | Promise<ResidentProjectCompiler>;
  private readonly publish: (state: CompilationState) => void;
  private readonly clock: CompilationClock;
  private current: ProjectSnapshot | undefined;
  private pending: { snapshot: ProjectSnapshot; due: number } | undefined;
  private session: WorkerSession | undefined;
  private job: ActiveJob | undefined;
  private cancelDebounce: (() => void) | undefined;
  private generation = 0;
  private jobNumber = 0;

  constructor(
    createCompiler: (snapshot: ProjectSnapshot) => ResidentProjectCompiler | Promise<ResidentProjectCompiler>,
    publish: (state: CompilationState) => void,
    clock: CompilationClock = browserClock,
  ) {
    this.createCompiler = createCompiler;
    this.publish = publish;
    this.clock = clock;
  }

  submit(snapshot: ProjectSnapshot): void {
    const previous = this.current;
    this.current = snapshot;
    if (previous && !sameContext(previous, snapshot)) this.resetSession();
    this.queue(snapshot, debounceMs);
  }

  retry(): void {
    if (!this.current) return;
    this.resetSession();
    this.queue(this.current, 0);
  }

  clear(): void {
    this.current = this.pending = undefined;
    this.cancelDebounce?.();
    this.cancelDebounce = undefined;
    this.resetSession();
    this.publish({ status: 'idle' });
  }

  private queue(snapshot: ProjectSnapshot, delay: number): void {
    this.cancelDebounce?.();
    this.cancelDebounce = undefined;
    this.pending = { snapshot, due: this.clock.now() + delay };
    // Consumers invalidate the prior revision before the debounce begins.
    this.publish({ status: 'queued', snapshot });
    this.dispatch();
  }

  private dispatch(): void {
    if (!this.pending || this.job) return;
    const { snapshot, due } = this.pending;
    const delay = due - this.clock.now();
    if (delay > 0) {
      this.cancelDebounce = this.clock.after(delay, () => {
        this.cancelDebounce = undefined;
        this.dispatch();
      });
      return;
    }

    this.pending = undefined;
    if (this.session?.ready && !this.session.compiler?.isReady()) this.retire(this.session);
    const session = this.session ??= { generation: ++this.generation, ready: false };
    const request = createCompilationRequest(snapshot, {
      workerGeneration: session.generation,
      jobId: String(++this.jobNumber),
    });
    const job = this.job = { request, session, cancellation: new AbortController() };
    void this.run(job);
  }

  private async run(job: ActiveJob): Promise<void> {
    const { request: { snapshot, attempt }, session, cancellation } = job;
    try {
      if (!session.ready) {
        this.publish({ status: 'initializing', snapshot, attempt });
        await this.withDeadline(job, initializeMs, 'Compiler initialization timed out after 180 seconds.', async () => {
          const compiler = await this.createCompiler(snapshot);
          if (cancellation.signal.aborted) {
            compiler.terminate();
            return;
          }
          session.compiler = compiler;
          await compiler.initialize();
        });
        session.ready = true;
      }
      if (this.job !== job || this.current !== snapshot) return;

      const compiler = session.compiler;
      if (!compiler) throw new Error('Compiler session is unavailable.');
      this.publish({ status: 'compiling', snapshot, attempt });
      const result = await this.withDeadline(job, compileMs, 'Compilation timed out after 120 seconds.',
        () => compiler.compile(job.request));
      if (this.job !== job) return;
      if (!sameAttempt(attempt, result.attempt)) throw new Error('The worker replied for a different compilation attempt.');
      if (result.status === 'failure' && result.workerFailed) this.retire(session);
      if (this.current === snapshot) this.publish({ status: 'settled', snapshot, result });
    } catch (error) {
      if (this.job !== job) return;
      this.retire(session);
      if (this.current === snapshot) {
        const reason = error instanceof Error ? error.message : String(error);
        this.publish({
          status: 'settled', snapshot,
          result: {
            status: 'failure', attempt, reason, workerFailed: true,
            diagnostics: [{ severity: 'error', message: reason }], passLogs: [],
          },
        });
      }
    } finally {
      if (this.job === job) {
        this.job = undefined;
        this.dispatch();
      }
    }
  }

  private withDeadline<T>(job: ActiveJob, ms: number, message: string, action: () => Promise<T>): Promise<T> {
    const signal = job.cancellation.signal;
    const deadline = this.clock.now() + ms;
    const expire = () => job.cancellation.abort(new Error(message));
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let waiting = true;
      const stopTimer = this.clock.after(ms, expire);
      const finish = (settle: () => void) => {
        if (!waiting) return;
        waiting = false;
        stopTimer();
        signal.removeEventListener('abort', abort);
        settle();
      };
      const abort = () => finish(() => reject(signal.reason));
      const complete = (settle: () => void) => {
        if (!waiting) return;
        if (this.clock.now() >= deadline) expire();
        else finish(settle);
      };
      signal.addEventListener('abort', abort, { once: true });
      void Promise.resolve().then(() => {
        signal.throwIfAborted();
        return action();
      }).then(
        result => complete(() => resolve(result)),
        error => complete(() => reject(error)),
      );
    });
  }

  private resetSession(): void {
    const job = this.job;
    this.job = undefined;
    job?.cancellation.abort(new Error('Compilation was superseded.'));
    if (this.session) this.retire(this.session);
  }

  private retire(session: WorkerSession): void {
    if (this.session === session) this.session = undefined;
    session.compiler?.terminate();
  }
}
