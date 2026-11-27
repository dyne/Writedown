import { release, verifyPreparedAssets } from './assets.ts';
import { join } from 'node:path';

const invalid = await verifyPreparedAssets(join(import.meta.dirname, '../public/compiler', release.id));
if (invalid.length) throw new Error(`Run npm run assets:prepare; invalid compiler assets: ${invalid.join(', ')}`);
console.log(`Verified ${release.files.length} compiler files (${release.shippedBytes} bytes)`);
