import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { mathJaxPath, mathJaxScripts } from '../src/formula/mathjax-assets.ts';

const resolve = createRequire(import.meta.url).resolve;
const sources = new Map(Object.entries(mathJaxScripts).map(([path, sha256]) => [
  mathJaxPath + path,
  { sha256, source: resolve(path.startsWith('fonts/') ? '@mathjax/mathjax-tex-font/svg.js' : 'mathjax/' + path) },
]));
sources.set(mathJaxPath + 'LICENSE.txt', {
  sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
  source: resolve('mathjax/LICENSE'),
});

export const mathJaxAssetPaths = [...sources.keys()];

export async function readMathJaxAsset(path: string) {
  const asset = sources.get(path);
  if (!asset) throw new Error('Unrecognized MathJax asset ' + path);
  const source = await readFile(asset.source);
  if (createHash('sha256').update(source).digest('hex') !== asset.sha256) {
    throw new Error('MathJax asset SHA-256 mismatch for ' + path);
  }
  return { source, sha256: asset.sha256 };
}
