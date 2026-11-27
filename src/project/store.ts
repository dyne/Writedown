import { createProjectSnapshot, isMarkdownPath } from './snapshot.ts';
import type { ProjectFile, ProjectSnapshot, ProjectSnapshotInput } from './snapshot.ts';

export interface ProjectStorage {
  load(projectId: string): Promise<ProjectSnapshot | undefined>;
  save(snapshot: ProjectSnapshot): Promise<void>;
}

const projectRecords = 'projects';

export class IndexedDbProjectStorage implements ProjectStorage {
  private readonly databaseName: string;

  constructor(databaseName = 'writedown-projects') {
    this.databaseName = databaseName;
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        if (blocked) request.transaction?.abort();
        else request.result.createObjectStore(projectRecords, { keyPath: 'projectId' });
      };
      request.onblocked = () => {
        blocked = true;
        reject(new Error('Another tab is blocking access to local project storage.'));
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (blocked) request.result.close();
        else resolve(request.result);
      };
    });
  }

  private async read<T>(query: (records: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await this.open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(projectRecords);
        const request = query(transaction.objectStore(projectRecords));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error ?? new Error('Reading local project storage was interrupted.'));
      });
    } finally {
      database.close();
    }
  }

  async listProjectIds(): Promise<string[]> {
    const keys = await this.read(records => records.getAllKeys());
    return keys.filter(key => typeof key === 'string');
  }

  async load(projectId: string): Promise<ProjectSnapshot | undefined> {
    const record = await this.read<ProjectSnapshot | undefined>(records => records.get(projectId));
    if (!record) return undefined;
    const files = await Promise.all(record.files.map(async (file): Promise<ProjectFile> => {
      // Older versions imported Markdown as a binary attachment.
      if (file.kind === 'binary' && isMarkdownPath(file.path)) {
        return { kind: 'text', path: file.path, text: await file.bytes.text() };
      }
      return file;
    }));
    return createProjectSnapshot({ ...record, files });
  }

  async save(snapshot: ProjectSnapshot): Promise<void> {
    const database = await this.open();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(projectRecords, 'readwrite', { durability: 'strict' });
        const records = transaction.objectStore(projectRecords);
        const request = records.get(snapshot.projectId);
        let saveError: unknown;
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(saveError ?? transaction.error ?? new Error('Saving the local project was interrupted.'));
        request.onsuccess = () => {
          try {
            const previous: ProjectSnapshot | undefined = request.result;
            if (previous && previous.revision >= snapshot.revision) {
              throw new Error(`Local project storage already has revision ${previous.revision} of this project.`);
            }
            records.put(snapshot);
          } catch (error) {
            saveError = error;
            transaction.abort();
          }
        };
      });
    } finally {
      database.close();
    }
  }
}

type WorkingChanges = Partial<Omit<ProjectSnapshotInput, 'projectId' | 'revision'>>;
type NewProject = Omit<ProjectSnapshotInput, 'revision' | 'engine' | 'bibliography'>
  & Partial<Pick<ProjectSnapshotInput, 'engine' | 'bibliography'>>;

export class WorkingProject {
  private current: ProjectSnapshot;
  private lastSavedRevision: number | null;
  private pendingSave = Promise.resolve();
  private readonly storage: ProjectStorage;

  private constructor(storage: ProjectStorage, snapshot: ProjectSnapshot, savedRevision: number | null) {
    this.storage = storage;
    this.current = snapshot;
    this.lastSavedRevision = savedRevision;
  }

  static create(storage: ProjectStorage, project: NewProject): WorkingProject {
    return new WorkingProject(storage, createProjectSnapshot({
      ...project,
      revision: 1,
      engine: project.engine ?? 'pdflatex',
      bibliography: project.bibliography ?? 'none',
    }), null);
  }

  static async open(storage: ProjectStorage, projectId: string): Promise<WorkingProject | undefined> {
    const snapshot = await storage.load(projectId);
    return snapshot && new WorkingProject(storage, snapshot, snapshot.revision);
  }

  get snapshot(): ProjectSnapshot {
    return this.current;
  }

  get savedRevision(): number | null {
    return this.lastSavedRevision;
  }

  update(changes: WorkingChanges): ProjectSnapshot {
    this.current = createProjectSnapshot({
      ...this.current,
      ...changes,
      projectId: this.current.projectId,
      revision: this.current.revision + 1,
    });
    return this.current;
  }

  save(): Promise<void> {
    // Capture this revision even if an earlier save is still running.
    const snapshot = this.current;
    const write = this.pendingSave.then(async () => {
      if (snapshot.revision === this.lastSavedRevision) return;
      await this.storage.save(snapshot);
      this.lastSavedRevision = snapshot.revision;
    });
    this.pendingSave = write.catch(() => {});
    return write;
  }
}
