import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';

const require = createRequire(import.meta.url);
const manifest = require.resolve('pdfjs-dist/package.json');
const root = dirname(manifest);
const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string };
const prefix = `assets/pdfjs-${version}/`;
const locations = new Map<string, string>();

function include(path: string) {
  locations.set(prefix + path, join(root, path));
}

include('LICENSE');
for (const [directory, extension] of [
  ['cmaps', /\.bcmap$/],
  ['standard_fonts', /\.(pfb|ttf)$/],
  ['iccs', /\.icc$/],
  ['wasm', /^(?:(jbig2|openjpeg)(?:\.wasm|_nowasm_fallback\.js)|qcms_bg\.wasm)$/],
] as const) {
  for (const name of readdirSync(join(root, directory))) {
    if (extension.test(name) || (name.startsWith('LICENSE') && !name.includes('QUICKJS'))) {
      include(`${directory}/${name}`);
    }
  }
}

export const pdfAssets: ReadonlyMap<string, string> = locations;

export function pdfAssetContentType(path: string): string {
  switch (extname(path)) {
    case '.js': return 'text/javascript';
    case '.wasm': return 'application/wasm';
    default: return 'application/octet-stream';
  }
}
