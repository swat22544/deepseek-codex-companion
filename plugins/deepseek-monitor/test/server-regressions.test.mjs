import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connect} from 'node:net';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {startServer} from '../server/http.mjs';
import {launch} from '../server/launch.mjs';
import {getRun, listRuns} from '../server/store.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const health = service => fetch(new URL(service.url).origin + '/api/health', {headers: {Authorization: 'Bearer ' + service.token}});
async function tempRoot(t, label) {
  const root = await mkdtemp(join(tmpdir(), label));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}
async function rawRequest(port, target) {
  return new Promise((resolve, reject) => {
    const socket = connect({host: '127.0.0.1', port});
    let response = '';
    socket.setTimeout(2000, () => socket.destroy(new Error('Raw HTTP test timed out')));
    socket.once('error', reject);
    socket.on('data', chunk => { response += chunk; });
    socket.once('end', () => resolve(response));
    socket.once('connect', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
  });
}
function capturedChild(script, args = [], options = {}) {
  const child = spawn(process.execPath, [script, ...args], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options});
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({code, signal, stdout, stderr}));
  });
  return {child, done};
}
async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(25);
  }
  throw new Error('Service regression test timed out');
}

test('malformed unauthenticated request target returns 400 and leaves the service healthy', async t => {
  const root = await tempRoot(t, 'monitor-bad-target-'), service = await startServer({root});
  t.after(() => close(service.server));
  const response = await rawRequest(Number(new URL(service.url).port), 'http://[');
  assert.match(response, /^HTTP\/1\.1 400 /);
  assert.ok(!response.includes(service.token));
  assert.equal((await health(service)).status, 200);
  assert.equal((await fetch(new URL(service.url).origin + '/api/runs')).status, 401);
});

test('list storage failures return generic 500 while absent records return 404', async t => {
  const root = await tempRoot(t, 'monitor-read-failure-'), service = await startServer({root});
  t.after(() => close(service.server));
  await writeFile(join(root, 'runs'), 'not a directory');
  const base = new URL(service.url).origin, options = {headers: {Authorization: 'Bearer ' + service.token}};
  const list = await fetch(base + '/api/runs', options);
  assert.equal(list.status, 500);
  assert.deepEqual(await list.json(), {error: 'Monitor unavailable'});
  const missing = await fetch(base + '/api/runs/' + randomUUID(), options);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), {error: 'Run unavailable'});
  assert.equal((await health(service)).status, 200);
});

test('metadata publication failure closes the owned listener and removes temporary metadata', async t => {
  const root = await tempRoot(t, 'monitor-metadata-failure-');
  const first = await startServer({root}), port = Number(new URL(first.url).port);
  await close(first.server);
  await rm(join(root, 'server.json'));
  await mkdir(join(root, 'server.json'));
  await writeFile(join(root, 'service-config.json'), JSON.stringify({version: 1, port, token: 'a'.repeat(64)}));
  await assert.rejects(startServer({root}));
  assert.deepEqual((await readdir(root)).filter(name => /^server\.json\..*\.tmp$/.test(name)), []);
  // Rebinding the same port verifies listener cleanup without inspecting global processes.
  const replacementRoot = await tempRoot(t, 'monitor-rebind-'), replacement = await startServer({root: replacementRoot, port});
  await close(replacement.server);
});

test('CLI startup metadata failure exits promptly without disclosing the configured capability', async t => {
  const root = await tempRoot(t, 'monitor-cli-start-failure-');
  await mkdir(join(root, 'server.json'));
  const {child, done} = capturedChild(fileURLToPath(new URL('../server/http.mjs', import.meta.url)), [root]);
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const result = await Promise.race([done, pause(3000).then(() => { throw new Error('Failed monitor child remained alive'); })]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr.trim(), 'Monitor failed to start');
  assert.deepEqual((await readdir(root)).filter(name => /^server\.json\..*\.tmp$/.test(name)), []);
});

test('failed duplicate bind preserves the existing service and its published metadata', async t => {
  const root = await tempRoot(t, 'monitor-duplicate-bind-'), service = await startServer({root});
  t.after(() => close(service.server));
  const metadata = await readFile(join(root, 'server.json'), 'utf8');
  await assert.rejects(startServer({root, port: Number(new URL(service.url).port)}), {code: 'EADDRINUSE'});
  assert.equal(await readFile(join(root, 'server.json'), 'utf8'), metadata);
  assert.equal((await health(service)).status, 200);
});

test('launcher detects failed owned child startup, clears its lock and supports retry', async t => {
  const root = await tempRoot(t, 'monitor-launch-failure-');
  await mkdir(join(root, 'server.json'));
  await assert.rejects(launch({root, startupTimeoutMs: 2000}), /Monitor process exited before becoming ready/);
  await assert.rejects(stat(join(root, 'start.lock')), {code: 'ENOENT'});
  await rm(join(root, 'server.json'), {recursive: true});
  const result = await launch({root, startupTimeoutMs: 3000});
  const metadata = JSON.parse(await readFile(join(root, 'server.json'), 'utf8'));
  // This PID is an owned process just created under this test's unique root.
  t.after(() => { try { process.kill(metadata.pid); } catch {} });
  assert.equal(result.reused, false);
  assert.equal(new URL(result.url).origin, metadata.url);
  assert.deepEqual(await launch({root}), {url: result.url, reused: true});
});

test('launcher timeout terminates only its own stalled child and removes its lock', async t => {
  const root = await tempRoot(t, 'monitor-launch-timeout-');
  const preload = join(root, 'stall.mjs'), pidPath = join(root, 'owned-pid.json');
  await writeFile(preload, `import {basename} from 'node:path';\nimport {writeFileSync} from 'node:fs';\nif (basename(process.argv[1] || '') === 'http.mjs') {\n writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({pid:process.pid}));\n setInterval(() => {}, 1000);\n await new Promise(() => {});\n}\n`);
  const code = `import {launch} from ${JSON.stringify(new URL('../server/launch.mjs', import.meta.url).href)};\ntry { await launch({root:${JSON.stringify(root)},startupTimeoutMs:1000}); process.exitCode=2; } catch (error) { console.log(JSON.stringify({message:error.message})); }`;
  const {child, done} = capturedChild('--input-type=module', ['--eval', code], {env: {...process.env, NODE_OPTIONS: '--import=' + pathToFileURL(preload).href}});
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const result = await Promise.race([done, pause(5000).then(() => { throw new Error('Launcher cleanup timed out'); })]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {message: 'Monitor failed to start'});
  const {pid} = JSON.parse(await readFile(pidPath, 'utf8'));
  t.after(() => { try { process.kill(pid); } catch {} });
  assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
  await assert.rejects(stat(join(root, 'start.lock')), {code: 'ENOENT'});
});

test('launcher reuses a healthy explicitly selected root without touching the shared service', async t => {
  const root = await tempRoot(t, 'monitor-launch-reuse-'), service = await startServer({root});
  t.after(() => close(service.server));
  assert.deepEqual(await launch({root}), {url: service.url, reused: true});
  assert.equal((await health(service)).status, 200);
  await assert.rejects(stat(join(root, 'start.lock')), {code: 'ENOENT'});
});

test('bad start timestamps are isolated and valid records sort by actual time', async t => {
  const root = await tempRoot(t, 'monitor-record-times-');
  await mkdir(join(root, 'runs'));
  const valid = [
    {id: randomUUID(), startedAt: '2026-10-14T10:00:00+08:00'},
    {id: randomUUID(), startedAt: '2026-10-14T04:00:00Z'}
  ];
  for (const record of valid) await writeFile(join(root, 'runs', record.id + '.json'), JSON.stringify({...record, version: 1, done: true}));
  for (const startedAt of [42, null, {}, [], 'not a date', '42']) {
    const id = randomUUID();
    await writeFile(join(root, 'runs', id + '.json'), JSON.stringify({id, version: 1, done: true, startedAt}));
    await assert.rejects(getRun(id, root), /Invalid run record timestamp/);
  }
  const listed = await listRuns(root);
  assert.deepEqual(listed.map(record => record.id), [valid[1].id, valid[0].id]);
  assert.equal(listed[1].startedAt, '2026-10-14T02:00:00.000Z');
  const service = await startServer({root});
  t.after(() => close(service.server));
  const response = await fetch(new URL(service.url).origin + '/api/runs', {headers: {Authorization: 'Bearer ' + service.token}});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).runs.length, 2);
});

test('invalid unfinished heartbeat is visibly interrupted without claiming model failure', async t => {
  const root = await tempRoot(t, 'monitor-heartbeat-times-');
  await mkdir(join(root, 'runs'));
  for (const updatedAt of [undefined, 42, null, {}, 'not a date', '42']) {
    const id = randomUUID();
    await writeFile(join(root, 'runs', id + '.json'), JSON.stringify({id, version: 1, done: false, status: 'running', startedAt: new Date().toISOString(), updatedAt}));
    const record = await getRun(id, root);
    assert.equal(record.status, 'interrupted');
    assert.equal(record.done, false);
    assert.equal(record.updatedAt, null);
    assert.equal(record.observationStale, true);
    assert.match(record.error, /这不等于模型失败/);
  }
  const listed = await listRuns(root);
  assert.equal(listed.length, 6);
  assert.ok(listed.every(record => record.status === 'interrupted' && record.observationStale));
});

for (const explicit of [false, true]) test(`watchdog respects ${explicit ? 'an explicit arbitrary root over CODEX_HOME' : 'CODEX_HOME without a positional root'}`, async t => {
  const home = await tempRoot(t, 'monitor-watchdog-home-');
  const root = explicit ? join(home, 'arbitrary-monitor-location') : join(home, 'deepseek-monitor');
  const service = await startServer({root});
  t.after(() => close(service.server));
  await writeFile(join(root, 'service-config.json'), JSON.stringify({version: 1, port: Number(new URL(service.url).port), token: service.token}));
  const configuredHome = explicit ? join(home, 'wrong-codex-home') : home;
  const {child, done} = capturedChild(fileURLToPath(new URL('../server/watchdog.mjs', import.meta.url)), explicit ? [root] : [], {env: {...process.env, CODEX_HOME: configuredHome, USERPROFILE: join(home, 'wrong-profile')}});
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await done; });
  await waitUntil(async () => {
    if (child.exitCode !== null) { const result = await done; throw new Error('Watchdog exited: ' + result.stderr); }
    return readFile(join(root, 'watchdog-status.json'), 'utf8').then(data => JSON.parse(data).state === 'healthy').catch(() => false);
  });
  assert.equal((await health(service)).status, 200);
  await assert.rejects(stat(join(configuredHome, 'deepseek-monitor', 'start.lock')), {code: 'ENOENT'});
  assert.ok(!(await readFile(join(root, 'watchdog.log'), 'utf8')).includes(service.token));
});
