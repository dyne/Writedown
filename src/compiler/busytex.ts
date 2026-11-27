import { BusyTexRunner } from 'texlyre-busytex';
import release from '../../compiler-release.json';
import type { CompilationRequest, CompilationResult, ProjectCompiler } from './contracts.ts';

export const compilerReleaseId = release.id;

/** Qualified baseline: pdfLaTeX, local basic preload, no dependency endpoint. */
export class BusyTexCompiler implements ProjectCompiler {
  private runner: BusyTexRunner;

  constructor(baseUrl: string) {
    this.runner = new BusyTexRunner({
      busytexBasePath: baseUrl,
      engineMode: 'combined',
      preloadDataPackages: [`${baseUrl}/texlive-basic.js`],
      catalogDataPackages: [],
      initRetries: 0,
    });
  }

  async compile(request: CompilationRequest): Promise<CompilationResult> {
    const { snapshot, attempt } = request;
    if (snapshot.releaseId !== compilerReleaseId || snapshot.engine !== 'pdflatex' || snapshot.bibliography !== 'none') {
      return { status: 'failure', attempt, reason: 'This compiler proof supports the pinned pdfLaTeX release without bibliography.', diagnostics: [], passLogs: [] };
    }
    try {
      await this.runner.initialize(true);
      const files = await Promise.all(snapshot.files.map(async file => ({
        path: file.path,
        content: file.kind === 'text' ? file.text : new Uint8Array(await file.bytes.arrayBuffer()),
      })));
      const result = await this.runner.compile(
        files, snapshot.entryPath, false, false, false, false,
        'silent', 'pdftex_bibtex8', [], '', false,
      );
      const passLogs = result.logs.map((log, index) => ({
        tool: log.cmd, pass: index + 1, text: JSON.stringify(log, null, 2), exitCode: log.exit_code,
      }));
      if (!result.success || result.exitCode !== 0 || !result.pdf?.length) {
        const reason = result.log || `pdfLaTeX exited with status ${result.exitCode}`;
        return { status: 'failure', attempt, reason, diagnostics: [{ severity: 'error', message: reason }], passLogs };
      }
      return {
        status: 'success', attempt, diagnostics: [], passLogs,
        pdf: new Blob([new Uint8Array(result.pdf)], { type: 'application/pdf' }),
        ...(result.synctex?.length ? { syncTex: new Blob([new Uint8Array(result.synctex)]) } : {}),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { status: 'failure', attempt, reason, diagnostics: [{ severity: 'error', message: reason }], passLogs: [] };
    }
  }

  terminate(): void { this.runner.terminate(); }
}
