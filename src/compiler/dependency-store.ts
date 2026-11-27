import release from '../../compiler-release.json' with { type: 'json' };
import { dependencyPath } from './dependency-catalog.ts';
import type { TexDependency } from './dependency-catalog.ts';

const cacheName = `writedown-tex-dependencies:${release.id}`;

function endpointDirectory(value: string): URL {
  const url = new URL(value);
  const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !loopback) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS TeX dependency endpoint without credentials, a query, or a fragment.');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

async function verifiedContents(response: Response, file: TexDependency): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  const corrupt = new Error(`Size or SHA-256 mismatch for TeX dependency ${file.name}.`);
  if (!reader) throw corrupt;
  const contents = new Uint8Array(file.bytes);
  let offset = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.length > contents.length) throw corrupt;
      contents.set(value, offset);
      offset += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (offset !== contents.length) throw corrupt;
  const digest = await crypto.subtle.digest('SHA-256', contents);
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hex !== file.sha256) throw corrupt;
  return contents;
}

export class TexDependencyStore {
  private readonly compilerBase: string;
  private readonly endpoint: string | undefined;

  constructor(compilerBase: string, endpoint?: string) {
    this.compilerBase = compilerBase;
    this.endpoint = endpoint?.trim() || undefined;
  }

  async load(file: TexDependency, signal: AbortSignal): Promise<{ contents: Uint8Array; warning?: string }> {
    signal.throwIfAborted();
    // The key is local, independent of endpoint configuration and namespaced
    // to this app's compiler base. It is used only in Cache Storage.
    const key = new URL(`./verified-dependencies/${dependencyPath(file)}`, this.compilerBase + '/');
    let cache: Cache | undefined;
    try {
      cache = await caches.open(cacheName);
      const cached = await cache.match(key);
      if (cached) return { contents: await verifiedContents(cached, file) };
    } catch {
      // A damaged or inaccessible entry can be replaced after a verified fetch.
    }
    signal.throwIfAborted();
    if (!this.endpoint) {
      throw new Error(`TeX dependency ${file.name} is absent from the verified cache and no endpoint is configured.`);
    }
    const url = new URL(dependencyPath(file), endpointDirectory(this.endpoint));
    let response: Response;
    try {
      response = await fetch(url, {
        signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store',
      });
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(`Could not fetch TeX dependency ${file.name}.`, { cause: error });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`TeX dependency ${file.name} is unavailable from the endpoint (HTTP ${response.status}).`);
    }
    const contents = await verifiedContents(response, file);
    signal.throwIfAborted();
    try {
      cache ??= await caches.open(cacheName);
      await cache.put(key, new Response(contents));
    } catch {
      return { contents, warning: `Could not save verified TeX dependency ${file.name} for offline use.` };
    }
    return { contents };
  }
}
