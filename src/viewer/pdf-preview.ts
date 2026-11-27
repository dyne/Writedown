import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import type { CompilationResult, CompilationSuccess } from '../compiler/contracts.ts';
import type { ProjectSourceLocation, SourceLocation } from '../editor/project-editor.ts';
import type { ProjectSnapshot } from '../project/snapshot.ts';
import type { RenderedPdfPage } from './pdf-document.ts';
import type { PreviewViewer } from './contracts.ts';
import { mountSourceNavigation } from './synctex/navigation.ts';

interface PreviewDocument {
  // The PDF, sidecar and their path map always move together.
  readonly output: CompilationSuccess;
  readonly lifetime: AbortController;
  loading?: PDFDocumentLoadingTask;
  pdf?: PDFDocumentProxy;
  render?: AbortController;
}

function retire(document: PreviewDocument | undefined) {
  if (!document) return;
  document.lifetime.abort();
  document.render?.abort();
  void document.loading?.destroy().catch(() => {});
}

export function mountPdfPreview(
  pane: HTMLElement, compilation: HTMLElement, sourceJump: HTMLButtonElement,
  currentSource: () => ProjectSourceLocation | undefined,
  openSource: (location: SourceLocation) => void, allowRetry: () => void,
) {
  pane.className = 'pdf-preview';
  pane.setAttribute('aria-labelledby', 'pdf-preview-heading');
  pane.innerHTML = `
    <header class="pdf-preview-header">
      <h2 id="pdf-preview-heading">PDF preview</h2>
      <p id="pdf-revision" aria-live="polite" hidden></p>
      <div class="pdf-compilation"></div>
      <p id="pdf-message" role="status">No compiled PDF yet.</p>
      <div class="pdf-diagnostics" hidden>
        <ul aria-label="Compilation diagnostics" aria-live="polite" hidden></ul>
        <details hidden>
          <summary>Raw pass logs</summary>
          <div class="pdf-pass-logs"></div>
        </details>
      </div>
      <div class="pdf-controls" hidden>
        <div class="pdf-page-turn">
          <button type="button" id="pdf-previous" aria-label="Previous page"></button>
          <span id="pdf-page-number" aria-live="polite"></span>
          <button type="button" id="pdf-next" aria-label="Next page"></button>
        </div>
        <label for="pdf-zoom" class="visually-hidden">PDF zoom</label>
        <select id="pdf-zoom">
          <option value="50">50%</option><option value="75">75%</option><option value="100" selected>100%</option>
          <option value="125">125%</option><option value="150">150%</option><option value="200">200%</option>
        </select>
        <button id="pdf-open-source" type="button" aria-describedby="pdf-sync-status">Open source</button>
      </div>
      <p id="pdf-sync-status" role="status" hidden></p>
    </header>
    <div class="pdf-scroll" role="region" aria-label="PDF page" tabindex="-1"></div>`;

  const find = <T extends HTMLElement>(selector: string) => pane.querySelector<T>(selector)!;
  find('.pdf-compilation').append(compilation);
  const revision = find('#pdf-revision');
  const message = find('#pdf-message');
  const controls = find('.pdf-controls');
  const previous = find<HTMLButtonElement>('#pdf-previous');
  const next = find<HTMLButtonElement>('#pdf-next');
  const pageNumber = find('#pdf-page-number');
  const zoomChoice = find<HTMLSelectElement>('#pdf-zoom');
  const scroll = find('.pdf-scroll');
  const diagnostics = find('.pdf-diagnostics');
  const list = find('ul');
  const logs = find<HTMLDetailsElement>('details');
  const passes = find('.pdf-pass-logs');

  let expected: ProjectSnapshot | undefined;
  let pending: PreviewDocument | undefined;
  let shown: { document: PreviewDocument; page: RenderedPdfPage; zoom: number } | undefined;
  let fresh = false;
  let targetPage = 1;
  let targetZoom = 100;
  let width = 0;
  let renderError = false;

  const navigation = mountSourceNavigation({
    sourceJump, pdfJump: find('#pdf-open-source'), status: find('#pdf-sync-status'), scroll, currentSource, openSource,
    showPage(number) {
      if (!shown || number > shown.document.pdf!.numPages) return false;
      targetPage = number;
      updateControls();
      if (shown.page.number === number && !shown.document.render) navigation.updatePage(shown.page);
      else void render(shown.document);
      return true;
    },
  });

  function setMessage(text: string, error = false) {
    message.hidden = !text;
    message.textContent = text;
    message.classList.toggle('preview-error', error);
  }

  function updateRevision() {
    revision.hidden = !shown;
    const text = shown
      ? `PDF revision ${shown.document.output.attempt.revision} · ${fresh ? 'Current' : 'Stale'}` : '';
    if (revision.textContent !== text) revision.textContent = text;
    if (shown) revision.dataset.state = fresh ? 'current' : 'stale';
    else delete revision.dataset.state;
  }

  function showDiagnostics(result?: CompilationResult) {
    list.replaceChildren();
    passes.replaceChildren();
    logs.open = false;
    for (const item of result?.diagnostics ?? []) {
      const row = document.createElement('li');
      row.className = `diagnostic-${item.severity}`;
      const severity = document.createElement('strong');
      severity.textContent = `${item.severity[0].toUpperCase()}${item.severity.slice(1)} `;
      if (result?.status !== 'failure' || result.diagnostics.length !== 1 || item.severity !== 'error') row.append(severity);
      row.append(document.createTextNode(item.message));
      const { path, line } = item;
      if (path !== undefined && line !== undefined && expected?.files.some(file => file.path === path && file.kind === 'text')) {
        const jump = document.createElement('button');
        jump.type = 'button';
        jump.className = 'pdf-source-link';
        jump.textContent = `${path}:${line}`;
        jump.setAttribute('aria-label', `Open ${path}, line ${line}`);
        jump.addEventListener('click', () => openSource({ path, line }));
        row.append(jump);
      }
      list.append(row);
    }
    for (const pass of result?.passLogs ?? []) {
      const header = document.createElement('h3');
      header.textContent = `Pass ${pass.pass} · ${pass.tool}${pass.exitCode === null ? '' : ` · Exit ${pass.exitCode}`}`;
      const raw = document.createElement('pre');
      raw.textContent = pass.text;
      passes.append(header, raw);
    }
    list.hidden = !list.childElementCount;
    logs.hidden = !passes.childElementCount;
    diagnostics.hidden = list.hidden && logs.hidden;
  }

  function updateControls() {
    controls.hidden = !shown;
    scroll.tabIndex = shown ? 0 : -1;
    if (!shown) {
      pageNumber.textContent = '';
      return;
    }
    const pages = shown.document.pdf!.numPages;
    const label = `Page ${shown.page.number} of ${pages}`;
    if (pageNumber.textContent !== label) pageNumber.textContent = label;
    previous.setAttribute('aria-disabled', String(targetPage <= 1));
    next.setAttribute('aria-disabled', String(targetPage >= pages));
  }

  function reset() {
    if (shown) retire(shown.document);
    shown?.page.dispose();
    shown = undefined;
    targetPage = 1;
    zoomChoice.value = String(targetZoom = 100);
    scroll.replaceChildren();
    updateControls();
  }

  function begin(snapshot: ProjectSnapshot, compiling: boolean) {
    retire(pending);
    pending = undefined;
    if (snapshot.projectId !== expected?.projectId) reset();
    expected = snapshot;
    fresh = false;
    navigation.clear(Boolean(shown));
    renderError = false;
    updateRevision();
    showDiagnostics();
    setMessage(!shown && !compiling ? 'No compiled PDF yet.' : '');
  }

  function fail(document: PreviewDocument) {
    retire(document);
    pending = undefined;
    fresh = false;
    updateRevision();
    setMessage(`Could not display the PDF for revision ${document.output.attempt.revision}.`, true);
    allowRetry();
  }

  async function render(document: PreviewDocument) {
    if (!document.pdf || width <= 0) return;
    document.render?.abort();
    const job = document.render = new AbortController();
    const zoom = targetZoom;
    const number = Math.min(targetPage, document.pdf.numPages);
    try {
      const { renderPdfPage } = await import('./pdf-document.ts');
      job.signal.throwIfAborted();
      const page = await renderPdfPage(document.pdf, number, zoom, width, job.signal);
      if (job.signal.aborted) {
        page.dispose();
        return;
      }
      const replaced = shown;
      const samePage = page.number === shown?.page.number;
      const newDocument = document === pending;
      if (newDocument) {
        pending = undefined;
        fresh = true;
        if (replaced) retire(replaced.document);
        targetPage = number;
        setMessage('');
      } else if (!pending && renderError) {
        setMessage('');
      }
      renderError = false;
      shown = { document, page, zoom };
      scroll.replaceChildren(page.element);
      if (!samePage) scroll.scrollTo(0, 0);
      replaced?.page.dispose();
      updateRevision();
      updateControls();
      navigation.updatePage(page);
      if (newDocument && expected) void navigation.load(document.output, expected);
    } catch {
      if (job.signal.aborted) return;
      if (document === pending) fail(document);
      else if (shown?.document === document && !pending && fresh) {
        targetPage = shown.page.number;
        zoomChoice.value = String(targetZoom = shown.zoom);
        updateControls();
        renderError = true;
        setMessage(`Could not display page ${number}.`, true);
      }
    } finally {
      if (document.render === job) document.render = undefined;
    }
  }

  async function load(document: PreviewDocument) {
    const signal = document.lifetime.signal;
    try {
      const [{ openPdf }, bytes] = await Promise.all([import('./pdf-document.ts'), document.output.pdf.arrayBuffer()]);
      signal.throwIfAborted();
      document.loading = openPdf(bytes);
      document.pdf = await document.loading.promise;
      signal.throwIfAborted();
      void render(document);
    } catch {
      if (!signal.aborted) fail(document);
    }
  }

  function present(result: CompilationResult) {
    const { attempt } = result;
    if (!expected || attempt.projectId !== expected.projectId || attempt.revision !== expected.revision ||
        attempt.engine !== expected.engine || attempt.releaseId !== expected.releaseId) return;
    retire(pending);
    pending = undefined;
    showDiagnostics(result);
    if (result.status === 'failure') {
      fresh = false;
      updateRevision();
      setMessage(shown ? '' : 'No PDF to display.');
      return;
    }
    setMessage(`Opening PDF for revision ${attempt.revision}…`);
    pending = { output: result, lifetime: new AbortController() };
    void load(pending);
  }

  function refresh() {
    if (shown) void render(shown.document);
    if (pending) void render(pending);
  }

  function move(offset: number) {
    if (!shown) return;
    const page = Math.min(shown.document.pdf!.numPages, Math.max(1, targetPage + offset));
    if (page === targetPage) return;
    targetPage = page;
    navigation.clearHighlight();
    updateControls();
    refresh();
  }

  previous.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));
  zoomChoice.addEventListener('change', () => {
    targetZoom = Number(zoomChoice.value);
    refresh();
  });
  const resize = new ResizeObserver(() => {
    const layout = getComputedStyle(scroll);
    const available = scroll.clientWidth - parseFloat(layout.paddingLeft) - parseFloat(layout.paddingRight);
    if (available !== width) {
      width = available;
      refresh();
    }
  });
  resize.observe(scroll);

  return { begin, present } satisfies PreviewViewer & { begin: typeof begin };
}
