import { BusyTexRunner, ensureCacheVersion } from 'texlyre-busytex';
import type { CompileResult, LogEntry } from 'texlyre-busytex';

interface WorkerReply {
  initialized?: Record<string, string>;
  texlive_remote_written?: true;
  exception?: string;
  pdf?: Uint8Array | null;
  synctex?: Uint8Array | null;
  log?: string;
  exit_code?: number;
  logs?: LogEntry[];
}

function checkCacheVersion(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void ensureCacheVersion().then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

/**
 * Keep using the pinned BusyTeX tool classes and classic worker. Own the
 * transport here because the wrapper's terminate() cannot settle its requests,
 * clear their internal timers, or stop a cache check from spawning a worker.
 */
export class BusyTexWorkerRunner extends BusyTexRunner {
  private readonly base: string;
  private readonly lifetime = new AbortController();
  private ownedWorker: Worker | undefined;
  private ready = false;
  private cancelReply: ((error: Error) => void) | undefined;

  constructor(base: string) {
    super({ busytexBasePath: base, engineMode: 'combined' });
    this.base = base;
  }

  override async initialize(): Promise<void> {
    if (this.ready) return;
    const signal = this.lifetime.signal;
    await checkCacheVersion(signal);
    signal.throwIfAborted();

    const worker = this.ownedWorker = new Worker(this.base + '/busytex_worker.js');
    worker.onerror = event => {
      event.preventDefault();
      this.close(new Error(event.message || 'BusyTeX worker stopped unexpectedly.'));
    };
    worker.onmessageerror = () => this.close(new Error('Could not read the BusyTeX worker reply.'));
    await this.exchange(worker, {
      busytex_js: this.base + '/busytex.js',
      busytex_wasm: this.base + '/busytex.wasm',
      biber_js: this.base + '/biber.js',
      biber_wasm: this.base + '/biber.wasm',
      biber_data: this.base + '/biber.data',
      preload_data_packages_js: [this.base + '/texlive-basic.js'],
      data_packages_js: [],
      texmf_local: [],
      preload: true,
    }, reply => reply.initialized);
    signal.throwIfAborted();
    this.ready = true;
  }

  override isInitialized(): boolean {
    return this.ready;
  }

  get signal(): AbortSignal {
    return this.lifetime.signal;
  }

  async preloadDependency(name: string, contents: Uint8Array): Promise<void> {
    this.signal.throwIfAborted();
    if (!this.ready || !this.ownedWorker) throw new Error('BusyTeX worker is not ready.');
    await this.exchange(this.ownedWorker, {
      // kpathsea's tex file format, including LaTeX styles and classes.
      write_texlive_remote_files: [{ name, format: 26, contents }],
    }, reply => reply.texlive_remote_written === true ? true : undefined);
  }

  override async compile(...[
    files, mainTexPath, bibtex, biber, makeindex, rerun, verbose, driver,
    dataPackages, remoteEndpoint, shellEscape, shellHandlers,
  ]: Parameters<BusyTexRunner['compile']>): Promise<CompileResult> {
    this.signal.throwIfAborted();
    if (!this.ready || !this.ownedWorker) throw new Error('BusyTeX worker is not ready.');
    if (shellEscape || shellHandlers?.length) throw new Error('BusyTeX shell escape is disabled.');
    if (remoteEndpoint || dataPackages?.length) throw new Error('BusyTeX native dependency networking is disabled.');
    return this.exchange(this.ownedWorker, {
      files: files.map(file => ({ path: file.path, contents: file.content })),
      main_tex_path: mainTexPath,
      bibtex, biber, makeindex, rerun, verbose, driver,
      shell_escape: false,
    }, reply => {
      if (reply.pdf === undefined) return undefined;
      if (typeof reply.exit_code !== 'number' || typeof reply.log !== 'string' || !Array.isArray(reply.logs)) {
        throw new Error('Invalid BusyTeX compiler result.');
      }
      return {
        success: reply.exit_code === 0,
        pdf: reply.pdf ?? undefined,
        synctex: reply.synctex ?? undefined,
        log: reply.log,
        exitCode: reply.exit_code,
        logs: reply.logs,
      };
    });
  }

  private exchange<T>(worker: Worker, message: object, read: (reply: WorkerReply) => T | undefined): Promise<T> {
    if (this.cancelReply) return Promise.reject(new Error('The BusyTeX worker is busy.'));
    return new Promise((resolve, reject) => {
      const clear = () => {
        this.cancelReply = undefined;
        worker.onmessage = null;
      };
      const cancel = this.cancelReply = (error: Error) => {
        clear();
        reject(error);
      };
      worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
        if (this.cancelReply !== cancel || !data) return;
        try {
          if (data.exception) throw new Error(data.exception);
          const result = read(data);
          if (result === undefined) return;
          clear();
          resolve(result);
        } catch (error) {
          cancel(error instanceof Error ? error : new Error(String(error)));
        }
      };
      try {
        worker.postMessage(message);
      } catch (error) {
        cancel(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private close(reason: Error): void {
    this.lifetime.abort(reason);
    this.cancelReply?.(reason);
    this.ready = false;
    if (this.ownedWorker) {
      this.ownedWorker.onerror = this.ownedWorker.onmessageerror = this.ownedWorker.onmessage = null;
      this.ownedWorker.terminate();
      this.ownedWorker = undefined;
    }
  }

  override terminate(): void {
    this.close(new Error('BusyTeX worker terminated.'));
  }
}
