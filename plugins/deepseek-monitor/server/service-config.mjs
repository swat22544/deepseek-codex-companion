import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

export async function readServiceConfig(root) {
  let config;
  try {
    config = JSON.parse(await readFile(join(root, 'service-config.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Unable to read monitor service configuration', {cause: error});
  }
  if (config.version !== 1 || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || typeof config.token !== 'string' || !/^[a-f0-9]{64}$/.test(config.token)) {
    throw new Error('Invalid monitor service configuration');
  }
  return {port: config.port, token: config.token};
}
