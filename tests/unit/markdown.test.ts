import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownDocument, UnclosedTexSection } from '../../src/compiler/markdown.ts';

test('Markdown becomes TeX while raw sections retain their TeX syntax', () => {
  const source = String.raw`# Methods

**Estimate** at 50%: <math>\frac{a_b}{2}</math> and <latex>\textsc{Notes}</latex>.

<math>
\sqrt{2}
</math>

<latex>
\label{methods}
\input{appendix.tex}
</latex>

| Group | Count |
| --- | ---: |
| A & B | 2 |
`;
  const { tex, sourceLines } = markdownDocument(source);
  assert.ok(tex.includes(String.raw`\section*{Methods}`));
  assert.ok(tex.includes(String.raw`\textbf{Estimate} at 50\%: \(\frac{a_b}{2}\) and \textsc{Notes}.`));
  assert.ok(tex.includes('\\[\n%\n\\sqrt{2}\n%\n\\]\n'));
  assert.ok(tex.includes(String.raw`\begin{tabular}{lr}`));
  assert.ok(tex.includes(String.raw`A \& B & 2\\`));
  const lines = tex.split('\n');
  assert.equal(sourceLines[lines.indexOf(String.raw`\sqrt{2}`)], 6);
  assert.equal(sourceLines[lines.indexOf(String.raw`\input{appendix.tex}`)], 11);
});

test('code spans and fences display the custom tags as text', () => {
  const { tex } = markdownDocument([
    '`<math>x_1</math>`', '', '```tex', '<latex>\\textbf{Sample}</latex>', '```',
  ].join('\n'));
  assert.ok(tex.includes(String.raw`\texttt{\textless{}math\textgreater{}x\_1\textless{}/math\textgreater{}}`));
  assert.ok(tex.includes(String.raw`\textbackslash{}textbf\{Sample\}`));
  assert.ok(!tex.includes(String.raw`\textbf{Sample}`));
});

test('unclosed math and LaTeX sections identify their Markdown line', () => {
  for (const [source, line, tag] of [
    ['# Draft\n\n<latex>\n\\textbf{Draft}', 3, 'latex'],
    ['First line\nAn equation <math>x', 2, 'math'],
  ] as const) {
    assert.throws(() => markdownDocument(source), error =>
      error instanceof UnclosedTexSection && error.line === line && error.message.includes(`</${tag}>`));
  }
});
