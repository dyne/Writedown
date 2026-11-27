import type { CompilationResult } from '../compiler/contracts.ts';

/** The viewer depends only on result data, never on a compiler implementation. */
export interface PreviewViewer {
  present(result: CompilationResult): void | Promise<void>;
}
