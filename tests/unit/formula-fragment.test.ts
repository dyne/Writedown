import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFormulaFragment } from '../../src/formula/fragment.ts';

test('selected inline, display and bare math produce an unwrapped fragment', () => {
  for (const [selection, displayMode] of [
    [' x^2 ', false], [String.raw`$x^2$`, false], [String.raw`\(x^2\)`, false],
    [String.raw`$$x^2$$`, true], [String.raw`\[x^2\]`, true],
  ] as const) {
    assert.deepEqual(parseFormulaFragment(selection, ''), { tex: 'x^2', displayMode, macroPreamble: '' });
  }
  assert.equal(parseFormulaFragment(' \n ', ''), undefined);
  assert.throws(() => parseFormulaFragment(String.raw`\(x^2\]`, ''), /Include the closing/);
  assert.throws(() => parseFormulaFragment(String.raw`$x\$`, ''), /Include the closing/);
  assert.throws(() => parseFormulaFragment('$$ $$', ''), /Select an expression/);
});

test('the macro file accepts line-based newcommands with required arguments and nested groups', () => {
  const first = String.raw`\newcommand{\Reality}{\mathbb{R}}`;
  const second = String.raw`\newcommand{\Share}[1]{\frac{#1}{3}\%}`;
  const file = '% Formula project macros\r\n' + first + '\r\n' + second + ' % Review note\r\n';
  assert.equal(parseFormulaFragment('\\Reality', file)?.macroPreamble, first + '\n' + second);
  for (const invalid of [String.raw`\input{other}`, String.raw`\newcommand{\x}{a}{b}`,
    String.raw`\newcommand{\x}[1][a]{#1}`, String.raw`\newcommand{\x}{\frac{1}{2}`]) {
    assert.throws(() => parseFormulaFragment('\\x', first + '\n' + invalid), /formula-macros\.tex, line 2/);
  }
});
