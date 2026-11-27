import { createProjectSnapshot } from './project/snapshot.ts';
import { createCompilationRequest } from './compiler/contracts.ts';
import release from '../compiler-release.json';
import reference from './compiler/reference.tex?raw';

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('Application mount is missing');

const title = document.createElement('h1');
title.textContent = 'Writedown';
const status = document.createElement('p');
status.textContent = 'Ready for a local LaTeX project.';
status.setAttribute('role', 'status');
const compile = document.createElement('button');
compile.textContent = 'Compile example';
compile.style.font = 'inherit';
const outputs = document.createElement('div');
app.replaceChildren(title, status, compile, outputs);
app.dataset.ready = 'true';

let generation = 0;
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

compile.addEventListener('click', async () => {
  compile.disabled = true;
  outputs.replaceChildren();
  urls.splice(0).forEach(URL.revokeObjectURL);
  status.textContent = 'Compiling example locally…';
  let compiler: import('./compiler/busytex.ts').BusyTexCompiler | undefined;
  try {
    const { BusyTexCompiler } = await import('./compiler/busytex.ts');
    compiler = new BusyTexCompiler(new URL(`${import.meta.env.BASE_URL}compiler/${release.id}`, location.origin).href);
    const snapshot = createProjectSnapshot({
      projectId: 'reference', revision: 1, entryPath: 'main.tex',
      files: [{ kind: 'text', path: 'main.tex', text: reference }],
      engine: 'pdflatex', bibliography: 'none', releaseId: release.id,
    });
    const result = await compiler.compile(createCompilationRequest(snapshot, { workerGeneration: ++generation, jobId: `reference-${generation}` }));
    addDownload(new Blob([JSON.stringify(result.passLogs, null, 2)], { type: 'application/json' }), 'Download compilation log', 'compilation.json');
    if (result.status === 'failure') {
      status.textContent = `Compilation failed: ${result.reason}`;
      return;
    }
    addDownload(result.pdf, 'Download PDF', 'reference.pdf');
    if (result.syncTex) addDownload(result.syncTex, 'Download SyncTeX', 'reference.synctex.gz');
    status.textContent = 'Example compiled successfully.';
  } catch (error) {
    status.textContent = `Compilation failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    compiler?.terminate();
    compile.disabled = false;
  }
});
