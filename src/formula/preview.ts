import { editorEvents } from '../editor/project-editor.ts';
import type { SourceSelection } from '../editor/project-editor.ts';
import type { ProjectSnapshot } from '../project/snapshot.ts';
import { FormulaError, formulaMacroPath, parseFormulaFragment } from './fragment.ts';
import type { FormulaRenderer } from './fragment.ts';

export function mountFormulaPreview(editor: HTMLElement, pane: HTMLElement, katex: FormulaRenderer, svg: FormulaRenderer) {
  pane.className = 'formula-preview';
  pane.setAttribute('aria-labelledby', 'formula-title');
  pane.innerHTML = String.raw`
    <header class="formula-header">
      <h2 id="formula-title">Formula preview</h2>
      <label for="formula-renderer" class="visually-hidden">Formula renderer</label>
      <select id="formula-renderer">
        <option value="katex">KaTeX</option>
        <option value="svg">MathJax SVG</option>
      </select>
    </header>
    <div class="formula-result" hidden></div>
    <p class="formula-status" role="status">Select a math expression in the source.</p>
    <details class="formula-help">
      <summary>Project macros</summary>
      <p>Add one <code>\newcommand{\name}{…}</code> per line to <code>formula-macros.tex</code>
        at the project root. The preview uses this file for the current project.</p>
    </details>`;
  const output = pane.querySelector<HTMLElement>('.formula-result')!;
  const status = pane.querySelector<HTMLElement>('.formula-status')!;
  const choice = pane.querySelector<HTMLSelectElement>('#formula-renderer')!;
  let snapshot: ProjectSnapshot | undefined;
  let selection: SourceSelection | null = null;
  let renderedText: string | undefined;
  let renderedMacros: string | undefined;
  let renderedProject: string | undefined;
  let renderedChoice: string | undefined;
  let generation = 0;

  function update() {
    const text = selection?.projectId === snapshot?.projectId ? selection?.text ?? '' : '';
    const macroFile = snapshot?.files.find(file => file.path === formulaMacroPath);
    const macros = macroFile?.kind === 'text' ? macroFile.text : '';
    if (text === renderedText && macros === renderedMacros &&
        snapshot?.projectId === renderedProject && choice.value === renderedChoice) return;
    renderedText = text;
    renderedMacros = macros;
    renderedProject = snapshot?.projectId;
    renderedChoice = choice.value;
    const current = ++generation;
    output.replaceChildren();
    output.hidden = true;
    status.classList.remove('formula-error');

    const draft = document.createElement('div');
    function publish() {
      if (current !== generation) return;
      output.replaceChildren(...draft.childNodes);
      output.hidden = false;
      status.textContent = '';
    }
    function fail(error: unknown) {
      if (current !== generation) return;
      status.classList.add('formula-error');
      status.textContent = 'Could not preview this formula. ' + (
        error instanceof FormulaError ? error.message : 'Edit the selection and try again.'
      );
    }
    try {
      const fragment = parseFormulaFragment(text, macros);
      if (fragment) {
        const task = (choice.value === 'svg' ? svg : katex).render(fragment, draft);
        if (task) {
          status.textContent = 'Preparing SVG preview…';
          void task.then(publish, fail);
        } else publish();
      } else {
        status.textContent = 'Select a math expression in the source.';
      }
    } catch (error) {
      fail(error);
    }
  }

  editor.addEventListener(editorEvents.snapshot, event => {
    snapshot = (event as CustomEvent<ProjectSnapshot>).detail;
    update();
  });
  editor.addEventListener(editorEvents.selection, event => {
    selection = (event as CustomEvent<SourceSelection | null>).detail;
    update();
  });
  choice.addEventListener('change', update);
}
