import type { CompilerPathMap } from '../../compiler/paths.ts';

interface SourceTag {
  tag: number;
  line: number;
}

interface SheetRegion extends SourceTag {
  page: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** A source region in 72 dpi points from the unrotated page's upper left. */
export interface SyncTexRegion extends Omit<SheetRegion, 'tag'> {
  readonly path: string;
}

export interface SyncTexMap {
  forward(path: string, line: number, preferredPage: number): SyncTexRegion | undefined;
  inverse(page: number, x: number, y: number): SyncTexRegion | undefined;
}

interface LineBox extends SourceTag {
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  cursor: number;
  regionStart: number;
}

const scaledPointsPerPdfPoint = 65_536 * 72.27 / 72;
const postOffsetUnits: Readonly<Record<string, number>> = {
  sp: 1 / scaledPointsPerPdfPoint, pt: 72 / 72.27, bp: 1, in: 72, cm: 72 / 2.54, mm: 72 / 25.4,
  pc: 12 * 72 / 72.27, dd: 1238 / 1157 * 72 / 72.27, cc: 14856 / 1157 * 72 / 72.27,
  nd: 685 / 642 * 72 / 72.27, nc: 1370 / 107 * 72 / 72.27,
};

function postOffset(value: string): number | undefined {
  const match = value.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([a-z]{2})?$/i);
  if (!match) return undefined;
  const points = Number(match[1]) * (postOffsetUnits[match[2] ?? 'sp'] ?? NaN);
  return Number.isFinite(points) ? points : undefined;
}

const nodeRecord = /^([\[(hgxkvr$])(-?\d+),(\d+)(?:,-?\d+)?:([+-]?\d+),([+-]?\d+)(?::([+-]?\d+)(?:,([+-]?\d+),([+-]?\d+))?)?$/;

function indexRegions(regions: SyncTexRegion[]): SyncTexMap | undefined {
  if (!regions.length) return undefined;
  const byPath = new Map<string, SyncTexRegion[]>();
  const byPage = new Map<number, SyncTexRegion[]>();
  for (const region of regions) {
    let source = byPath.get(region.path);
    if (!source) byPath.set(region.path, source = []);
    source.push(region);
    let sheet = byPage.get(region.page);
    if (!sheet) byPage.set(region.page, sheet = []);
    sheet.push(region);
  }
  return {
    forward(path, line, preferredPage) {
      let nearest: SyncTexRegion | undefined;
      let lineDistance = Infinity;
      let pageDistance = Infinity;
      for (const region of byPath.get(path) ?? []) {
        const lineGap = Math.abs(line - region.line);
        const pageGap = Math.abs(preferredPage - region.page);
        if (lineGap < lineDistance || (lineGap === lineDistance && pageGap < pageDistance)) {
          nearest = region;
          lineDistance = lineGap;
          pageDistance = pageGap;
        }
      }
      return nearest;
    },
    inverse(page, x, y) {
      let nearest: SyncTexRegion | undefined;
      let distance = Infinity;
      let area = Infinity;
      for (const region of byPage.get(page) ?? []) {
        const dx = Math.max(region.left - x, x - region.right, 0);
        const dy = Math.max(region.top - y, y - region.bottom, 0);
        const gap = dx * dx + dy * dy;
        const size = (region.right - region.left) * (region.bottom - region.top);
        if (gap < distance || (gap === distance && size < area)) {
          nearest = region;
          distance = gap;
          area = size;
        }
      }
      return nearest;
    },
  };
}

export function parseSyncTex(text: string, paths: CompilerPathMap): SyncTexMap | undefined {
  if (!/^SyncTeX Version:1\r?\n/.test(text)) return undefined;
  const input = new Map<number, string>();
  const raw: SheetRegion[] = [];
  const stack: (LineBox | null)[] = [];
  let stage = 'preamble';
  let page = 0;
  let unit = 8192;
  let magnification = 1000;
  let xOffset = 0;
  let yOffset = 0;
  let postMagnification = 1;
  let postX: number | undefined;
  let postY: number | undefined;

  function add(box: LineBox, source: SourceTag, left: number, right: number) {
    if (source.line < 1 || right <= left || box.height + box.depth <= 0) return;
    const top = box.y - box.height;
    const bottom = box.y + box.depth;
    const last = raw.length > box.regionStart ? raw.at(-1) : undefined;
    if (last && last.tag === source.tag && last.line === source.line &&
        last.top === top && last.bottom === bottom && left >= last.left && left <= last.right) {
      last.right = Math.max(last.right, right);
      return;
    }
    raw.push({ tag: source.tag, line: source.line, page, left, right, top, bottom });
  }

  for (const record of text.split(/\r?\n/)) {
    const file = record.match(/^Input:(\d+):(.+)$/);
    if (file) {
      const path = paths.resolve(file[2]);
      if (path) input.set(Number(file[1]), path);
      continue;
    }
    if (record === 'Content:') { stage = 'content'; continue; }
    if (record === 'Postamble:') {
      if (stage !== 'content' || page) return undefined;
      stage = 'postamble';
      continue;
    }
    if (record === 'Post scriptum:') { if (stage === 'postamble') stage = 'post'; continue; }

    if (stage === 'preamble' || stage === 'post') {
      const separator = record.indexOf(':');
      const key = record.slice(0, separator);
      const value = record.slice(separator + 1).trim();
      const number = Number(value);
      if (stage === 'preamble' && Number.isSafeInteger(number)) {
        if (key === 'Unit' && number > 0) unit = number;
        if (key === 'Magnification' && number > 0) magnification = number;
        if (key === 'X Offset') xOffset = number;
        if (key === 'Y Offset') yOffset = number;
      }
      if (stage === 'post') {
        if (key === 'Magnification' && Number.isFinite(number) && number > 0) postMagnification = number;
        if (key === 'X Offset') postX = postOffset(value);
        if (key === 'Y Offset') postY = postOffset(value);
      }
      continue;
    }
    if (stage !== 'content') continue;
    const sheet = record.match(/^([{}])(\d+)$/);
    if (sheet) {
      const number = Number(sheet[2]);
      if (sheet[1] === '{' && !page) page = number;
      else if (sheet[1] === '}' && page === number && !stack.length) page = 0;
      else return undefined;
      continue;
    }
    if (!page) continue;
    if (record === ']' || record === ')') {
      const box = stack.pop();
      if (box === undefined || (record === ')') !== Boolean(box)) return undefined;
      if (box) {
        if (raw.length === box.regionStart) add(box, box, box.x, box.x + box.width);
        const parent = stack.at(-1);
        if (parent) parent.cursor = box.x + box.width;
      }
      continue;
    }
    const match = record.match(nodeRecord);
    if (!match) continue;
    const [, kind] = match;
    const [tag, line, x, y, width = 0, height = 0, depth = 0] =
      match.slice(2).map(value => value === undefined ? undefined : Number(value)) as
      [number, number, number, number, number?, number?, number?];
    if (![tag, line, x, y, width, height, depth].every(Number.isSafeInteger)) continue;
    if (kind === '[') { stack.push(null); continue; }
    if (kind === '(') {
      stack.push({ tag, line, x, y, width, height, depth, cursor: x, regionStart: raw.length });
      continue;
    }
    const box = stack.at(-1);
    if (!box) continue;
    if (kind === 'g' || kind === 'x' || kind === '$') {
      // These records mark the right edge of text or glue. The enclosing line
      // supplies the vertical extent, including LuaTeX's x records with y=0.
      add(box, { tag, line }, box.cursor, x);
    } else if (kind === 'h' || kind === 'r') {
      add({ ...box, y, height, depth }, { tag, line }, x, x + width);
      box.cursor = x + width;
      continue;
    }
    if (kind !== 'v') box.cursor = x;
  }
  if (stage !== 'postamble' && stage !== 'post') return undefined;
  // TeX Live applies the preamble offsets with the unmagnified unit. Post
  // scriptum offsets, when supplied, replace them in physical dimensions.
  const baseUnit = unit / scaledPointsPerPdfPoint;
  const scale = baseUnit * (magnification / 1000) * postMagnification;
  const offsetX = postX ?? xOffset * baseUnit;
  const offsetY = postY ?? yOffset * baseUnit;
  return indexRegions(raw.flatMap(({ tag, line, page, left, right, top, bottom }) => {
    const path = input.get(tag);
    return path ? [{ path, line, page, left: left * scale + offsetX, right: right * scale + offsetX,
      top: top * scale + offsetY, bottom: bottom * scale + offsetY }] : [];
  }));
}

export async function readSyncTex(sidecar: Blob, paths: CompilerPathMap, signal: AbortSignal) {
  const header = new Uint8Array(await sidecar.slice(0, 2).arrayBuffer());
  signal.throwIfAborted();
  let bytes = sidecar.stream();
  if (header[0] === 0x1f && header[1] === 0x8b) bytes = bytes.pipeThrough(new DecompressionStream('gzip'), { signal });
  const decoder = bytes.pipeThrough(new TextDecoderStream('utf-8', { fatal: true }), { signal }).getReader();
  const chunks: string[] = [];
  try {
    for (;;) {
      const { done, value } = await decoder.read();
      if (done) break;
      chunks.push(value);
    }
    signal.throwIfAborted();
    return parseSyncTex(chunks.join(''), paths);
  } finally {
    decoder.releaseLock();
  }
}
