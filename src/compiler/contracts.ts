import type { ProjectSnapshot, TexEngine } from '../project/snapshot.ts';
import type { CompilerPathMap } from './paths.ts';

/** A job ID is unique within a worker generation, including retries. */
export interface CompilationAttempt {
  readonly projectId: string;
  readonly revision: number;
  readonly engine: TexEngine;
  readonly releaseId: string;
  readonly workerGeneration: number;
  readonly jobId: string;
}

export interface CompilationRequest {
  readonly snapshot: ProjectSnapshot;
  readonly attempt: CompilationAttempt;
}

export function createCompilationRequest(
  snapshot: ProjectSnapshot,
  submission: Pick<CompilationAttempt, 'workerGeneration' | 'jobId'>,
): CompilationRequest {
  return Object.freeze({
    snapshot,
    attempt: Object.freeze({
      projectId: snapshot.projectId,
      revision: snapshot.revision,
      engine: snapshot.engine,
      releaseId: snapshot.releaseId,
      workerGeneration: submission.workerGeneration,
      jobId: submission.jobId,
    }),
  });
}

export interface Diagnostic {
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
}

export interface PassLog {
  readonly tool: string;
  readonly pass: number;
  readonly text: string;
  /** null when the tool did not return an exit status. */
  readonly exitCode: number | null;
}

interface CompilationOutcome {
  readonly attempt: CompilationAttempt;
  readonly diagnostics: readonly Diagnostic[];
  readonly passLogs: readonly PassLog[];
  /** Paths for this attempt, including the directory of its selected entry. */
  readonly pathMap?: CompilerPathMap;
}

export interface CompilationSuccess extends CompilationOutcome {
  readonly status: 'success';
  readonly pdf: Blob;
  /** When present, produced by the same attempt as pdf. */
  readonly syncTex?: Blob;
}

export interface CompilationFailure extends CompilationOutcome {
  readonly status: 'failure';
  readonly reason: string;
  /** The compiler session must be replaced before another job. */
  readonly workerFailed?: true;
}

export type CompilationResult = CompilationSuccess | CompilationFailure;

export interface ProjectCompiler {
  compile(request: CompilationRequest): Promise<CompilationResult>;
}

export interface ResidentProjectCompiler extends ProjectCompiler {
  initialize(): Promise<void>;
  isReady(): boolean;
  terminate(): void;
}
