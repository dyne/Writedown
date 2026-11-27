import release from '../compiler-release.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

export { release };
const repository = resolve(import.meta.dirname, '..');

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function matches(path: string, expected: { bytes: number; sha256: string }): Promise<boolean> {
  try { return (await stat(path)).size === expected.bytes && await digest(path) === expected.sha256; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function verifyPreparedAssets(directory: string): Promise<string[]> {
  const invalid: string[] = [];
  for (const file of release.files) {
    if (!await matches(join(directory, file.path), file)) invalid.push(file.path);
  }
  return invalid;
}

/** Validate the exact bytes handed to the bundler, closing the verify/copy gap. */
export async function readVerifiedAsset(directory: string, file: { path: string; bytes: number; sha256: string }): Promise<Buffer> {
  const bytes = await readFile(join(directory, file.path));
  if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
    throw new Error(`Compiler asset digest/size mismatch: ${file.path}`);
  }
  return bytes;
}

async function* chunks(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally { reader.releaseLock(); }
}

async function extract(archive: string, staging: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const files = release.files.filter(file => file.source === 'archive').map(file => file.sourcePath);
  await new Promise<void>((resolveExtracted, reject) => {
    const child = spawn('tar', ['-xzf', archive, '-C', staging, '--strip-components=1', ...files], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr += String(data); });
    const abort = () => { child.kill('SIGTERM'); };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', reject);
    child.once('close', (code, childSignal) => {
      signal?.removeEventListener('abort', abort);
      if (code === 0 && !signal?.aborted) resolveExtracted();
      else reject(new Error(`Extraction failed: exit=${code} signal=${childSignal}: ${stderr}`));
    });
  });
}

export interface PrepareOptions {
  assetRoot?: string;
  cacheDirectory?: string;
  archivePath?: string;
  signal?: AbortSignal;
  onPhase?: (event: Record<string, unknown>) => void;
}

export async function prepareAssets(options: PrepareOptions = {}) {
  const assetRoot = resolve(options.assetRoot ?? join(repository, 'public/compiler'));
  const target = join(assetRoot, release.id);
  const onPhase = options.onPhase ?? (() => {});
  const invalid = await verifyPreparedAssets(target);
  if (invalid.length === 0) {
    onPhase({ phase: 'reused', target, verifiedFiles: release.files.length });
    return target;
  }
  onPhase({ phase: 'repair-needed', invalid });
  const cacheDirectory = resolve(options.cacheDirectory ?? join(repository, '.cache/compiler'));
  const archive = resolve(options.archivePath ?? join(cacheDirectory, `${release.archive.sha256}.tar.gz`));
  if (!await matches(archive, release.archive)) {
    if (options.archivePath) throw new Error(`Pinned archive digest/size mismatch: ${archive}`);
    await mkdir(cacheDirectory, { recursive: true });
    const temporary = `${archive}.${process.pid}.partial`;
    try {
      onPhase({ phase: 'downloading', url: release.archive.url });
      const response = await fetch(release.archive.url, { signal: options.signal });
      if (!response.ok || !response.body) throw new Error(`Asset download HTTP ${response.status}`);
      await pipeline(Readable.from(chunks(response.body)), createWriteStream(temporary), { signal: options.signal });
      if (!await matches(temporary, release.archive)) throw new Error('Downloaded archive digest/size mismatch');
      await rename(temporary, archive);
    } finally { await rm(temporary, { force: true }); }
  }
  options.signal?.throwIfAborted();
  await mkdir(assetRoot, { recursive: true });
  // Default scratch is outside public. Custom writable roots own their scratch,
  // requiring neither a writable parent nor access to the repository cache.
  const stagingRoot = assetRoot === join(repository, 'public/compiler')
    ? join(repository, '.cache/compiler-staging')
    : join(assetRoot, '.writedown-compiler-staging');
  await mkdir(stagingRoot, { recursive: true });
  const staging = await mkdtemp(join(stagingRoot, `.${release.id}-stage-`));
  const backup = `${staging}-previous`;
  try {
    onPhase({ phase: 'extracting', staging });
    await extract(archive, staging, options.signal);
    for (const file of release.files.filter(file => file.source === 'repository')) {
      await copyFile(join(repository, file.sourcePath), join(staging, file.path));
    }
    const incomplete = await verifyPreparedAssets(staging);
    if (incomplete.length) throw new Error(`Incomplete staged set: ${incomplete.join(', ')}`);
    options.signal?.throwIfAborted();
    // Publish the complete verified set with same-filesystem directory renames.
    try { await rename(target, backup); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { await rename(staging, target); }
    catch (error) {
      try { await rename(backup, target); } catch { /* retained backup is recoverable on retry */ }
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
    onPhase({ phase: 'published', target, verifiedFiles: release.files.length, shippedBytes: release.shippedBytes });
    return target;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
