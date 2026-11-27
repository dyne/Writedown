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
    readonly bytes: Uint8Array | Blob;
  })[];
}

export function normalizeProjectPath(path: string): string {
  const relative = path.replaceAll('\\', '/');
  const invalidPath = () => new Error(`Invalid project path: ${JSON.stringify(path)}`);
  if (relative.startsWith('/') || /^[a-z]:/i.test(relative) || relative.includes('\0')) throw invalidPath();

  const segments: string[] = [];
  for (const segment of relative.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) throw invalidPath();
      segments.pop();
    } else {
      segments.push(segment);
    }
  }

  const normalized = segments.join('/');
  if (!normalized || /^[a-z]:/i.test(normalized)) throw invalidPath();
  return normalized;
}

/** Capture editor state once; no mutable file or byte buffer is retained. */
export function createProjectSnapshot(input: ProjectSnapshotInput): ProjectSnapshot {
  const paths = new Set<string>();
  const files = input.files.map((file): ProjectFile => {
    const path = normalizeProjectPath(file.path);
    if (paths.has(path)) throw new Error(`Duplicate project path: ${path}`);
    paths.add(path);
    if (file.kind === 'text') return Object.freeze({ kind: 'text', path, text: file.text });
    const bytes = file.bytes instanceof Blob ? file.bytes : new Blob([new Uint8Array(file.bytes)]);
    return Object.freeze({ kind: 'binary', path, bytes });
  });
  return Object.freeze({
    projectId: input.projectId,
    revision: input.revision,
    entryPath: normalizeProjectPath(input.entryPath),
    files: Object.freeze(files),
    engine: input.engine,
    bibliography: input.bibliography,
    releaseId: input.releaseId,
  });
}
