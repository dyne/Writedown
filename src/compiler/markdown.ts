import markdownit from 'markdown-it';
import type { Token } from 'markdown-it';

const markdown = markdownit({ html: false }).disable('strikethrough');
const tagStart = /^<(latex|math)>/;

markdown.block.ruler.before('paragraph', 'tex_section', (state, start, end, silent) => {
  const first = state.getLines(start, start + 1, state.blkIndent, false).trimStart();
  const open = tagStart.exec(first);
  if (!open || state.isEmpty(start) || state.sCount[start] - state.blkIndent >= 4) return false;

  const close = '</' + open[1] + '>';
  const contents: string[] = [];
  let line = start;
  for (; line < end; line++) {
    const text = line === start ? first.slice(open[0].length) : state.getLines(line, line + 1, state.blkIndent, false);
    const stop = text.indexOf(close);
    if (stop < 0) {
      contents.push(text);
      continue;
    }
    if (text.slice(stop + close.length).trim()) return false;
    contents.push(text.slice(0, stop));
    break;
  }
  if (silent) return true;
  state.line = Math.min(line + 1, end);
  const token = state.push(line === end ? 'unclosed_tex_section' : open[1] + '_block', '', 0);
  token.map = [start, state.line];
  token.content = contents.join('\n');
  token.markup = open[1];
  return true;
}, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

markdown.inline.ruler.before('html_inline', 'tex_section', (state, silent) => {
  if (state.src[state.pos] !== '<') return false;
  const open = tagStart.exec(state.src.slice(state.pos, state.pos + 7));
  if (!open) return false;
  const start = state.pos + open[0].length;
  const close = '</' + open[1] + '>';
  const end = state.src.indexOf(close, start);
  const closed = end >= start && end + close.length <= state.posMax;
  if (!silent) {
    const token = state.push(closed ? open[1] + '_inline' : 'unclosed_tex_section', '', 0);
    token.content = closed ? state.src.slice(start, end) : '';
    token.markup = open[1];
  }
  state.pos = closed ? end + close.length : start;
  return true;
});

const special = new Map([
  ['\\', '\\textbackslash{}'], ['~', '\\textasciitilde{}'], ['^', '\\textasciicircum{}'],
  ['<', '\\textless{}'], ['>', '\\textgreater{}'], ['|', '\\textbar{}'],
]);

function escapeTex(text: string): string {
  return text.replace(/[\\{}#$%&_^~<>|]/g, character => special.get(character) ?? '\\' + character);
}

function link(url: string | number | null): string {
  return typeof url === 'string' && /^(?:https?:\/\/|mailto:)[^\s\\{}]+$/i.test(url) ? '\\href{' + url + '}{' : '{';
}

function image(token: Token): string {
  let path: string;
  try { path = decodeURIComponent(String(token.attrGet('src') ?? '')); }
  catch { path = ''; }
  if (!/^[\w./ -]+\.(?:png|jpe?g|pdf)$/i.test(path) || path.startsWith('/')) {
    return escapeTex(token.content);
  }
  return '\\includegraphics[width=.8\\linewidth,keepaspectratio]{' + path + '}';
}

const inlineTex = new Map([
  ['em_open', '\\emph{'], ['strong_open', '\\textbf{'], ['em_close', '}'],
  ['strong_close', '}'], ['link_close', '}'], ['softbreak', '\n'], ['hardbreak', '\\newline\n'],
]);

export class UnclosedTexSection extends Error {
  readonly line: number;

  constructor(tag: string, line: number) {
    super('Add </' + tag + '> to close the <' + tag + '> section.');
    this.line = line;
  }
}

function renderInline(tokens: readonly Token[], firstLine: number): string {
  let line = firstLine;
  return tokens.map(token => {
    const start = line;
    line += token.content.split('\n').length - 1;
    if (token.type === 'unclosed_tex_section') throw new UnclosedTexSection(token.markup, start);
    switch (token.type) {
      case 'text':
      case 'text_special': return escapeTex(token.content);
      case 'code_inline': return '\\texttt{' + escapeTex(token.content) + '}';
      case 'latex_inline': return token.content;
      case 'math_inline': return '\\(' + token.content + '\\)';
      case 'link_open': return link(token.attrGet('href'));
      case 'image': return image(token);
      case 'softbreak':
      case 'hardbreak': line++; break;
    }
    return inlineTex.get(token.type) ?? '';
  }).join('');
}

const blockTex = new Map([
  ['heading_close', '}\n'], ['paragraph_close', '\\par\n'],
  ['blockquote_open', '\\begin{quote}\n'], ['blockquote_close', '\\end{quote}\n'],
  ['bullet_list_open', '\\begin{itemize}\n'], ['bullet_list_close', '\\end{itemize}\n'],
  ['ordered_list_open', '\\begin{enumerate}\n'], ['ordered_list_close', '\\end{enumerate}\n'],
  ['list_item_open', '\\item '], ['hr', '\\par\\noindent\\rule{\\linewidth}{.4pt}\\par\n'],
  ['table_close', '\\end{tabular}\\par\n'], ['tr_close', '\\\\\n'],
  ['thead_close', '\\hline\n'], ['th_open', '\\textbf{'],
]);
const headings = ['section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'subparagraph'];
const listCounters = ['enumi', 'enumii', 'enumiii', 'enumiv'];

export interface MarkdownDocument {
  readonly tex: string;
  readonly sourceLines: readonly (number | undefined)[];
}

/** Render a Markdown root as a TeX document and retain the origin of each emitted line. */
export function markdownDocument(source: string): MarkdownDocument {
  const tokens = markdown.parse(source, {});
  const parts: string[] = [];
  const sourceLines: (number | undefined)[] = [];
  let generatedLine = 0;
  let listDepth = 0;
  let line: number | undefined;

  function emit(tex: string, start?: number, sequential = false) {
    const lines = tex.split('\n');
    for (const [index, content] of lines.entries()) {
      if (content && start !== undefined) sourceLines[generatedLine] ??= start + (sequential ? index : 0);
      if (index < lines.length - 1) generatedLine++;
    }
    parts.push(tex);
  }

  emit('\\documentclass{article}\n\\usepackage{amsmath,amssymb,graphicx,hyperref}\n\\begin{document}\n');
  for (const [index, token] of tokens.entries()) {
    if (token.map) line = token.map[0] + 1;
    switch (token.type) {
      case 'inline':
        emit(renderInline(token.children ?? [], line ?? 1), line, true);
        break;
      case 'unclosed_tex_section':
        throw new UnclosedTexSection(token.markup, line ?? 1);
      case 'latex_block':
        emit(token.content + '\n', line, true);
        break;
      case 'math_block':
        emit('\\[\n');
        // TeX treats a blank line as a paragraph break, including inside display math.
        emit(token.content.replace(/^[\t ]*$/gm, '%') + '\n', line, true);
        emit('\\]\n');
        break;
      case 'heading_open':
        emit('\\' + headings[Number(token.tag[1]) - 1] + '*{', line);
        break;
      case 'ordered_list_open': {
        emit(blockTex.get(token.type)!);
        const start = Number(token.attrGet('start') ?? 1);
        if (start !== 1 && listCounters[listDepth]) {
          emit('\\setcounter{' + listCounters[listDepth] + '}{' + (start - 1) + '}\n');
        }
        listDepth++;
        break;
      }
      case 'ordered_list_close':
        listDepth--;
        emit(blockTex.get(token.type)!);
        break;
      case 'table_open': {
        const columns: string[] = [];
        for (let i = index + 1; tokens[i]?.type !== 'thead_close' && i < tokens.length; i++) {
          if (tokens[i].type === 'th_open') {
            const align = String(tokens[i].attrGet('style') ?? '').match(/text-align:(left|center|right)/)?.[1];
            columns.push(align?.[0] ?? 'l');
          }
        }
        emit('\\par\\noindent\\begin{tabular}{' + columns.join('') + '}\n');
        break;
      }
      case 'th_close':
      case 'td_close':
        if (token.type === 'th_close') emit('}');
        if (tokens[index + 1]?.type !== 'tr_close') emit(' & ');
        break;
      case 'fence':
      case 'code_block':
        emit('\\begin{quote}\\ttfamily\\raggedright\n');
        emit(token.content.replace(/\n$/, '').split('\n')
          .map(text => '\\strut ' + escapeTex(text).replace(/ /g, '\\ ') + '\\par').join('\n') + '\n',
        token.type === 'fence' && line !== undefined ? line + 1 : line, true);
        emit('\\end{quote}\n');
        break;
      default:
        emit(blockTex.get(token.type) ?? '', line);
    }
  }
  emit('\\end{document}\n');
  return { tex: parts.join(''), sourceLines };
}
