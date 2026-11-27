import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createCompilerPathMap } from '../../src/compiler/paths.ts';
import { createProjectSnapshot } from '../../src/project/snapshot.ts';
import { parseSyncTex, readSyncTex } from '../../src/viewer/synctex/map.ts';

const chapter = 'paper/chapter/intro.tex';
const shared = 'shared.tex';
const paths = createCompilerPathMap(createProjectSnapshot({
  projectId: 'fixture', revision: 5, engine: 'pdflatex', releaseId: 'fixture', bibliography: 'none',
  entryPath: 'paper/main.tex',
  files: [chapter, shared].map(path => ({ kind: 'text', path, text: '' })),
}));
const data = `SyncTeX Version:1
Input:1:/home/web_user/project_dir/paper/./chapter/intro.tex
Input:9:/texlive/texmf-dist/tex/third-party/foreign.sty
Output:pdf
Magnification:1500
Unit:4
X Offset:20
Y Offset:-40
Content:
{1
[1,40:300,4500:20000,4500,0
(1,40:500,1000:10000,90,10
h1,7:500,1000:50,0,0
x1,7:1000,1000
g1,7:1050,1000
x1,7:1500,1000
x9,7:3500,1000
)
]
}1
{2
(2,8:400,1100:4000,100,12
x2,8:1000,0
)
}2
Input:2:../shared.tex
Postamble:
Count:11
Post scriptum:
`;
const spPerPoint = 65_536 * 72.27 / 72;

test('normalizes late input IDs and indexes positioned text with TeX units, magnification and offsets', () => {
  const map = parseSyncTex(data, paths)!;
  const found = map.forward(chapter, 7, 2)!;
  const base = 4 / spPerPoint;
  const scale = base * 1.5;
  assert.equal(found.path, chapter);
  assert.equal(found.page, 1);
  assert.equal(found.line, 7);
  assert.equal(found.left, 550 * scale + 20 * base);
  assert.equal(found.right, 1500 * scale + 20 * base);
  assert.equal(found.top, 910 * scale - 40 * base);
  assert.equal(found.bottom, 1010 * scale - 40 * base);
  assert.equal(map.inverse(1, (found.left + found.right) / 2, (found.top + found.bottom) / 2), found);
  assert.equal(map.forward('foreign.sty', 7, 1), undefined);
  assert.equal(map.inverse(3, 0, 0), undefined);
  const other = map.forward(shared, 8, 1)!;
  assert.equal(other.page, 2);
  assert.equal(other.top, 1000 * scale - 40 * base);
});

test('reads gzip and honors post scriptum dimensions without applying preamble offsets twice', async () => {
  const modified = data + 'Magnification:0.5\nX Offset:1in\nY Offset:-2.5bp\n';
  const packed = new Blob([new Uint8Array(gzipSync(modified))]);
  const map = await readSyncTex(packed, paths, new AbortController().signal);
  const found = map?.forward(chapter, 7, 1);
  assert.equal(found?.left, (550 * (4 / spPerPoint) * 1.5 * 0.5) + 72);
  assert.equal(found?.top, (910 * (4 / spPerPoint) * 1.5 * 0.5) - 2.5);
  const plain = await readSyncTex(new Blob([modified]), paths, new AbortController().signal);
  assert.deepEqual(plain?.forward(chapter, 7, 1), found);
});

test('ignores incomplete geometry and cancels a superseded sidecar read', async () => {
  assert.equal(parseSyncTex(data.slice(0, data.indexOf('}2')), paths), undefined);
  assert.equal(parseSyncTex(data.replace('SyncTeX Version:1', 'SyncTeX Version:2'), paths), undefined);
  assert.equal(parseSyncTex(data, { resolve: () => undefined }), undefined);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(readSyncTex(new Blob([data]), paths, abort.signal), { name: 'AbortError' });
});
