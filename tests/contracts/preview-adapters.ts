import type {
  CompilationRequest,
  CompilationResult,
  ProjectCompiler,
} from '../../src/compiler/contracts.ts';
import type { PreviewViewer } from '../../src/viewer/contracts.ts';

export const compilerAdapter: ProjectCompiler = {
  async compile(request: CompilationRequest): Promise<CompilationResult> {
    return {
      status: 'success',
      attempt: request.attempt,
      pdf: new Blob(['%PDF-fixture'], { type: 'application/pdf' }),
      syncTex: new Blob(['SyncTeX fixture']),
      diagnostics: [],
      passLogs: [{ tool: request.snapshot.engine, pass: 1, text: 'fixture pass', exitCode: 0 }],
    };
  },
};

export class ViewerAdapter implements PreviewViewer {
  current: CompilationResult | undefined;

  present(result: CompilationResult): void {
    this.current = result;
  }
}

/** Compiled by typecheck; intentionally never called at runtime. */
export function assertContractTypes(request: CompilationRequest, result: CompilationResult) {
  // @ts-expect-error A captured revision cannot be changed by a consumer.
  request.snapshot.revision = 9;
  // @ts-expect-error Snapshot file lists cannot be edited.
  request.snapshot.files.push({ kind: 'text', path: 'other.tex', text: '' });
  if (result.status === 'failure') {
    const reason: string = result.reason;
    // @ts-expect-error Failure is not a PDF result.
    const pdf: Blob = result.pdf;
    return { reason, pdf };
  }
  const pdf: Blob = result.pdf;
  const syncTex: Blob | undefined = result.syncTex;
  return { pdf, syncTex };
}
