import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStaticServer } from '../support/static-server.ts';

test('static host mounts only the deployment base and returns real missing-file errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'writedown-static-'));
  await writeFile(join(root, 'index.html'), '<h1>Fixture</h1>');
  await writeFile(join(root, 'app.js'), 'export {};');
  const server = await startStaticServer(root);
  try {
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), '<h1>Fixture</h1>');
    const script = await fetch(new URL('app.js?v=1', server.url));
    assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(await script.text(), 'export {};');
    assert.equal((await fetch(new URL('missing.js', server.url))).status, 404);
    assert.equal((await fetch(new URL('/', server.url))).status, 404);
    const submitted = await fetch(new URL('missing.js?fixture=1', server.url), {
      method: 'POST', headers: { 'x-test-request': 'header canary' }, body: 'body canary',
    });
    assert.equal(submitted.status, 404);
    assert.deepEqual(server.requests.map(request => request.status), [200, 200, 404, 404, 404]);
    const [last] = server.requests.slice(-1);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/writedown/missing.js?fixture=1');
    assert.equal(last.headers['x-test-request'], 'header canary');
    assert.equal(last.body, 'body canary');
    assert.equal(last.bodyBytes, 11);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
