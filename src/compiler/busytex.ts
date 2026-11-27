import { LuaLatex, PdfLatex, XeLatex } from 'texlyre-busytex';
import release from '../../compiler-release.json';
import { isMarkdownPath, sourceFormat } from '../project/snapshot.ts';
import type { ProjectSnapshot } from '../project/snapshot.ts';
import type { CompilationFailure, CompilationRequest, CompilationResult, Diagnostic, PassLog, ResidentProjectCompiler } from './contracts.ts';
import { missingTexDependency } from './dependency-catalog.ts';
import { TexDependencyStore } from './dependency-store.ts';
import { readCompilationDiagnostics } from './diagnostics.ts';
import { createCompilerPathMap } from './paths.ts';
import { BusyTexWorkerRunner } from './worker-runner.ts';

export const compilerReleaseId = release.id;

const tools = { pdflatex: PdfLatex, xelatex: XeLatex, lualatex: LuaLatex };
const missingBiberAssets = ['biber.js', 'biber.wasm', 'biber.data']
  .filter(name => !release.files.some(file => file.path === name));

function generatedEntryPath(snapshot: ProjectSnapshot): string {
  const directory = snapshot.entryPath.slice(0, snapshot.entryPath.lastIndexOf('/') + 1);
  const occupied = new Set(snapshot.files.map(file => file.path));
  let path = directory + 'writedown-preview.tex';
  for (let suffix = 2; occupied.has(path); suffix++) {
    path = directory + 'writedown-preview-' + suffix + '.tex';
  }
  return path;
}

/** One worker with the combined binaries and the local basic preload. */
export class BusyTexCompiler implements ResidentProjectCompiler {
  private readonly base: string;
  private readonly dependencies: TexDependencyStore;
  private readonly dependencyWarnings = new Map<string, Diagnostic>();
  private runner: BusyTexWorkerRunner | undefined;
  private disposed = false;

  constructor(baseUrl: string, dependencyEndpoint?: string) {
    this.base = baseUrl;
    this.dependencies = new TexDependencyStore(baseUrl, dependencyEndpoint);
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
    let pathMap = createCompilerPathMap(snapshot);
    const passLogs: PassLog[] = [];
    const failure = (reason: string, diagnostics: readonly Diagnostic[] = []): CompilationFailure => ({
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
      return failure(`Select a source document to compile: ${snapshot.entryPath}`);
    }

    const isMarkdown = sourceFormat(entry) === 'markdown';
    let mainTexPath = entry.path;
    let input = entry.text;
    if (isMarkdown || isMarkdownPath(entry.path)) {
      mainTexPath = generatedEntryPath(snapshot);
      let sourceLines: readonly (number | undefined)[] | undefined;
      if (isMarkdown) {
        const { markdownDocument, UnclosedTexSection } = await import('./markdown.ts');
        try {
          const generated = markdownDocument(input);
          input = generated.tex;
          sourceLines = generated.sourceLines;
        } catch (error) {
          if (!(error instanceof UnclosedTexSection)) throw error;
          return failure(error.message, [{ severity: 'error', message: error.message, path: entry.path, line: error.line }]);
        }
      }
      pathMap = createCompilerPathMap(snapshot, { path: mainTexPath, sourceLines });
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
      const options = {
        mainTexPath,
        input,
        additionalFiles,
        bibtex: snapshot.bibliography === 'bibtex',
        biber: snapshot.bibliography === 'biber',
        makeindex: true,
        rerun: true,
        shellEscape: false,
      };
      const preloaded = new Set<string>();

      for (;;) {
        const result = await tool.compile(options);
        for (const log of result.logs) {
          passLogs.push({ tool: log.cmd, pass: passLogs.length + 1, text: JSON.stringify(log, null, 2), exitCode: log.exit_code });
        }
        const texDiagnostics = readCompilationDiagnostics(result.logs, pathMap);
        const diagnostics = [...this.dependencyWarnings.values(), ...texDiagnostics];
        const dependency = missingTexDependency(texDiagnostics);
        if (dependency && !preloaded.has(dependency.name)) {
          // A complete local pass has already considered the snapshot, bundled
          // files, and dependencies registered in this worker.
          let resource: Awaited<ReturnType<TexDependencyStore['load']>>;
          try {
            resource = await this.dependencies.load(dependency, runner.signal);
          } catch (error) {
            runner.signal.throwIfAborted();
            const message = error instanceof Error ? error.message : String(error);
            return failure(message, [{ severity: 'error', message }, ...diagnostics]);
          }
          if (resource.warning) {
            this.dependencyWarnings.set(dependency.name, {
              severity: 'warning', code: 'dependency-cache-write', message: resource.warning,
            });
          } else {
            this.dependencyWarnings.delete(dependency.name);
          }
          await runner.preloadDependency(dependency.name, resource.contents);
          preloaded.add(dependency.name);
          continue;
        }
        const error = texDiagnostics.find(item => item.severity === 'error');
        if (error || !result.success || result.exitCode !== 0) {
          return failure(error?.message ?? `${snapshot.engine} exited with status ${result.exitCode}.`, diagnostics);
        }
        if (!result.pdf?.length) {
          return failure(`${snapshot.engine} produced no PDF for ${entry.path}.`, diagnostics);
        }
        return {
          status: 'success', attempt, pathMap, diagnostics, passLogs,
          pdf: new Blob([new Uint8Array(result.pdf)], { type: 'application/pdf' }),
          ...(result.synctex?.length ? { syncTex: new Blob([new Uint8Array(result.synctex)]) } : {}),
        };
      }
    } catch (error) {
      // A runtime trap can bypass the driver's WASM memory reset.
      this.discardRunner();
      return { ...failure(error instanceof Error ? error.message : String(error)), workerFailed: true };
    }
  }

  private discardRunner(): void {
    this.runner?.terminate();
    this.runner = undefined;
    this.dependencyWarnings.clear();
  }

  isReady(): boolean {
    return this.runner?.isInitialized() ?? false;
  }

  terminate(): void {
    this.disposed = true;
    this.discardRunner();
  }
}
