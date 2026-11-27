import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProjectSnapshot, normalizeProjectPath } from '../../src/project/snapshot.ts';

test('normalizes project-relative paths and prevents root escapes', () => {
  assert.equal(normalizeProjectPath('.\\chapters//draft/../intro.tex'), 'chapters/intro.tex');
  assert.equal(normalizeProjectPath('figures/Über die Wiese.svg'), 'figures/Über die Wiese.svg');
  for (const path of ['', '.', 'chapters/..', '../outside.tex', 'chapters/../../outside.tex',
    '/root.tex', '\\root.tex', '\\\\server\\root.tex', 'C:\\root.tex', './C:root.tex', 'a\0b.tex']) {
    assert.throws(() => normalizeProjectPath(path), /Invalid project path/, path);
  }
});

test('rejects duplicate normalized names even when file kinds differ', () => {
  assert.throws(() => createProjectSnapshot({
    projectId: 'paths', revision: 1, entryPath: './main.tex', engine: 'pdflatex',
    bibliography: 'none', releaseId: 'test', files: [
      { kind: 'text', path: 'chapters/intro.tex', text: 'Introduction' },
      { kind: 'binary', path: '.\\chapters/drafts/../intro.tex', bytes: new Uint8Array([1]) },
    ],
  }), /Duplicate project path: chapters\/intro\.tex/);
});
