import type { CompilationSuccess } from '../../compiler/contracts.ts';
import type { ProjectSourceLocation, SourceLocation } from '../../editor/project-editor.ts';
import type { ProjectSnapshot } from '../../project/snapshot.ts';
import type { RenderedPdfPage } from '../pdf-document.ts';
import { syncTexPoint, viewportRegion } from './coordinates.ts';
import { readSyncTex } from './map.ts';
import type { SyncTexMap, SyncTexRegion } from './map.ts';

interface NavigationOptions {
  sourceJump: HTMLButtonElement;
  pdfJump: HTMLButtonElement;
  status: HTMLElement;
  scroll: HTMLElement;
  currentSource(): ProjectSourceLocation | undefined;
  showPage(page: number): boolean;
  openSource(location: SourceLocation): void;
}

export function mountSourceNavigation({
  sourceJump, pdfJump, status, scroll, currentSource, showPage, openSource,
}: NavigationOptions) {
  let binding: { output: CompilationSuccess; controller: AbortController } | undefined;
  let mapping: SyncTexMap | undefined;
  let page: RenderedPdfPage | undefined;
  let selected: SyncTexRegion | undefined;
  let mark: HTMLElement | undefined;
  let reveal = false;

  function announce(reason: string) {
    status.hidden = !reason;
    if (status.textContent !== reason) status.textContent = reason;
    for (const button of [sourceJump, pdfJump]) {
      button.setAttribute('aria-disabled', String(!mapping));
      button.title = !mapping ? reason : '';
    }
    if (mapping) scroll.title = 'Double-click a point in the PDF to open its source.';
    else scroll.removeAttribute('title');
  }

  function clearHighlight() {
    selected = undefined;
    reveal = false;
    mark?.remove();
    mark = undefined;
  }

  function clear(stale: boolean) {
    binding?.controller.abort();
    binding = undefined;
    mapping = undefined;
    page = undefined;
    clearHighlight();
    announce(stale ? 'Source navigation is unavailable while the PDF is stale.' : '');
  }

  async function load(output: CompilationSuccess, snapshot: ProjectSnapshot) {
    const { syncTex, pathMap } = output;
    if (!syncTex?.size) {
      announce('Source navigation is unavailable because this PDF has no SyncTeX sidecar.');
      return;
    }
    if (!pathMap) {
      announce('Source navigation is unavailable because this PDF has no project path map.');
      return;
    }
    const controller = new AbortController();
    binding = { output, controller };
    const files = new Set(snapshot.files.filter(file => file.kind === 'text').map(file => file.path));
    announce('Reading source locations…');
    try {
      const parsed = await readSyncTex(syncTex, {
        ...pathMap,
        resolve(name) {
          const path = pathMap.resolve(name);
          return path && files.has(path) ? path : undefined;
        },
      }, controller.signal);
      if (controller.signal.aborted) return;
      mapping = parsed;
      announce(mapping ? '' : 'This SyncTeX sidecar contains no readable project source locations.');
    } catch {
      if (!controller.signal.aborted) announce('Source locations could not be read from this PDF’s SyncTeX sidecar.');
    }
  }

  function updatePage(rendered: RenderedPdfPage) {
    page = rendered;
    mark?.remove();
    mark = undefined;
    if (!mapping || selected?.page !== page.number) return;
    const projected = viewportRegion(page.viewport, selected);
    const left = Math.max(0, projected.left);
    const top = Math.max(0, projected.top);
    const width = Math.min(page.viewport.width, projected.left + projected.width) - left;
    const height = Math.min(page.viewport.height, projected.top + projected.height) - top;
    if (width <= 0 || height <= 0) {
      announce('The mapped source is outside the visible PDF page.');
      return;
    }
    mark = document.createElement('div');
    mark.className = 'pdf-source-highlight';
    mark.setAttribute('aria-hidden', 'true');
    for (const [property, value] of Object.entries({ left, top, width, height })) {
      mark.style.setProperty(property, `${value}px`);
    }
    page.element.append(mark);
    if (reveal) {
      reveal = false;
      mark.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function forward() {
    const location = currentSource();
    if (!mapping || !binding || !page || !location) return;
    const { projectId, revision } = binding.output.attempt;
    if (location.projectId !== projectId || location.revision !== revision) return;
    const region = mapping.forward(location.path, location.line, page.number);
    if (!region) {
      clearHighlight();
      announce('The current file has no mapped position in this PDF.');
      return;
    }
    announce('');
    clearHighlight();
    selected = region;
    reveal = true;
    if (!showPage(region.page)) {
      clearHighlight();
      announce('The mapped PDF page is unavailable.');
    }
  }

  function openAt(clientX: number, clientY: number) {
    if (!page || !mapping) return;
    const point = syncTexPoint(page.viewport, page.element.getBoundingClientRect(), clientX, clientY);
    if (!point) return;
    const region = mapping.inverse(page.number, point.x, point.y);
    if (!region) {
      announce('This page has no mapped project source.');
      return;
    }
    announce('');
    selected = region;
    reveal = false;
    updatePage(page);
    window.getSelection()?.removeAllRanges();
    openSource({ path: region.path, line: region.line });
  }

  function openVisibleSource() {
    if (!page || !mapping) return;
    const bounds = scroll.getBoundingClientRect();
    for (const element of [mark, page.element]) {
      if (!element) continue;
      const at = element.getBoundingClientRect();
      const left = Math.max(bounds.left, at.left);
      const right = Math.min(bounds.right, at.right);
      const top = Math.max(bounds.top, at.top);
      const bottom = Math.min(bounds.bottom, at.bottom);
      if (right <= left || bottom <= top) continue;
      openAt((left + right) / 2, (top + bottom) / 2);
      return;
    }
  }

  sourceJump.addEventListener('click', forward);
  pdfJump.addEventListener('click', openVisibleSource);
  scroll.addEventListener('dblclick', event => {
    if (page?.element.contains(event.target as Node)) openAt(event.clientX, event.clientY);
  });
  scroll.addEventListener('keydown', event => {
    if (event.key === 'Enter' && mapping) {
      event.preventDefault();
      openVisibleSource();
    }
  });
  announce('');
  return { clear, clearHighlight, load, updatePage };
}
