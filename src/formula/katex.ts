import katex from 'katex';
import 'katex/dist/katex.min.css';
import { FormulaError } from './fragment.ts';
import type { FormulaRenderer } from './fragment.ts';

export const katexRenderer: FormulaRenderer = {
  render({ tex, displayMode, macroPreamble }, target) {
    const input = macroPreamble ? macroPreamble + '\n' + tex : tex;
    try {
      katex.render(input, target, {
        displayMode,
        output: 'htmlAndMathml',
        throwOnError: true,
        trust: ({ command }) => { throw new FormulaError(command + ' is unavailable in formula previews.'); },
        maxSize: 20,
        maxExpand: 1000,
        // KaTeX may mutate this object when a selection contains \gdef.
        macros: Object.create(null),
      });
    } catch (error) {
      if (error instanceof katex.ParseError) {
        const command = /^Undefined control sequence: (.+)$/.exec(error.rawMessage);
        if (command) throw new FormulaError(command[1] + ' is undefined in this preview.');
        if (error.rawMessage.startsWith('Unexpected end of input')) {
          throw new FormulaError('The expression is incomplete. Check its arguments and closing braces.');
        }
        throw new FormulaError(error.rawMessage);
      }
      throw error;
    }
  },
};
