import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareAssets, release, verifyPreparedAssets } from '../../scripts/assets.ts';

test('pinned preparation survives real extraction interruption and repairs corruption before reuse', { timeout: 90_000 }, async () => {
  const parent = resolve(process.env.WRITEDOWN_ASSET_TEST_OUTPUT ?? 'test-results');
  await mkdir(parent, { recursive: true });
  const evidence = await mkdtemp(join(parent, 'asset-recovery-'));
  const assetRoot = join(evidence, 'public');
  const archive = process.env.WRITEDOWN_ASSET_ARCHIVE ?? resolve('.cache/compiler', `${release.archive.sha256}.tar.gz`);
  const target = join(assetRoot, release.id);
  const transcript: Record<string, unknown>[] = [];

  function launch() {
    const child = spawn(process.execPath, ['scripts/prepare-assets.ts'], {
      env: { ...process.env, WRITEDOWN_ASSET_ROOT: assetRoot, WRITEDOWN_ASSET_ARCHIVE: archive },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += String(data); });
    child.stderr.on('data', data => { stderr += String(data); });
    const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        transcript.push({ code, signal, stdout, stderr });
        resolveExit({ code, signal });
      });
    });
    return { child, completion, stdout: () => stdout };
  }

  try {
    const interrupted = launch();
    let wrotePartialBytes = false;
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const event = interrupted.stdout().split('\n').filter(Boolean).map(line => JSON.parse(line) as { phase: string; staging?: string }).find(item => item.phase === 'extracting');
        if (event?.staging) {
          assert.equal(event.staging.startsWith(resolve('public') + sep), false, 'staging is outside the application public tree');
          try {
            const size = (await stat(join(event.staging, 'texlive-basic.data'))).size;
            if (size > 0 && size < release.files.find(file => file.path === 'texlive-basic.data')!.bytes) {
              wrotePartialBytes = true;
              transcript.push({ interruptionPrecondition: 'partial texlive-basic.data exists', bytes: size, staging: event.staging });
              break;
            }
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        await delay(10);
      }
    } finally {
      interrupted.child.kill('SIGTERM');
      const stopped = await interrupted.completion;
      assert.equal(stopped.code, 143, 'CLI acknowledges cancellation and waits for tar to stop');
    }
    assert.equal(wrotePartialBytes, true, 'interruption happened during actual extraction');
    await assert.rejects(stat(target), { code: 'ENOENT' });
    assert.equal((await launch().completion).code, 0, 'retry publishes the complete pinned set');
    assert.deepEqual(await verifyPreparedAssets(target), []);
    await writeFile(join(target, 'busytex.wasm'), 'corrupt');
    assert.deepEqual(await verifyPreparedAssets(target), ['busytex.wasm']);
    assert.equal((await launch().completion).code, 0, 'corruption is restored');
    assert.deepEqual(await verifyPreparedAssets(target), []);
    assert.equal((await launch().completion).code, 0, 'verified files are reused');
    const last = transcript.at(-1);
    assert.match(String(last?.stdout), /"phase":"reused"/);
    // An untrusted/truncated archive is rejected before any output is published.
    const invalidArchive = join(evidence, 'invalid.tar.gz');
    await writeFile(invalidArchive, 'incomplete archive');
    const badRoot = join(evidence, 'bad-public');
    const rejected = spawn(process.execPath, ['scripts/prepare-assets.ts'], {
      env: { ...process.env, WRITEDOWN_ASSET_ROOT: badRoot, WRITEDOWN_ASSET_ARCHIVE: invalidArchive },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let rejection = '';
    rejected.stderr.on('data', data => { rejection += String(data); });
    const rejectedCode = await new Promise<number | null>(resolveExit => rejected.once('close', resolveExit));
    transcript.push({ rejectedCode, stderr: rejection });
    assert.equal(rejectedCode, 1);
    assert.match(rejection, /Pinned archive digest\/size mismatch/);
    await assert.rejects(stat(join(badRoot, release.id)), { code: 'ENOENT' });
    assert.equal((await readFile(join(target, 'busytex.wasm'))).length, release.files.find(file => file.path === 'busytex.wasm')!.bytes);
  } finally {
    await writeFile(join(evidence, 'proof.json'), JSON.stringify({ release: release.id, archive, transcript }, null, 2));
  }
});

test('custom publication on another filesystem with a read-only parent retains same-device verified publication', { timeout: 60_000 }, async context => {
  const temporary = await mkdtemp(join(tmpdir(), 'writedown-cross-device-'));
  const assetRoot = join(temporary, 'public');
  const events: Record<string, unknown>[] = [];
  const parent = resolve(process.env.WRITEDOWN_ASSET_TEST_OUTPUT ?? 'test-results');
  await mkdir(parent, { recursive: true });
  const evidence = await mkdtemp(join(parent, 'asset-cross-device-'));
  const repositoryDevice = (await stat('.')).dev;
  const targetDevice = (await stat(temporary)).dev;
  let verifiedFiles = 0;
  try {
    if (repositoryDevice === targetDevice) {
      context.skip('The OS temporary directory is on the repository filesystem');
      return;
    }
    await mkdir(assetRoot);
    await chmod(temporary, 0o555);
    const target = await prepareAssets({
      assetRoot,
      archivePath: process.env.WRITEDOWN_ASSET_ARCHIVE ?? resolve('.cache/compiler', `${release.archive.sha256}.tar.gz`),
      onPhase: event => events.push(event),
    });
    assert.deepEqual(await verifyPreparedAssets(target), []);
    verifiedFiles = release.files.length;
    const extracting = events.find(event => event.phase === 'extracting');
    assert.ok(extracting && typeof extracting.staging === 'string');
    const stagingParent = join(extracting.staging, '..');
    assert.equal((await stat(stagingParent)).dev, targetDevice);
    assert.equal(extracting.staging.startsWith(assetRoot + sep), true);
    assert.equal(events.at(-1)?.phase, 'published');
  } finally {
    await chmod(temporary, 0o700);
    await rm(temporary, { recursive: true, force: true });
    await writeFile(join(evidence, 'proof.json'), JSON.stringify({ repositoryDevice, targetDevice, parentModeDuringPreparation: '0555', verifiedFiles, events, temporaryCleaned: true }, null, 2));
  }
});
