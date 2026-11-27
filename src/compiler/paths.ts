import { normalizeProjectPath } from '../project/snapshot.ts';
import type { ProjectSnapshot } from '../project/snapshot.ts';

// The locked BusyTeX pipeline mounts the snapshot here and runs TeX from
// the selected entry's directory.
const projectMount = '/home/web_user/project_dir/';

export interface CompilerPathMap {
  /** Resolve a path from a TeX log or SyncTeX Input record to a snapshot file. */
  resolve(path: string): string | undefined;
}

export function createCompilerPathMap(snapshot: ProjectSnapshot): CompilerPathMap {
  const entryDirectory = snapshot.entryPath.slice(0, snapshot.entryPath.lastIndexOf('/') + 1);
  const projectPaths = new Set(snapshot.files.map(file => file.path));
  return Object.freeze({
    resolve(path: string) {
      if (!path || (path.startsWith('/') && !path.startsWith(projectMount))) return undefined;
      try {
        const candidate = normalizeProjectPath(path.startsWith(projectMount)
          ? path.slice(projectMount.length)
          : entryDirectory + path);
        if (projectPaths.has(candidate)) return candidate;
      } catch {
        // Paths outside the snapshot have no editor location.
      }
      return undefined;
    },
  });
}
