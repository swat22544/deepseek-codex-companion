import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../server/http.mjs';
import {readServiceConfig} from '../server/service-config.mjs';

const close = server => new Promise(resolve => server.close(resolve));

test('configured address and capability survive a full server restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'monitor-stable-address-'));
  const initial = await startServer({root});
  const port = Number(new URL(initial.url).port), token = initial.token;
  await close(initial.server);
  await writeFile(join(root, 'service-config.json'), JSON.stringify({version: 1, port, token}));
  for (let i = 0; i < 2; i++) {
    const restarted = await startServer({root});
    try {
      assert.equal(restarted.url, initial.url);
      const base = new URL(initial.url).origin;
      assert.equal((await fetch(base + '/api/health', {headers: {Authorization: 'Bearer ' + token}})).status, 200);
      assert.equal((await fetch(base + '/api/runs')).status, 401);
      assert.equal((await fetch(base + '/api/runs', {headers: {Authorization: 'Bearer ' + token, Origin: 'https://example.com'}})).status, 403);
    } finally { await close(restarted.server); }
  }
});

test('invalid persistent configuration fails rather than choosing a new address', async () => {
  const root = await mkdtemp(join(tmpdir(), 'monitor-invalid-config-'));
  assert.equal(await readServiceConfig(root), null);
  for (const config of [
    {version: 1, port: 0, token: 'a'.repeat(64)},
    {version: 1, port: 65536, token: 'a'.repeat(64)},
    {version: 1, port: '60044', token: 'a'.repeat(64)},
    {version: 1, port: 60044, token: 'not-a-capability'},
    {version: 2, port: 60044, token: 'a'.repeat(64)}
  ]) {
    await writeFile(join(root, 'service-config.json'), JSON.stringify(config));
    await assert.rejects(startServer({root}), /Invalid monitor service configuration/);
  }
});
