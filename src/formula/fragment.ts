export interface FormulaFragment {
  readonly tex: string;
  readonly displayMode: boolean;
  readonly macroPreamble: string;
}

export interface FormulaRenderer {
  render(fragment: FormulaFragment, target: HTMLElement): void | Promise<void>;
}

export class FormulaError extends Error {}

export const formulaMacroPath = 'formula-macros.tex';

const delimiters = [
  { open: '$$', close: '$$', displayMode: true },
  { open: '\\[', close: '\\]', displayMode: true },
  { open: '\\(', close: '\\)', displayMode: false },
  { open: '$', close: '$', displayMode: false },
];

function hasClosingDelimiter(source: string, delimiter: string): boolean {
  if (!source.endsWith(delimiter)) return false;
  let index = source.length - delimiter.length - 1;
  while (index >= 0 && source[index] === '\\') index -= 1;
  return (source.length - delimiter.length - 1 - index) % 2 === 0;
}

export function parseFormulaFragment(selection: string, macroSource: string): FormulaFragment | undefined {
  const source = selection.trim();
  if (!source) return undefined;
  const wrapper = delimiters.find(item => source.startsWith(item.open));
  if (wrapper && (
    source.length < wrapper.open.length + wrapper.close.length || !hasClosingDelimiter(source, wrapper.close)
  )) {
    throw new FormulaError('Include the closing ' + wrapper.close + ' in the selection.');
  }
  const tex = wrapper ? source.slice(wrapper.open.length, -wrapper.close.length).trim() : source;
  if (!tex) throw new FormulaError('Select an expression between the delimiters.');
  return { tex, displayMode: wrapper?.displayMode ?? false, macroPreamble: parseMacroPreamble(macroSource) };
}

function parseMacroPreamble(source: string): string {
  return source.split(/\r?\n/).map((line, index) => {
    // A TeX control symbol such as \% or \\ consumes both characters.
    const definition = line.replace(/\\[^a-zA-Z]|%.*/g, token => token.startsWith('%') ? '' : token).trim();
    if (!definition) return '';
    const match = /^\\newcommand\s*\{\s*\\[a-zA-Z]+\s*\}\s*(?:\[[0-9]\]\s*)?\{(.*)\}$/.exec(definition);
    if (!match || !hasBalancedGroups(match[1])) {
      throw new FormulaError(formulaMacroPath + ', line ' + (index + 1) + '. Use one \\newcommand definition per line.');
    }
    return definition;
  }).filter(Boolean).join('\n');
}

function hasBalancedGroups(body: string): boolean {
  let depth = 0;
  for (const [token] of body.matchAll(/\\[^a-zA-Z]|[{}]/g)) {
    if (token === '{') depth += 1;
    if (token === '}' && --depth < 0) return false;
  }
  return depth === 0;
}
