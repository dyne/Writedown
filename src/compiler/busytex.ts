import { LuaLatex, PdfLatex, XeLatex } from 'texlyre-busytex';
import release from '../../compiler-release.json';
import type { CompilationFailure, CompilationRequest, CompilationResult, Diagnostic, PassLog, ResidentProjectCompiler } from './contracts.ts';
import { readCompilationDiagnostics } from './diagnostics.ts';
import { createCompilerPathMap } from './paths.ts';
import { BusyTexWorkerRunner } from './worker-runner.ts';

export const compilerReleaseId = release.id;

const tools = { pdflatex: PdfLatex, xelatex: XeLatex, lualatex: LuaLatex };
const missingBiberAssets = ['biber.js', 'biber.wasm', 'biber.data']
  .filter(name => !release.files.some(file => file.path === name));

/** One worker with the combined binaries and the local basic preload. */
export class BusyTexCompiler implements ResidentProjectCompiler {
  private readonly base: string;
  private runner: BusyTexWorkerRunner | undefined;
  private disposed = false;

  constructor(baseUrl: string) {
    this.base = baseUrl;
  }

  async initialize(): Promise<void> {
    if (this.disposed) throw new Error('BusyTeX compiler has been terminated.');
    const runner = this.runner ??= new BusyTexWorkerRunner(this.base);
    try {
      await runner.initialize();
    } catch (error) {
      this.discardRunner();
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not initialize the BusyTeX worker for ${compilerReleaseId} (busytex_worker.js): ${detail}`);
    }
  }

  async compile(request: CompilationRequest): Promise<CompilationResult> {
    const { snapshot, attempt } = request;
    const pathMap = createCompilerPathMap(snapshot);
    const failure = (reason: string, passLogs: readonly PassLog[] = [], diagnostics: readonly Diagnostic[] = []): CompilationFailure => ({
      status: 'failure', attempt, pathMap, reason, passLogs,
      diagnostics: diagnostics.some(item => item.severity === 'error')
        ? diagnostics
        : [{ severity: 'error', message: reason }, ...diagnostics],
    });

    if (snapshot.releaseId !== compilerReleaseId) {
      return failure(`Compiler release ${snapshot.releaseId} is unavailable. Installed release: ${compilerReleaseId}.`);
    }
    if (snapshot.bibliography === 'biber' && missingBiberAssets.length) {
      return failure(`Biber is unavailable in ${compilerReleaseId}. Missing assets: ${missingBiberAssets.join(', ')}.`);
    }
    const entry = snapshot.files.find(file => file.path === snapshot.entryPath);
    if (entry?.kind !== 'text') {
      return failure(`Select a TeX source file to compile: ${snapshot.entryPath}`);
    }

    try {
      await this.initialize();
      const runner = this.runner;
      if (!runner) throw new Error('BusyTeX compiler has been terminated.');

      // The pinned driver remounts its project MEMFS before writing these
      // files, then keeps that mount for every pass of this job.
      const additionalFiles = await Promise.all(snapshot.files.filter(file => file.path !== entry.path).map(async file => ({
        path: file.path,
        content: file.kind === 'text' ? file.text : new Uint8Array(await file.bytes.arrayBuffer()),
      })));
      const tool = new tools[snapshot.engine](runner);
      const result = await tool.compile({
        mainTexPath: entry.path,
        input: entry.text,
        additionalFiles,
        bibtex: snapshot.bibliography === 'bibtex',
        biber: snapshot.bibliography === 'biber',
        makeindex: true,
        rerun: true,
        shellEscape: false,
      });
      const passLogs = result.logs.map((log, index) => ({
        tool: log.cmd, pass: index + 1, text: JSON.stringify(log, null, 2), exitCode: log.exit_code,
      }));
      const diagnostics = readCompilationDiagnostics(result.logs, pathMap);
      const error = diagnostics.find(item => item.severity === 'error');
      if (error || !result.success || result.exitCode !== 0) {
        return failure(error?.message ?? `${snapshot.engine} exited with status ${result.exitCode}.`, passLogs, diagnostics);
      }
      if (!result.pdf?.length) {
        return failure(`${snapshot.engine} produced no PDF for ${entry.path}.`, passLogs, diagnostics);
      }
      return {
        status: 'success', attempt, pathMap, diagnostics, passLogs,
        pdf: new Blob([new Uint8Array(result.pdf)], { type: 'application/pdf' }),
        ...(result.synctex?.length ? { syncTex: new Blob([new Uint8Array(result.synctex)]) } : {}),
      };
    } catch (error) {
      // A runtime trap can bypass the driver's WASM memory reset.
      this.discardRunner();
      return { ...failure(error instanceof Error ? error.message : String(error)), workerFailed: true };
    }
  }

  private discardRunner(): void {
    this.runner?.terminate();
    this.runner = undefined;
  }

  isReady(): boolean {
    return this.runner?.isInitialized() ?? false;
  }

  terminate(): void {
    this.disposed = true;
    this.discardRunner();
  }
}
