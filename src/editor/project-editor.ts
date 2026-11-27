import { IndexedDbProjectStorage, WorkingProject } from '../project/store.ts';
import { normalizeProjectPath } from '../project/snapshot.ts';
import type { ProjectFile, ProjectSnapshot, TexEngine } from '../project/snapshot.ts';

export interface SourceLocation {
  readonly path: string;
  readonly line: number;
}

export interface SourceSelection {
  readonly projectId: string;
  readonly revision: number;
  readonly path: string;
  readonly text: string;
}

/** Observe snapshots and selections on the editor or its parent. Target the editor for source jumps. */
export const editorEvents = {
  snapshot: 'writedown:snapshot',
  selection: 'writedown:selection',
  openSource: 'writedown:open-source',
} as const;

const isTex = (path: string) => /\.tex$/i.test(path);
const isTextSource = (path: string) => /\.(?:tex|bib|sty|cls|bst|def|cfg|ltx|txt)$/i.test(path);
const initialProjectId = 'Untitled project';

function setOptions(select: HTMLSelectElement, names: string[], selected: string, empty: string) {
  select.replaceChildren(...(names.length ? names.map(name => new Option(name, name)) : [new Option(empty, '')]));
  select.value = selected;
  if (select.selectedIndex === -1) select.selectedIndex = 0;
  select.disabled = names.length === 0;
}

export function mountProjectEditor(pane: HTMLElement, releaseId: string) {
  pane.className = 'project-editor';
  pane.innerHTML = `
    <fieldset class="editor-access" disabled>
      <legend class="visually-hidden">Local project editor</legend>
      <div class="editor-layout">
        <aside class="editor-sidebar" aria-label="Project files">
          <div class="editor-group">
            <label for="project-choice">Project</label>
            <select id="project-choice"><option>Opening projects…</option></select>
            <details>
              <summary id="new-project">New project</summary>
              <form id="new-project-form" class="editor-form">
                <label for="new-project-name">Project name</label>
                <input id="new-project-name" required />
                <button id="create-project" type="submit">Create project</button>
              </form>
            </details>
          </div>
          <div class="editor-group">
            <label for="file-choice">File</label>
            <select id="file-choice"><option>No files</option></select>
            <div class="editor-file-actions">
              <button id="import-files" type="button">Import files</button>
              <button id="import-folder" type="button">Import folder</button>
              <input id="file-input" type="file" multiple hidden />
              <input id="folder-input" type="file" webkitdirectory multiple hidden />
            </div>
            <details>
              <summary id="new-file">New source file</summary>
              <form id="new-file-form" class="editor-form">
                <label for="new-file-path">File path</label>
                <input id="new-file-path" placeholder="chapters/intro.tex" required />
                <button id="create-file" type="submit">Create file</button>
              </form>
            </details>
          </div>
        </aside>
        <div class="editor-main">
          <div class="editor-settings">
            <div class="editor-field">
              <label for="root-choice">Root document</label>
              <select id="root-choice"><option>No .tex files</option></select>
            </div>
            <div class="editor-field">
              <label for="engine-choice">Engine</label>
              <select id="engine-choice">
                <option value="pdflatex">pdfLaTeX</option>
                <option value="xelatex">XeLaTeX</option>
                <option value="lualatex">LuaLaTeX</option>
              </select>
            </div>
            <div class="editor-field">
              <label for="bibliography-choice">Bibliography</label>
              <select id="bibliography-choice">
                <option value="none">Off</option>
                <option value="bibtex">BibTeX</option>
              </select>
            </div>
          </div>
          <div class="editor-document">
            <header class="editor-document-header">
              <h2 id="source-path">Source</h2>
              <form id="source-jump" class="editor-jump">
                <label for="source-line">Line</label>
                <input id="source-line" type="number" min="1" step="1" value="1" required />
                <button id="go-to-line" type="submit">Go to line</button>
              </form>
            </header>
            <label class="visually-hidden" for="source-text">Source code</label>
            <textarea id="source-text" autocomplete="off" autocapitalize="off" spellcheck="false" wrap="off" hidden></textarea>
            <p id="source-empty" class="editor-empty">Create a .tex or .bib file, or import your sources.</p>
          </div>
          <footer class="editor-save">
            <p id="project-save-status" aria-live="polite">Opening local projects…</p>
            <button id="save-project" type="button">Save now</button>
          </footer>
        </div>
      </div>
    </fieldset>`;

  const find = <T extends HTMLElement>(id: string) => pane.querySelector<T>(`#${id}`)!;
  const access = pane.querySelector<HTMLFieldSetElement>('fieldset')!;
  const projectChoice = find<HTMLSelectElement>('project-choice');
  const fileChoice = find<HTMLSelectElement>('file-choice');
  const rootChoice = find<HTMLSelectElement>('root-choice');
  const engineChoice = find<HTMLSelectElement>('engine-choice');
  const bibliographyChoice = find<HTMLSelectElement>('bibliography-choice');
  const projectName = find<HTMLInputElement>('new-project-name');
  const filePath = find<HTMLInputElement>('new-file-path');
  const source = find<HTMLTextAreaElement>('source-text');
  const sourcePath = find('source-path');
  const sourceLine = find<HTMLInputElement>('source-line');
  const sourceEmpty = find('source-empty');
  const goToLine = find<HTMLButtonElement>('go-to-line');
  const status = find('project-save-status');
  const storage = new IndexedDbProjectStorage();
  const makeProject = (projectId: string) => WorkingProject.create(storage, { projectId, entryPath: 'main.tex', releaseId, files: [] });

  let project = makeProject(initialProjectId);
  let projectIds = [initialProjectId];
  let activeFile = '';
  let busy = false;
  let saveTimer: number | undefined;

  function setStatus(message: string, error = false) {
    status.textContent = message;
    status.classList.toggle('editor-error', error);
  }

  function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  function emit<T>(name: string, detail: T) {
    pane.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true }));
  }

  function publishSelection() {
    const text = source.hidden ? '' : source.value.slice(source.selectionStart, source.selectionEnd);
    const { projectId, revision } = project.snapshot;
    emit<SourceSelection | null>(editorEvents.selection, text ? { projectId, revision, path: activeFile, text } : null);
  }

  function showFile(path: string) {
    activeFile = path;
    fileChoice.value = path;
    const file = project.snapshot.files.find(item => item.path === path);
    sourcePath.textContent = file?.path ?? 'Source';
    source.hidden = file?.kind !== 'text';
    sourceEmpty.hidden = !source.hidden;
    sourceEmpty.textContent = file ? 'Binary file included in the project.' : 'Create a .tex or .bib file, or import your sources.';
    source.value = file?.kind === 'text' ? file.text : '';
    source.setSelectionRange(0, 0);
    source.scrollTop = 0;
    sourceLine.value = '1';
    sourceLine.disabled = goToLine.disabled = source.hidden;
    publishSelection();
  }

  function render(preferredFile: string) {
    const snapshot = project.snapshot;
    setOptions(projectChoice, projectIds, snapshot.projectId, 'No local projects');
    const paths = snapshot.files.map(file => file.path).sort();
    setOptions(fileChoice, paths, preferredFile, 'No files');
    setOptions(rootChoice, paths.filter(isTex), snapshot.entryPath, 'No .tex files');
    engineChoice.value = snapshot.engine;
    bibliographyChoice.value = snapshot.bibliography;
    showFile(fileChoice.value);
  }

  function openAtFileAndLine({ path, line }: SourceLocation) {
    const file = project.snapshot.files.find(item => item.path === path && item.kind === 'text');
    if (!file || !Number.isInteger(line) || line < 1) return false;
    if (activeFile !== path) showFile(path);
    const lines = source.value.split('\n');
    const target = Math.min(line, lines.length) - 1;
    let start = 0;
    for (let index = 0; index < target; index++) start += lines[index].length + 1;
    sourceLine.value = String(target + 1);
    source.focus();
    source.setSelectionRange(start, start + lines[target].length);
    const lineHeight = Number.parseFloat(getComputedStyle(source).lineHeight);
    source.scrollTop = Math.max(0, target * lineHeight - source.clientHeight / 2);
    source.scrollLeft = 0;
    publishSelection();
    return true;
  }

  async function saveCurrent() {
    window.clearTimeout(saveTimer);
    const saving = project;
    const revision = saving.snapshot.revision;
    setStatus('Saving locally…');
    try {
      await saving.save();
      if (project === saving && saving.snapshot.revision === revision) setStatus('Saved on this device.');
    } catch (error) {
      if (project === saving && saving.snapshot.revision === revision) {
        setStatus(`Could not save. ${errorMessage(error)} Use Save now to retry.`, true);
      }
      throw error;
    }
  }

  function update(changes: Parameters<WorkingProject['update']>[0]) {
    const snapshot = project.update(changes);
    emit<ProjectSnapshot>(editorEvents.snapshot, snapshot);
    setStatus('Unsaved changes');
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { void saveCurrent().catch(() => {}); }, 350);
  }

  function activate(next: WorkingProject, ids: string[]) {
    project = next;
    projectIds = ids;
    render(project.snapshot.entryPath);
    setStatus(project.savedRevision === null ? 'Unsaved changes' : 'Saved on this device.');
    emit<ProjectSnapshot>(editorEvents.snapshot, project.snapshot);
  }

  async function runAction(action: () => Promise<void>, returnFocus?: HTMLElement) {
    if (busy) return;
    busy = access.disabled = true;
    try {
      await action();
    } catch (error) {
      projectChoice.value = project.snapshot.projectId;
      setStatus(errorMessage(error), true);
    } finally {
      busy = access.disabled = false;
      returnFocus?.focus();
    }
  }

  function addFiles(files: ProjectFile[], preferredFile: string) {
    const snapshot = project.snapshot;
    const existingRoot = snapshot.files.some(file => file.path === snapshot.entryPath);
    const entryPath = existingRoot ? snapshot.entryPath : files.find(file => file.kind === 'text' && isTex(file.path))?.path ?? snapshot.entryPath;
    update({ files: [...snapshot.files, ...files], entryPath });
    render(preferredFile);
  }

  projectChoice.addEventListener('change', () => {
    const nextId = projectChoice.value;
    void runAction(async () => {
      if (project.snapshot.revision !== project.savedRevision) await saveCurrent();
      const next = await WorkingProject.open(storage, nextId);
      if (!next) throw new Error('This project could not be opened.');
      activate(next, projectIds);
    }, projectChoice);
  });
  find<HTMLFormElement>('new-project-form').addEventListener('submit', event => {
    event.preventDefault();
    void runAction(async () => {
      const name = projectName.value.trim();
      if (!name) throw new Error('Enter a project name.');
      if (projectIds.includes(name)) throw new Error(`A project named ${name} already exists.`);
      if (project.snapshot.revision !== project.savedRevision) await saveCurrent();
      const next = makeProject(name);
      await next.save();
      activate(next, [...projectIds, name].sort());
      projectName.value = '';
      projectName.closest('details')!.open = false;
    }, projectChoice);
  });
  find<HTMLFormElement>('new-file-form').addEventListener('submit', event => {
    event.preventDefault();
    try {
      const path = normalizeProjectPath(filePath.value);
      if (!/\.(?:tex|bib)$/i.test(path)) throw new Error('Use a .tex or .bib file extension.');
      addFiles([{ kind: 'text', path, text: '' }], path);
      filePath.value = '';
      filePath.closest('details')!.open = false;
      source.focus();
    } catch (error) {
      setStatus(errorMessage(error), true);
    }
  });

  for (const [button, field] of [['import-files', 'file-input'], ['import-folder', 'folder-input']]) {
    const input = find<HTMLInputElement>(field);
    const trigger = find<HTMLButtonElement>(button);
    trigger.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const selected = Array.from(input.files ?? []);
      input.value = '';
      if (!selected.length) return;
      void runAction(async () => {
        const files = await Promise.all(selected.map(async (file): Promise<ProjectFile> => {
          const path = normalizeProjectPath(file.webkitRelativePath || file.name);
          return isTextSource(path) ? { kind: 'text', path, text: await file.text() } : { kind: 'binary', path, bytes: file };
        }));
        addFiles(files, activeFile || files.find(file => file.kind === 'text')?.path || files[0].path);
      }, trigger);
    });
  }

  fileChoice.addEventListener('change', () => showFile(fileChoice.value));
  rootChoice.addEventListener('change', () => update({ entryPath: rootChoice.value }));
  engineChoice.addEventListener('change', () => update({ engine: engineChoice.value as TexEngine }));
  bibliographyChoice.addEventListener('change', () => update({ bibliography: bibliographyChoice.value === 'bibtex' ? 'bibtex' : 'none' }));
  source.addEventListener('input', () => {
    const files = project.snapshot.files.map(file => file.path === activeFile && file.kind === 'text' ? { ...file, text: source.value } : file);
    update({ files });
    publishSelection();
  });
  source.addEventListener('select', publishSelection);
  find<HTMLFormElement>('source-jump').addEventListener('submit', event => {
    event.preventDefault();
    openAtFileAndLine({ path: activeFile, line: sourceLine.valueAsNumber });
  });
  pane.addEventListener(editorEvents.openSource, event => {
    if (!busy && event instanceof CustomEvent && event.detail) openAtFileAndLine(event.detail as SourceLocation);
  });
  find('save-project').addEventListener('click', () => { void saveCurrent().catch(() => {}); });

  void runAction(async () => {
    let ids: string[];
    try {
      ids = await storage.listProjectIds();
      const first = ids.length ? await WorkingProject.open(storage, ids[0]) : undefined;
      const initial = first ?? project;
      if (!first) await initial.save();
      activate(initial, first ? ids : [initialProjectId]);
    } catch (error) {
      activate(project, projectIds);
      setStatus(`Could not open local storage. ${errorMessage(error)} Use Save now to retry.`, true);
    }
  });
}
