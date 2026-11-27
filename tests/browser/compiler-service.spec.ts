import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { CompilationState } from '../../src/compiler/service.ts';
import { startStaticServer } from '../support/static-server.ts';

declare global {
  interface Window {
    liveCompilerProof: {
      states: CompilationState[];
      posted: number;
      hold: boolean;
      replyHeld: boolean;
      release?: () => void;
    };
  }
}

test('the production editor accepts a new revision during real worker compilation', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const server = await startStaticServer(resolve('dist'));
  const workers: string[] = [];
  page.on('worker', worker => workers.push(worker.url()));
  await page.addInitScript(() => {
    const proof: Window['liveCompilerProof'] = { states: [], posted: 0, hold: true, replyHeld: false };
    window.liveCompilerProof = proof;
    window.addEventListener('writedown:compilation-state', event => {
      proof.states.push((event as CustomEvent<CompilationState>).detail);
    });
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: { files?: unknown }) {
      if (message.files && ++proof.posted === 1) {
        // Let the genuine worker compile A. Hold its reply at delivery so
        // typing precedes publication regardless of host CPU speed.
        const worker = this;
        const receive = worker.onmessage;
        worker.onmessage = event => {
          if (proof.hold && event.data.pdf !== undefined) {
            proof.replyHeld = true;
            proof.release = () => {
              proof.replyHeld = false;
              proof.release = undefined;
              receive?.call(worker, event);
            };
          } else receive?.call(worker, event);
        };
      }
      return Reflect.apply(post, this, arguments);
    };
  });

  try {
    await page.goto(server.url);
    await page.getByText('New source file', { exact: true }).press('Enter');
    await page.getByRole('textbox', { name: 'File path' }).fill('main.tex');
    await page.getByRole('button', { name: 'Create file', exact: true }).press('Enter');
    const source = page.getByRole('textbox', { name: 'Source code' });
    const status = page.locator('#project-compile-status');
    const first = String.raw`\documentclass{article}\begin{document}Obsolete revision marker.\end{document}`;
    const second = first.replace('Obsolete revision marker.', 'Latest revision marker.');
    await source.fill(first);
    await expect.poll(() => page.evaluate(() => window.liveCompilerProof.posted), { timeout: 90_000 }).toBe(1);
    await expect(status).toHaveAttribute('data-state', 'compiling');
    const oldRevision = Number(await status.getAttribute('data-revision'));

    await source.fill(second);
    await expect(source).toHaveValue(second);
    // The first reply is still gated, so the latest revision waits even if
    // its 300 ms delay has already elapsed.
    await expect(status).toHaveAttribute('data-state', 'queued');
    await expect(status).toHaveAttribute('data-revision', String(oldRevision + 1));
    await expect.poll(() => page.evaluate(() => window.liveCompilerProof.replyHeld), { timeout: 30_000 }).toBe(true);
    const beforeRelease = await page.evaluate(() => {
      const proof = window.liveCompilerProof;
      return { posted: proof.posted, calls: proof.states.filter(state => state.status === 'settled').length };
    });
    expect(beforeRelease).toEqual({ posted: 1, calls: 0 });

    await page.evaluate(() => window.liveCompilerProof.release?.());
    await expect(status).toHaveText('Revision ' + (oldRevision + 1) + ' compiled.', { timeout: 90_000 });
    const captured = await page.evaluate(async () => {
      const proof = window.liveCompilerProof;
      const results = proof.states.filter(state => state.status === 'settled');
      const latest = results.at(-1)?.result;
      if (!latest || latest.status !== 'success') throw new Error('Expected a successful current attempt');
      return {
        posted: proof.posted,
        settled: results.map(state => state.result.attempt),
        generations: proof.states.flatMap(state => state.status === 'compiling' ? [state.attempt.workerGeneration] : []),
        pdf: Array.from(new Uint8Array(await latest.pdf.arrayBuffer())),
      };
    });
    expect(captured.posted).toBe(2);
    expect(captured.settled.map(attempt => attempt.revision)).toEqual([oldRevision + 1]);
    expect(captured.generations).toEqual([1, 1]);
    expect(workers.filter(url => url.endsWith('/busytex_worker.js'))).toHaveLength(1);
    expect(server.requests.filter(request => request.path.endsWith('/texlive-basic.data'))).toHaveLength(1);

    const { pdf, ...processing } = captured;
    const path = testInfo.outputPath('latest.pdf');
    await writeFile(path, Buffer.from(pdf));
    const { stdout } = await promisify(execFile)('pdftotext', [path, '-']);
    expect(stdout).toContain('Latest revision marker.');
    expect(stdout).not.toContain('Obsolete revision marker.');
    await writeFile(testInfo.outputPath('latest.txt'), stdout);
    await writeFile(testInfo.outputPath('attempts.json'), JSON.stringify({ ...processing, beforeRelease }, null, 2));
    await page.screenshot({ path: testInfo.outputPath('editor-compilation.png'), fullPage: true });
  } finally {
    try {
      await page.evaluate(() => {
        const proof = window.liveCompilerProof;
        if (!proof) return;
        proof.hold = false;
        proof.release?.();
        if (proof.replyHeld) throw new Error('The compiler reply gate is still held');
      }).catch(error => { if (!page.isClosed()) throw error; });
    } finally {
      await writeFile(testInfo.outputPath('requests.json'), JSON.stringify({ workers, requests: server.requests }, null, 2));
      await server.close();
    }
  }
});
