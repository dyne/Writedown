import { getDocument, GlobalWorkerOptions, TextLayer, version } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PageViewport } from 'pdfjs-dist/types/src/display/page_viewport';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url&no-inline';

const assetBase = new URL(`${import.meta.env.BASE_URL}assets/pdfjs-${version}/`, location.origin);
GlobalWorkerOptions.workerSrc = workerUrl;

export function openPdf(data: ArrayBuffer) {
  return getDocument({
    data,
    cMapUrl: new URL('cmaps/', assetBase).href,
    standardFontDataUrl: new URL('standard_fonts/', assetBase).href,
    iccUrl: new URL('iccs/', assetBase).href,
    wasmUrl: new URL('wasm/', assetBase).href,
    useWorkerFetch: true,
    stopAtErrors: true,
  });
}

export interface RenderedPdfPage {
  readonly number: number;
  readonly element: HTMLElement;
  readonly viewport: PageViewport;
  dispose(): void;
}

export async function renderPdfPage(
  pdf: PDFDocumentProxy, number: number, zoom: number, width: number, signal: AbortSignal,
): Promise<RenderedPdfPage> {
  const page = await pdf.getPage(number);
  signal.throwIfAborted();
  const natural = page.getViewport({ scale: 1 });
  const scale = Math.min(width / natural.width, 4 / 3) * zoom / 100;
  const viewport = page.getViewport({ scale });
  const element = document.createElement('div');
  element.className = 'pdf-page';
  element.style.width = `${viewport.width}px`;
  element.style.height = `${viewport.height}px`;
  element.style.setProperty('--total-scale-factor', String(scale * viewport.userUnit));

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  // Bound backing memory for unusual aspect ratios and high-DPI zoom.
  const ratio = Math.min(devicePixelRatio, 8192 / viewport.width, 8192 / viewport.height,
    Math.sqrt(16_000_000 / (viewport.width * viewport.height)));
  canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
  canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
  const dispose = () => { canvas.width = canvas.height = 0; };
  const text = document.createElement('div');
  text.className = 'pdf-text';
  element.append(canvas, text);
  const layer = new TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
  const render = page.render({
    canvas, viewport,
    transform: [canvas.width / viewport.width, 0, 0, canvas.height / viewport.height, 0, 0],
  });
  const cancel = () => { render.cancel(); layer.cancel(); };
  signal.addEventListener('abort', cancel, { once: true });
  const tasks = [render.promise, layer.render()];
  try {
    await Promise.all(tasks);
    signal.throwIfAborted();
    return { number, viewport, element, dispose };
  } catch (error) {
    cancel();
    await Promise.allSettled(tasks);
    dispose();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    page.cleanup();
  }
}
