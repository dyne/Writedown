import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readVerifiedAsset, release } from './scripts/assets.ts';
import { pdfAssetContentType, pdfAssets } from './scripts/pdf-assets.ts';

const base = '/writedown/';

function digest(source: string | Uint8Array): string {
  return createHash('sha256').update(source).digest('hex');
}

export default defineConfig(({ command }) => ({
  base,
  // Vite recursively copies public/, including leftovers from interrupted runs.
  publicDir: command === 'build' ? false : 'public',
  plugins: [{
    name: 'local-pdf-assets',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (!path.startsWith(base)) return next();
        const source = pdfAssets.get(path.slice(base.length));
        if (!source) return next();
        try {
          const bytes = await readFile(source);
          response.setHeader('Content-Type', pdfAssetContentType(source));
          response.end(bytes);
        } catch (error) {
          next(error);
        }
      });
    },
  }, {
    name: 'verified-compiler-assets',
    generateBundle: {
      order: 'post',
      async handler(_, bundle) {
        const directory = join(import.meta.dirname, 'public/compiler', release.id);
        const compilerFiles = [];
        for (const file of release.files) {
          const path = `compiler/${release.id}/${file.path}`;
          this.emitFile({
            type: 'asset',
            fileName: path,
            source: await readVerifiedAsset(directory, file),
          });
          compilerFiles.push({ path, bytes: file.bytes, sha256: file.sha256 });
        }
        const shellFiles = Object.values(bundle)
          .filter(file => file.fileName === 'index.html' || file.fileName.startsWith('assets/'))
          .map(file => {
            const source = file.type === 'asset' ? file.source : file.code;
            return {
              path: file.fileName, bytes: Buffer.from(source).byteLength, sha256: digest(source),
            };
          });
        for (const [path, sourcePath] of pdfAssets) {
          const source = await readFile(sourcePath);
          this.emitFile({ type: 'asset', fileName: path, source });
          shellFiles.push({ path, bytes: source.byteLength, sha256: digest(source) });
        }
        shellFiles.sort((left, right) => left.path.localeCompare(right.path));
        if (!shellFiles.some(file => file.path === 'index.html')) {
          this.error('Cannot publish offline access without the generated app shell.');
        }
        const runtime = await readFile(join(import.meta.dirname, 'src/offline/service-worker.js'), 'utf8');
        const files = [...shellFiles, ...compilerFiles];
        const build = digest(JSON.stringify({ files, runtime }));
        this.emitFile({
          type: 'asset',
          fileName: 'service-worker.js',
          source: `const manifest = ${JSON.stringify({ build, release: release.id, files })};\n${runtime}`,
        });
      },
    },
  }],
}));
