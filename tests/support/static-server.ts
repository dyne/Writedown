import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml',
};

export async function startStaticServer(root: string) {
  const requests: { method: string; path: string; status: number }[] = [];
  const absoluteRoot = resolve(root);
  const server = createServer(async (request, response) => {
    let status = 404;
    let body: string | Buffer = 'Not found';
    let contentType = 'text/plain; charset=utf-8';
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      if (pathname.startsWith('/writedown/')) {
        const relative = pathname.slice('/writedown/'.length) || 'index.html';
        const file = resolve(absoluteRoot, relative);
        if (file.startsWith(absoluteRoot + sep)) {
          body = await readFile(file);
          status = 200;
          contentType = contentTypes[extname(file)] ?? 'application/octet-stream';
        }
      }
    } catch (error) {
      if (!(error instanceof URIError) &&
          !['ENOENT', 'EISDIR', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        status = 500;
        body = 'Static server error';
      }
    }
    requests.push({ method: request.method ?? 'GET', path: request.url ?? '/', status });
    response.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    response.end(body);
  });
  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListening);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  return {
    url: `http://127.0.0.1:${address.port}/writedown/`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed()));
    },
  };
}
