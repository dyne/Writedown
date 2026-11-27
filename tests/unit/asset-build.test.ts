import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { release } from '../../scripts/assets.ts';

test('production build ships only pinned compiler bytes despite public staging, backup and unlisted leftovers', { timeout: 90_000 }, async () => {
  const parent = resolve(process.env.WRITEDOWN_ASSET_TEST_OUTPUT ?? 'test-results');
  await mkdir(parent, { recursive: true });
  const fixture = await mkdtemp(join(parent, 'asset-build-'));
  const source = resolve('.');
  for (const path of ['index.html', 'package.json', 'tsconfig.json', 'vite.config.ts', 'compiler-release.json', 'src', 'scripts']) {
    await cp(join(source, path), join(fixture, path), { recursive: true });
  }
  await symlink(join(source, 'node_modules'), join(fixture, 'node_modules'), 'dir');
  const published = join(fixture, 'public/compiler', release.id);
  await cp(join(source, 'public/compiler', release.id), published, { recursive: true });
  const leftovers = [
    `compiler/.${release.id}-stage-leftover/partial.wasm`,
    `compiler/.${release.id}-stage-leftover-previous/private.log`,
    `compiler/${release.id}/unlisted.data`,
    'unlisted-public.txt',
  ];
  for (const path of leftovers) {
    const target = join(fixture, 'public', path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, 'unverified bytes must not ship');
  }
  let output = '';
  const child = spawn('npm', ['run', 'build'], { cwd: fixture, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { output += String(data); });
  child.stderr.on('data', data => { output += String(data); });
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  await writeFile(join(fixture, 'build.log'), output);
  assert.equal(code, 0, output);
  async function files(directory: string): Promise<string[]> {
    const paths: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) paths.push(...await files(path));
      else paths.push(path);
    }
    return paths;
  }
  const emitted = (await files(join(fixture, 'dist/compiler'))).map(path => relative(join(fixture, 'dist/compiler'), path)).sort();
  assert.deepEqual(emitted, release.files.map(file => join(release.id, file.path)).sort());
  for (const file of release.files) {
    const bytes = await readFile(join(fixture, 'dist/compiler', release.id, file.path));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  }
  const allOutput = await files(join(fixture, 'dist'));
  assert.equal(allOutput.some(path => path.endsWith('unlisted-public.txt')), false);
  await writeFile(join(fixture, 'proof.json'), JSON.stringify({ command: 'npm run build', cwd: fixture, exit: code, leftovers, emitted, validatedFiles: release.files.length }, null, 2));
});
