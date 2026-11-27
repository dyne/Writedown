import { prepareAssets } from './assets.ts';

const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());
try {
  await prepareAssets({
    assetRoot: process.env.WRITEDOWN_ASSET_ROOT,
    cacheDirectory: process.env.WRITEDOWN_ASSET_CACHE,
    archivePath: process.env.WRITEDOWN_ASSET_ARCHIVE,
    signal: controller.signal,
    onPhase: event => console.log(JSON.stringify(event)),
  });
} catch (error) {
  console.error(error);
  process.exitCode = controller.signal.aborted ? 143 : 1;
}
