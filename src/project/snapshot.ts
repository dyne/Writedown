export type TexEngine = 'pdflatex' | 'xelatex' | 'lualatex';
export type BibliographyMode = 'none' | 'bibtex' | 'biber';

export interface TextFile {
  readonly kind: 'text';
  readonly path: string;
  readonly text: string;
}

export interface BinaryFile {
  readonly kind: 'binary';
  readonly path: string;
  /** Blob owns immutable bytes and can be structured-cloned to a worker. */
  readonly bytes: Blob;
}

export type ProjectFile = TextFile | BinaryFile;

export interface ProjectSnapshot {
  readonly projectId: string;
  readonly revision: number;
  readonly entryPath: string;
  readonly files: readonly ProjectFile[];
  readonly engine: TexEngine;
  readonly bibliography: BibliographyMode;
  readonly releaseId: string;
}

export interface ProjectSnapshotInput extends Omit<ProjectSnapshot, 'files'> {
  readonly files: readonly (TextFile | {
    readonly kind: 'binary';
    readonly path: string;
    readonly bytes: Uint8Array;
  })[];
}

/** Capture editor state once; no mutable file or byte buffer is retained. */
export function createProjectSnapshot(input: ProjectSnapshotInput): ProjectSnapshot {
  const files = input.files.map((file): ProjectFile => file.kind === 'text'
    ? Object.freeze({ kind: 'text', path: file.path, text: file.text })
    : Object.freeze({ kind: 'binary', path: file.path, bytes: new Blob([new Uint8Array(file.bytes)]) }));
  return Object.freeze({
    projectId: input.projectId,
    revision: input.revision,
    entryPath: input.entryPath,
    files: Object.freeze(files),
    engine: input.engine,
    bibliography: input.bibliography,
    releaseId: input.releaseId,
  });
}
