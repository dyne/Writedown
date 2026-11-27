import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { startStaticServer } from '../support/static-server.ts';

const filename = 'notes.md';
const markdown = String.raw`# Local Markdown notes

The estimate is <math>\frac{1}{2}</math>.

<math>
\sqrt{2}
</math>

<latex>
\textbf{Raw TeX marker.}\par
</latex>
`;
const latex = String.raw`\documentclass{article}
\begin{document}
Switched format marker.
\end{document}
`;

test('Markdown uses the local PDF pipeline, diagnostics, and source navigation', async ({ page }, info) => {
  test.setTimeout(120_000);
  const server = await startStaticServer(resolve('dist'));
  const requests: string[] = [];
  page.context().on('request', request => requests.push(request.url()));
  try {
    await page.goto(server.url);
    await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toBeEnabled();
    await page.locator('#file-input').setInputFiles({ name: filename, mimeType: 'text/markdown', buffer: Buffer.from(markdown) });
    const entry = page.getByRole('combobox', { name: 'Root document' });
    const format = page.getByRole('combobox', { name: 'Input format' });
    const source = page.getByRole('textbox', { name: 'Source code' });
    const revision = page.locator('#pdf-revision');
    const diagnostics = page.getByRole('list', { name: 'Compilation diagnostics' });
    const pdfText = page.locator('.pdf-text');
    const rawMarker = pdfText.getByText('Raw TeX marker.', { exact: true });
    await expect(entry).toHaveValue(filename);
    await expect(format).toHaveValue('markdown');
    await expect(source).toHaveValue(markdown);
    await expect(revision).toContainText('Current', { timeout: 60_000 });
    await expect(pdfText).toContainText('Local Markdown notes');
    await expect(rawMarker).toBeVisible();

    await source.evaluate((editor: HTMLTextAreaElement) => {
      const start = editor.value.indexOf('\\textbf{Raw TeX marker.}');
      editor.setSelectionRange(start, start);
    });
    await page.getByRole('button', { name: 'Show in PDF' }).click();
    await expect(page.locator('.pdf-source-highlight')).toBeVisible();
    await rawMarker.dblclick();
    await expect(page.getByRole('spinbutton', { name: 'Line', exact: true })).toHaveValue('10');

    await source.fill(markdown.replace('\\textbf', '\\UnknownMarkdownCommand'));
    const sourceLink = diagnostics.getByRole('button', { name: `Open ${filename}, line 10`, exact: true });
    await expect(diagnostics).toContainText('Undefined control sequence.');
    await expect(sourceLink).toBeVisible();
    await expect(rawMarker).toBeVisible();

    await source.fill('# Local Markdown notes\n\nThe estimate is <math>1/2.');
    await expect(diagnostics).toContainText('Add </math> to close the <math> section.');
    await expect(diagnostics.getByRole('button', { name: `Open ${filename}, line 3`, exact: true })).toBeVisible();

    await source.fill(markdown);
    await page.setViewportSize({ width: 390, height: 844 });
    await format.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('markdown-editor.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

    await format.selectOption('latex');
    await expect(source).toHaveValue(markdown);
    await source.fill(latex);
    await expect(pdfText).toContainText('Switched format marker.', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Save now' }).click();
    await expect(page.locator('#project-save-status')).toHaveText('Saved on this device.');
    await expect(page.locator('#offline-status')).toHaveAttribute('data-state', 'ready', { timeout: 45_000 });
    await page.context().setOffline(true);
    await page.reload();
    await expect(format).toHaveValue('latex');
    await expect(source).toHaveValue(latex);
    await expect(pdfText).toContainText('Switched format marker.', { timeout: 60_000 });

    await format.selectOption('markdown');
    await source.fill(markdown);
    await expect(rawMarker).toBeVisible({ timeout: 30_000 });
    expect(requests.every(url => url.startsWith(server.url))).toBe(true);
  } finally {
    await server.close();
  }
});
