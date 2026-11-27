import { createServer } from 'node:http';
import { readRequest } from './static-server.ts';
import type { RecordedRequest } from './static-server.ts';

export async function startDependencyServer(path: string, verified: Buffer, port = 0) {
  const endpointPath = '/tex-dependencies/';
  const requests: RecordedRequest[] = [];
  let corrupt = false;
  const server = createServer(async (request, response) => {
    const incoming = await readRequest(request);
    const match = incoming.method === 'GET' && incoming.path === endpointPath + path;
    const status = match ? 200 : 404;
    const bytes = match ? Buffer.from(verified) : Buffer.from('Not found');
    if (match && corrupt) bytes[0] ^= 0xff;
    requests.push({ ...incoming, status });
    response.writeHead(status, {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(bytes);
  });
  await new Promise<void>((listening, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', listening);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No dependency server address');
  return {
    url: `http://127.0.0.1:${address.port}${endpointPath}`,
    path: endpointPath + path,
    requests,
    setCorrupt(value: boolean) { corrupt = value; },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((closed, reject) => server.close(error => error ? reject(error) : closed()));
    },
  };
}
