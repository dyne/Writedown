import catalog from '../../compiler-dependencies.json' with { type: 'json' };
import release from '../../compiler-release.json' with { type: 'json' };
import type { Diagnostic } from './contracts.ts';

if (catalog.schemaVersion !== 1 || catalog.releaseId !== release.id) {
  throw new Error('The TeX dependency catalog does not match the compiler release.');
}

export type TexDependency = (typeof catalog.files)[number];
export const dependencyFiles: readonly TexDependency[] = catalog.files;

export function dependencyPath(file: TexDependency): string {
  return `${catalog.releaseId}/${file.sha256}/${file.name}`;
}

export function missingTexDependency(diagnostics: readonly Diagnostic[]): TexDependency | undefined {
  const error = diagnostics.find(diagnostic => diagnostic.severity === 'error');
  // Only an exact, required TeX style/class miss from the local driver can
  // select a catalog entry. Paths and other engine lookups stay local.
  const name = error?.message.match(/^LaTeX Error: File `([a-zA-Z0-9_-]+\.(?:sty|cls))' not found\.$/)?.[1];
  return dependencyFiles.find(file => file.name === name);
}
