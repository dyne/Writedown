import { defineConfig } from 'vite';
import { join } from 'node:path';
import { readVerifiedAsset, release } from './scripts/assets.ts';

export default defineConfig(({ command }) => ({
  base: '/writedown/',
  // Vite recursively copies public/, including leftovers from interrupted runs.
  publicDir: command === 'build' ? false : 'public',
  plugins: [{
    name: 'verified-compiler-assets',
    async generateBundle() {
      const directory = join(import.meta.dirname, 'public/compiler', release.id);
      for (const file of release.files) {
        this.emitFile({
          type: 'asset',
          fileName: `compiler/${release.id}/${file.path}`,
          source: await readVerifiedAsset(directory, file),
        });
      }
    },
  }],
}));
