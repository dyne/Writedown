import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SourceSelection } from '../../src/editor/project-editor.ts';
import type { ProjectSnapshot } from '../../src/project/snapshot.ts';
import { startStaticServer } from '../support/static-server.ts';

declare global {
  interface Window {
    projectEditorAdapter: { snapshot?: ProjectSnapshot; selection?: SourceSelection | null };
  }
}

const figure = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCy0AAAAASUVORK5CYII=', 'base64');
const chapterPath = 'paper/chapters/intro.tex';
const chapter = String.raw`\section{Introduction}
The local editor retains $x^2 + y^2$.
The last line stays in the chapter.`;
const bibliographyPath = 'paper/references.bib';
const bibliography = '@book{notes,\n  title = {Field Notes},\n  author = {Quinn, Alex}\n}';

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  for (const scale of [100, 200]) {
    test(`project-editor ${viewport.width}x${viewport.height} text-${scale}`, async ({ page }, testInfo) => {
      const name = 'Working notes';
      const folder = testInfo.outputPath('paper');
      await mkdir(join(folder, 'chapters'), { recursive: true });
      await mkdir(join(folder, 'images'));
      await Promise.all([
        writeFile(join(folder, 'root.tex'), String.raw`\documentclass{article}\begin{document}\input{chapters/intro}\end{document}`),
        writeFile(join(folder, 'chapters', 'intro.tex'), 'Original chapter'),
        writeFile(join(folder, 'images', 'figure.png'), figure),
      ]);
      const server = await startStaticServer(resolve('dist'));
      try {
        await page.setViewportSize(viewport);
        await page.addInitScript(textScale => {
          window.projectEditorAdapter = {};
          window.addEventListener('writedown:snapshot', event => {
            window.projectEditorAdapter.snapshot = (event as CustomEvent<ProjectSnapshot>).detail;
          });
          window.addEventListener('writedown:selection', event => {
            window.projectEditorAdapter.selection = (event as CustomEvent<SourceSelection | null>).detail;
          });
          document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = `${textScale}%`; });
        }, scale);
        await page.goto(server.url);
        const projectChoice = page.getByRole('combobox', { name: 'Project', exact: true });
        const fileChoice = page.getByRole('combobox', { name: 'File', exact: true });
        const rootChoice = page.getByRole('combobox', { name: 'Root document' });
        const source = page.getByRole('textbox', { name: 'Source code' });
        await expect(projectChoice).toHaveValue('Untitled project');
        await expect(projectChoice).toBeEnabled();
        await expect(page.locator('#source-empty')).toHaveText('Create a .tex, .md, or .bib file, or import your sources.');

        await page.getByText('New project', { exact: true }).press('Enter');
        await page.getByRole('textbox', { name: 'Project name' }).fill(name);
        await page.getByRole('button', { name: 'Create project' }).press('Enter');
        await expect(projectChoice).toHaveValue(name);
        await page.getByText('New source file', { exact: true }).press('Enter');
        await page.getByRole('textbox', { name: 'File path' }).fill('draft.tex');
        await page.getByRole('button', { name: 'Create file' }).press('Enter');
        await expect(source).toBeFocused();
        await source.fill('A separate draft');
        await expect(rootChoice).toHaveValue('draft.tex');

        const choosingFolder = page.waitForEvent('filechooser', { timeout: 5_000 });
        await page.getByRole('button', { name: 'Import folder' }).press('Enter');
        const chooser = await choosingFolder;
        // Headless Chromium can hang during automation of a native directory input at 390px.
        // Open the control at the case viewport and widen only while Playwright supplies the folder.
        if (viewport.width === 390) await page.setViewportSize({ width: 1280, height: viewport.height });
        try {
          await chooser.setFiles(folder, { timeout: 5_000 });
        } finally {
          if (viewport.width === 390) await page.setViewportSize(viewport);
        }
        await expect(fileChoice.locator('option')).toHaveText(['draft.tex', chapterPath, 'paper/images/figure.png', 'paper/root.tex']);
        await fileChoice.selectOption(chapterPath);
        await expect(source).toHaveValue('Original chapter');
        await source.fill(chapter.slice(0, -1));
        await source.press('End');
        const beforeEdit = await page.evaluate(() => window.projectEditorAdapter.snapshot!.revision);
        await source.press('.');
        const edited = await page.evaluate(() => window.projectEditorAdapter.snapshot!);
        expect(edited.revision).toBe(beforeEdit + 1);
        expect(edited.files).toContainEqual({ kind: 'text', path: chapterPath, text: chapter });

        const expression = 'x^2 + y^2';
        await source.evaluate((text: HTMLTextAreaElement, query) => {
          const from = text.value.indexOf(query);
          text.setSelectionRange(from, from + query.length);
        }, expression);
        await expect.poll(() => page.evaluate(() => window.projectEditorAdapter.selection)).toEqual({
          projectId: name, revision: edited.revision, path: chapterPath, text: expression,
        });

        await page.getByText('New source file', { exact: true }).press('Enter');
        await page.getByRole('textbox', { name: 'File path' }).fill(bibliographyPath);
        await page.getByRole('button', { name: 'Create file' }).press('Enter');
        await expect(source).toBeFocused();
        await source.fill(bibliography);
        await rootChoice.selectOption('paper/root.tex');
        const engine = page.getByRole('combobox', { name: 'Engine' });
        const bibMode = page.getByRole('combobox', { name: 'Bibliography' });
        await engine.selectOption('xelatex');
        await bibMode.selectOption('bibtex');
        const received = await page.evaluate(async () => {
          const { files, ...settings } = window.projectEditorAdapter.snapshot!;
          return {
            settings, paths: files.map(file => file.path).sort(),
            figure: await Promise.all(files.filter(file => file.kind === 'binary')
              .map(async file => [...new Uint8Array(await file.bytes.arrayBuffer())])),
            bibliography: files.find(file => file.path.endsWith('.bib')),
          };
        });
        expect(received.settings).toMatchObject({ projectId: name, entryPath: 'paper/root.tex', engine: 'xelatex', bibliography: 'bibtex' });
        expect(received.paths).toEqual(['draft.tex', chapterPath, 'paper/images/figure.png', bibliographyPath, 'paper/root.tex']);
        expect(received.figure).toEqual([[...figure]]);
        expect(received.bibliography).toEqual({ kind: 'text', path: bibliographyPath, text: bibliography });
        await page.getByRole('button', { name: 'Save now' }).press('Enter');
        await expect(page.locator('#project-save-status')).toHaveText('Saved on this device.');

        await page.reload();
        await expect(projectChoice).toHaveValue('Untitled project');
        await projectChoice.selectOption(name);
        await expect(rootChoice).toHaveValue('paper/root.tex');
        await expect(engine).toHaveValue('xelatex');
        await expect(bibMode).toHaveValue('bibtex');
        expect(await page.evaluate(() => window.projectEditorAdapter.snapshot?.revision)).toBe(received.settings.revision);
        await fileChoice.selectOption(bibliographyPath);
        await expect(source).toHaveValue(bibliography);
        await fileChoice.selectOption('paper/images/figure.png');
        await expect(page.getByText('Binary file included in the project.')).toBeVisible();
        await fileChoice.selectOption(chapterPath);
        await expect(source).toHaveValue(chapter);

        // Expanded creation forms and the main editor share one native tab order.
        const newProject = page.getByText('New project', { exact: true });
        const newFile = page.getByText('New source file', { exact: true });
        await newProject.press('Enter');
        await newFile.press('Enter');
        await projectChoice.focus();
        const tabOrder = [
          'new-project', 'new-project-name', 'create-project', 'file-choice', 'import-files', 'import-folder',
          'new-file', 'new-file-path', 'create-file', 'root-choice', 'engine-choice', 'bibliography-choice',
          'source-format', 'source-line', 'go-to-line', 'source-text', 'save-project',
        ];
        for (const id of tabOrder) {
          await page.keyboard.press('Tab');
          await expect(page.locator(`#${id}`)).toBeFocused();
        }
        await newProject.press('Enter');
        await newFile.press('Enter');
        await page.getByRole('spinbutton', { name: 'Line' }).fill('3');
        await page.getByRole('button', { name: 'Go to line' }).press('Enter');
        await expect(source).toBeFocused();
        expect(await source.evaluate((text: HTMLTextAreaElement) => text.value.slice(text.selectionStart, text.selectionEnd)))
          .toBe('The last line stays in the chapter.');

        await fileChoice.selectOption(bibliographyPath);
        await page.getByRole('region', { name: 'Project editor' }).evaluate((editor, detail) => {
          editor.dispatchEvent(new CustomEvent('writedown:open-source', { detail }));
        }, { path: chapterPath, line: 2 });
        await expect(fileChoice).toHaveValue(chapterPath);
        await expect(page.getByRole('heading', { name: chapterPath })).toBeVisible();
        await expect(page.getByRole('spinbutton', { name: 'Line' })).toHaveValue('2');
        await expect(source).toBeFocused();
        expect(await source.evaluate((text: HTMLTextAreaElement) => text.value.slice(text.selectionStart, text.selectionEnd)))
          .toBe('The local editor retains $x^2 + y^2$.');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(server.requests.filter(request => request.status >= 400)).toEqual([]);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: testInfo.outputPath('project-editor.png'), fullPage: true });
      } finally {
        await testInfo.attach('server-requests', { body: JSON.stringify(server.requests), contentType: 'application/json' });
        await server.close();
      }
    });
  }
}
