import {appendFile, mkdir, rename, stat, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {dataRoot} from './store.mjs';

// The scheduled task passes an explicit user data directory, including before logon.
const root = resolve(process.argv[2] || dataRoot);
const {launch} = await import('./launch.mjs');
const {readServiceConfig} = await import('./service-config.mjs');
const config = await readServiceConfig(root);
if (!config) throw new Error('Persistent monitor service configuration is required');

const logPath = join(root, 'watchdog.log');
const statusPath = join(root, 'watchdog-status.json');
await mkdir(root, {recursive: true});
let previousState = '', stopping = false;
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });

async function report(state, message) {
  const status = {version: 1, pid: process.pid, state, updatedAt: new Date().toISOString(), port: config.port, message};
  const tempPath = statusPath + '.tmp';
  await writeFile(tempPath, JSON.stringify(status), {mode: 0o600});
  await rename(tempPath, statusPath);
  if (state === previousState) return;
  previousState = state;
  if (await stat(logPath).then(s => s.size > 256 * 1024).catch(() => false)) {
    await rename(logPath, logPath + '.previous').catch(() => {});
  }
  await appendFile(logPath, status.updatedAt + ' ' + state + ' ' + message + '\n', {mode: 0o600});
}

await report('starting', 'Monitor watchdog started');
while (!stopping) {
  try {
    const result = await launch({root});
    const address = new URL(result.url);
    if (address.hostname !== '127.0.0.1' || Number(address.port) !== config.port || new URLSearchParams(address.hash.slice(1)).get('token') !== config.token) {
      throw new Error('Running monitor does not match the persistent local address');
    }
    await report('healthy', result.reused ? 'Local monitor is available' : 'Local monitor restarted');
  } catch (error) {
    // Never write returned URLs or capability tokens into logs.
    await report('retrying', error?.message === 'Running monitor does not match the persistent local address' ? error.message : 'Monitor unavailable; startup will be retried');
  }
  await new Promise(r => setTimeout(r, 5000));
}
await report('stopped', 'Monitor watchdog stopped');
