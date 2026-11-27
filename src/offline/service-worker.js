// The production build prefixes the exact release and generated shell manifest.
const scope = self.registration.scope;
const cacheName = `writedown-runtime:${scope}:${manifest.release}:${manifest.build}`;
const readyKey = new URL('__writedown-ready/' + manifest.build, scope).href;
const assets = new Map(manifest.files.map(file => [new URL(file.path, scope).href, file]));
const onDemandAssets = new Map(manifest.onDemand.map(file => [new URL(file.path, scope).href, file]));
const entryUrl = new URL('index.html', scope).href;

async function tellPages(state, detail) {
  const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const page of pages) {
    if (page.url.startsWith(scope)) page.postMessage({ type: 'writedown:offline', state, detail });
  }
}

async function verifiedResponse(url, file) {
  let response;
  try {
    response = await fetch(url, { cache: 'no-store', redirect: 'error' });
  } catch (error) {
    throw new Error(`Could not load offline asset ${file.path}.`, { cause: error });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Could not load offline asset ${file.path} (HTTP ${response.status}).`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== file.bytes) throw new Error(`Offline asset size mismatch for ${file.path}.`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hex !== file.sha256) throw new Error(`Offline asset SHA-256 mismatch for ${file.path}.`);
  const headers = new Headers(response.headers);
  // Fetch exposes decoded bytes. Keep the server's document and resource
  // policies without reusing transfer metadata for the original encoding.
  headers.delete('Content-Encoding');
  headers.delete('Content-Length');
  headers.delete('Transfer-Encoding');
  if (file.path.endsWith('.wasm')) headers.set('Content-Type', 'application/wasm');
  return new Response(bytes, { headers });
}

async function save(cache, url, response, name) {
  try {
    await cache.put(url, response);
  } catch (error) {
    throw new Error(`Could not save offline asset ${name}.`, { cause: error });
  }
}

let preparation;
function prepare() {
  return preparation ??= prepareCache().finally(() => { preparation = undefined; });
}

async function prepareCache() {
  const cache = await caches.open(cacheName);
  for (const [url, file] of assets) {
    if (!await cache.match(url)) {
      await save(cache, url, await verifiedResponse(url, file), file.path);
    }
  }
  // This marker is written only after every compiler and shell cache write.
  await save(cache, readyKey, new Response(manifest.build), 'readiness record');
}

self.addEventListener('install', event => {
  event.waitUntil(prepare().catch(async error => {
    // The candidate has its own key. The currently active worker keeps its set.
    await caches.delete(cacheName).catch(() => false);
    await tellPages('failed', error.message);
    throw error;
  }));
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'writedown:repair-offline') return;
  event.waitUntil(prepare().then(
    () => event.source?.postMessage({ type: 'writedown:offline', state: 'ready' }),
    error => event.source?.postMessage({ type: 'writedown:offline', state: 'failed', detail: error.message }),
  ));
});

async function serve(url, file, required) {
  let cache;
  try {
    cache = await caches.open(cacheName);
    const cached = await cache.match(url);
    if (cached) return cached;
  } catch {
    // If storage is unavailable the fixed URL can still supply verified bytes.
  }
  const response = await verifiedResponse(url, file);
  try {
    cache ??= await caches.open(cacheName);
    await save(cache, url, response.clone(), file.path);
  } catch {
    if (!required) throw new Error('Could not save optional asset ' + file.path + '.');
    await tellPages('failed', `Could not save offline asset ${file.path}.`);
  }
  return response;
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = event.request.url === scope ? entryUrl : event.request.url;
  const required = assets.has(url);
  const file = assets.get(url) ?? onDemandAssets.get(url);
  if (!file) return;
  event.respondWith(serve(url, file, required).catch(async error => {
    if (required) await tellPages('failed', error.message);
    return new Response(error.message, { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }));
});
