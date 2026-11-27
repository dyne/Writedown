import type { PageViewport } from 'pdfjs-dist/types/src/display/page_viewport';
import type { SyncTexRegion } from './map.ts';

export function viewportRegion(viewport: PageViewport, region: SyncTexRegion) {
  const [pageLeft, , , pageTop] = viewport.viewBox;
  const [x1, y1] = viewport.convertToViewportPoint(
    pageLeft + region.left / viewport.userUnit, pageTop - region.top / viewport.userUnit,
  );
  const [x2, y2] = viewport.convertToViewportPoint(
    pageLeft + region.right / viewport.userUnit, pageTop - region.bottom / viewport.userUnit,
  );
  return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

export function syncTexPoint(viewport: PageViewport, page: DOMRectReadOnly, clientX: number, clientY: number) {
  if (!page.width || !page.height || clientX < page.left || clientX > page.right ||
      clientY < page.top || clientY > page.bottom) return undefined;
  const [x, y] = viewport.convertToPdfPoint(
    (clientX - page.left) * viewport.width / page.width,
    (clientY - page.top) * viewport.height / page.height,
  );
  const [pageLeft, , , pageTop] = viewport.viewBox;
  return { x: (x - pageLeft) * viewport.userUnit, y: (pageTop - y) * viewport.userUnit };
}
