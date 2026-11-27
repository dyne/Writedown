import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { dependencyFiles, dependencyPath } from '../src/compiler/dependency-catalog.ts';
import { matches, readVerifiedAsset, release } from './assets.ts';

type PackedFile = { filename: string; start: number; end: number };
type Blocks = { offsets: number[]; sizes: number[]; successes: number[] };
type Decoder = { CHUNK_SIZE: number; uncompress(input: Uint8Array, output: Uint8Array): number };

function archivedFile(path: string) {
  const file = release.archive.extractedFiles.find(entry => entry.path === path);
  if (!file) throw new Error(`Dependency source is outside the pinned BusyTeX archive inventory: ${path}`);
  return file;
}

function decoder(engine: string): Decoder {
  // Reuse the Emscripten MiniLZ4 decoder from the verified engine asset.
  const from = engine.indexOf('var MiniLZ4 =');
  const to = engine.indexOf("if (typeof module != 'undefined')", from);
  if (from < 0 || to < from) throw new Error('The pinned BusyTeX engine has no recognized MiniLZ4 codec.');
  const scope: { assert(condition: boolean): void; MiniLZ4?: Decoder } = {
    assert(condition) { if (!condition) throw new Error('Invalid MiniLZ4 block.'); },
  };
  runInNewContext(engine.slice(from, to), scope, {
    timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false },
  });
  if (!scope.MiniLZ4) throw new Error('The pinned BusyTeX engine could not initialize MiniLZ4.');
  return scope.MiniLZ4;
}

async function unpack(data: FileHandle, blocks: Blocks, file: PackedFile, codec: Decoder): Promise<Buffer> {
  const output = Buffer.alloc(file.end - file.start);
  const size = codec.CHUNK_SIZE;
  for (let pos = file.start; pos < file.end;) {
    const index = Math.floor(pos / size);
    const packed = Buffer.alloc(blocks.sizes[index]);
    const { bytesRead } = await data.read(packed, 0, packed.length, blocks.offsets[index]);
    if (bytesRead !== packed.length) throw new Error('Truncated BusyTeX data block.');
    const decoded = blocks.successes[index] ? Buffer.alloc(size) : packed;
    const length = blocks.successes[index] ? codec.uncompress(packed, decoded) : packed.length;
    const offset = pos % size;
    const count = Math.min(file.end - pos, size - offset);
    if (length < offset + count || length > size) throw new Error('Invalid BusyTeX data block length.');
    output.set(decoded.subarray(offset, offset + count), pos - file.start);
    pos += count;
  }
  return output;
}

export async function prepareDependencies(output: string) {
  const archive = resolve(process.env.WRITEDOWN_ASSET_ARCHIVE ??
    join(process.env.WRITEDOWN_ASSET_CACHE ?? join(import.meta.dirname, '../.cache/compiler'), `${release.archive.sha256}.tar.gz`));
  if (!await matches(archive, release.archive)) throw new Error(`Pinned archive digest/size mismatch: ${archive}. Run npm run assets:prepare first.`);
  const scratch = await mkdtemp(join(tmpdir(), 'writedown-tex-dependencies-'));
  try {
    const bundles = new Set(dependencyFiles.map(file => file.archiveBundle));
    const sources = ['busytex.js', ...[...bundles].flatMap(bundle => [bundle + '.js', bundle + '.data'])];
    await promisify(execFile)('tar', [
      '-xzf', archive, '-C', scratch, '--strip-components=1', ...sources.map(source => 'busytex/' + source),
    ]);
    const codec = decoder((await readVerifiedAsset(scratch, archivedFile('busytex.js'))).toString('utf8'));
    for (const bundle of bundles) {
      const loader = (await readVerifiedAsset(scratch, archivedFile(bundle + '.js'))).toString('utf8');
      const compressed = loader.match(/var compressedData = (\{[^\n]+\})\s*;/)?.[1];
      const metadata = loader.match(/loadPackage\((\{"files": [^\n]+\})\);/)?.[1];
      if (!compressed || !metadata) throw new Error(`Unsupported BusyTeX preload metadata: ${bundle}`);
      const blocks: Blocks = JSON.parse(compressed);
      const { files }: { files: PackedFile[] } = JSON.parse(metadata);
      const dataPath = join(scratch, bundle + '.data');
      if (!await matches(dataPath, archivedFile(bundle + '.data'))) throw new Error(`Unverified BusyTeX data: ${bundle}`);
      const data = await open(dataPath, 'r');
      try {
        for (const dependency of dependencyFiles.filter(file => file.archiveBundle === bundle)) {
          const packed = files.find(file => file.filename === dependency.archivePath);
          if (!packed) throw new Error(`Pinned package path is missing: ${dependency.archivePath}`);
          const bytes = await unpack(data, blocks, packed, codec);
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          if (bytes.length !== dependency.bytes || sha256 !== dependency.sha256) {
            throw new Error(`Catalog mismatch for ${dependency.name}; extracted ${bytes.length} bytes, SHA-256 ${sha256}.`);
          }
          const target = join(output, dependencyPath(dependency));
          await mkdir(dirname(target), { recursive: true });
          const staging = await mkdtemp(join(dirname(target), '.publish-'));
          try {
            const candidate = join(staging, dependency.name);
            await writeFile(candidate, bytes);
            await rename(candidate, target);
          } finally {
            await rm(staging, { recursive: true, force: true });
          }
        }
      } finally {
        await data.close();
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [output] = process.argv.slice(2);
  if (!output) throw new Error('Usage: node scripts/prepare-dependencies.ts <endpoint directory>');
  await prepareDependencies(output);
}
