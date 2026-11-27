import { createProjectSnapshot } from './project/snapshot.ts';
import type { ProjectSnapshot } from './project/snapshot.ts';
import { CompilationService } from './compiler/service.ts';
import type { CompilationState } from './compiler/service.ts';
import { editorEvents, mountProjectEditor } from './editor/project-editor.ts';
import { mountPdfPreview } from './viewer/pdf-preview.ts';
import { mountOfflineStatus } from './offline/registration.ts';
import './editor/project-editor.css';
import './viewer/pdf-preview.css';
import release from '../compiler-release.json';
import reference from './compiler/reference.tex?raw';

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('Application mount is missing');

const title = document.createElement('h1');
title.textContent = 'Writedown';
const masthead = document.createElement('header');
masthead.className = 'app-header';
masthead.append(title);
const editor = document.createElement('section');
editor.setAttribute('aria-label', 'Project editor');
const projectCompilation = document.createElement('div');
projectCompilation.className = 'project-compiler';
const projectStatus = document.createElement('p');
projectStatus.id = 'project-compile-status';
projectStatus.textContent = 'Choose a TeX source to compile.';
projectStatus.setAttribute('aria-live', 'polite');
const retry = document.createElement('button');
retry.type = 'button';
retry.textContent = 'Retry';
retry.setAttribute('aria-label', 'Retry compilation');
retry.hidden = true;
projectCompilation.append(projectStatus, retry);
const pdfPane = document.createElement('section');
const example = document.createElement('section');
example.className = 'reference-compiler';
const exampleTitle = document.createElement('h2');
exampleTitle.textContent = 'Compiler example';
const status = document.createElement('p');
status.textContent = 'Run the built-in LaTeX document on this device.';
status.setAttribute('role', 'status');
const compile = document.createElement('button');
compile.textContent = 'Compile example';
const outputs = document.createElement('div');
example.append(exampleTitle, compile, status, outputs);
app.replaceChildren(masthead, editor, example);
const exampleSnapshot = createProjectSnapshot({
  projectId: '', revision: 1, entryPath: 'main.tex',
  files: [{ kind: 'text', path: 'main.tex', text: reference }],
  engine: 'pdflatex', bibliography: 'none', releaseId: release.id,
});
let editorSnapshot: ProjectSnapshot | undefined;
const urls: string[] = [];
function addDownload(blob: Blob, label: string, filename: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  urls.push(link.href);
  link.download = filename;
  link.textContent = label;
  const paragraph = document.createElement('p');
  paragraph.append(link);
  outputs.append(paragraph);
}

function canCompile(snapshot: ProjectSnapshot | undefined): snapshot is ProjectSnapshot {
  return snapshot?.files.some(file => file.path === snapshot.entryPath && file.kind === 'text') ?? false;
}

function presentExample(state: Exclude<CompilationState, { status: 'idle' }>) {
  if (state.status !== 'settled') {
    status.textContent = 'Compiling example locally…';
    return;
  }
  const { result } = state;
  compile.disabled = false;
  addDownload(new Blob([JSON.stringify(result.passLogs, null, 2)], { type: 'application/json' }), 'Download compilation log', 'compilation.json');
  if (result.status === 'failure') {
    status.textContent = `Compilation failed: ${result.reason}`;
  } else {
    addDownload(result.pdf, 'Download PDF', 'reference.pdf');
    if (result.syncTex) addDownload(result.syncTex, 'Download SyncTeX', 'reference.synctex.gz');
    status.textContent = 'Example compiled successfully.';
  }
}

function presentProject(state: CompilationState) {
  if (compile.disabled) {
    compile.disabled = false;
    status.textContent = 'The example was interrupted by an editor change.';
  }
  projectStatus.dataset.state = state.status;
  const cacheWarning = state.status === 'settled' &&
    state.result.diagnostics.find(item => item.code === 'dependency-cache-write');
  const unavailable = state.status !== 'idle' && state.snapshot.releaseId !== release.id;
  projectStatus.hidden = unavailable;
  retry.hidden = unavailable || state.status !== 'settled' || (state.result.status === 'success' && !cacheWarning);
  const retryCache = cacheWarning && state.status === 'settled' && state.result.status === 'success';
  retry.textContent = retryCache ? 'Retry cache' : 'Retry';
  retry.setAttribute('aria-label', retryCache ? 'Retry dependency cache' : 'Retry compilation');
  if (state.status === 'idle') {
    delete projectStatus.dataset.revision;
    projectStatus.textContent = 'Choose a TeX source to compile.';
    return;
  }
  const revision = state.snapshot.revision;
  projectStatus.dataset.revision = String(revision);
  if (state.status === 'queued') projectStatus.textContent = `Waiting to compile revision ${revision}…`;
  if (state.status === 'initializing') projectStatus.textContent = `Starting the compiler for revision ${revision}…`;
  if (state.status === 'compiling') projectStatus.textContent = `Compiling revision ${revision}…`;
  if (state.status === 'settled') {
    const { result } = state;
    if (result.status === 'success') {
      projectStatus.textContent = `Revision ${revision} compiled.${cacheWarning ? ' ' + cacheWarning.message : ''}`;
    } else {
      const shownWithSource = result.diagnostics.some(item =>
        item.message === result.reason && item.path !== undefined && item.line !== undefined);
      projectStatus.textContent = `Revision ${revision} failed.${shownWithSource ? '' : ' ' + result.reason}`;
    }
  }
}

const compiler = new CompilationService(async snapshot => {
  if (snapshot.releaseId !== release.id) {
    throw new Error(`Compiler release ${snapshot.releaseId} is unavailable. Installed release: ${release.id}.`);
  }
  const { BusyTexCompiler } = await import('./compiler/busytex.ts');
  return new BusyTexCompiler(
    new URL(`${import.meta.env.BASE_URL}compiler/${release.id}`, location.origin).href,
    import.meta.env.VITE_TEX_DEPENDENCY_ENDPOINT,
  );
}, state => {
  const isExample = state.status !== 'idle' && state.snapshot === exampleSnapshot;
  if (isExample) {
    presentExample(state);
    if (state.status === 'queued' && canCompile(editorSnapshot)) {
      projectStatus.textContent = 'The example is compiling before the project.';
      retry.hidden = true;
    }
  } else {
    presentProject(state);
    if (state.status === 'queued') preview.begin(state.snapshot, state.snapshot.releaseId === release.id);
    if (state.status === 'settled' && state.snapshot === editorSnapshot && state.snapshot.releaseId === release.id) {
      preview.present(state.result);
    }
  }
  app.dispatchEvent(new CustomEvent<CompilationState>('writedown:compilation-state', { detail: state, bubbles: true }));
  if (isExample && state.status === 'settled' && canCompile(editorSnapshot)) compiler.submit(editorSnapshot);
});

editor.addEventListener(editorEvents.snapshot, event => {
  const first = editorSnapshot === undefined;
  editorSnapshot = (event as CustomEvent<ProjectSnapshot>).detail;
  if (!canCompile(editorSnapshot) || (first && compile.disabled)) preview.begin(editorSnapshot, false);
  if (first && compile.disabled) return;
  if (canCompile(editorSnapshot)) compiler.submit(editorSnapshot);
  else compiler.clear();
});
retry.addEventListener('click', () => compiler.retry());
compile.addEventListener('click', () => {
  compile.disabled = true;
  outputs.replaceChildren();
  urls.splice(0).forEach(URL.revokeObjectURL);
  compiler.submit(exampleSnapshot);
});
const projectEditor = mountProjectEditor(editor, release.id, pdfPane);
const preview = mountPdfPreview(pdfPane, projectCompilation, projectEditor.sourceJump, projectEditor.currentSource,
  location => editor.dispatchEvent(new CustomEvent(editorEvents.openSource, { detail: location })),
  () => { retry.hidden = false; },
);
mountOfflineStatus(app, import.meta.env.BASE_URL);
app.dataset.ready = 'true';
