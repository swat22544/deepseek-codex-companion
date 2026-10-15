import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { createMcpHandler, serveStdio, MAX_LINE_BYTES } from '../scripts/helper-mcp.mjs';
import { snapshotFiles, hash, TOOL_NAMES } from '../scripts/helper-policy.mjs';

const directory = await mkdtemp(join(tmpdir(), 'backend-tools-test-'));
after(async () => {
  assert.match(relative(resolve(tmpdir()), resolve(directory)), /^backend-tools-test-[^\\/]+$/);
  await rm(directory, { recursive: true, force: true });
});
const policy = (mode = 'inspect', extra = {}) => ({
  mode, nonce: 'test-private-nonce', files: [], artifactDir: join(directory, 'artifacts'),
  maxToolCalls: 80, deadline: Date.now() + 60_000, ...extra,
});
const request = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const toolCall = (name, args = {}, id = 1) => request('tools/call', { name, arguments: args }, id);
const content = response => JSON.parse(response.result.content[0].text);
async function harness(p) {
  const events = [];
  const handle = await createMcpHandler(p, { audit: async record => { events.push(record); } });
  return { events, handle };
}

test('MCP negotiation and mode-specific tool lists deny unauthorized tools without tool audit entries', async () => {
  for (const [mode, count] of [['text', 0], ['inspect', 3], ['propose', 4]]) {
    const { events, handle } = await harness(policy(mode));
    assert.deepEqual(events, [{ nonce: 'test-private-nonce', event: 'active', pid: process.pid, mode, allowedTools: TOOL_NAMES.slice(0, count) }]);
    const init = await handle(request('initialize', { protocolVersion: '2025-06-18' }));
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal((await handle(request('initialize', { protocolVersion: 'unknown' }))).result.protocolVersion, '2024-11-05');
    assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.deepEqual((await handle(request('tools/list'))).result.tools.map(tool => tool.name), TOOL_NAMES.slice(0, count));
    const forbidden = mode === 'propose' ? 'bash' : 'helper_write_artifact';
    assert.equal(content(await handle(toolCall(forbidden, { name: 'private.txt', content: 'secret' }))).error.code, 'TOOL_NOT_AUTHORIZED');
    assert.equal(events.length, 1);
    assert.deepEqual((await handle(request('ping'))).result, {});
  }
});

test('snapshots are immutable, do not reveal source paths, and cannot become live reads', async () => {
  const source = join(directory, 'private-source.txt');
  await writeFile(source, 'first\nneedle\nlast');
  const files = await snapshotFiles([source]);
  const { events, handle } = await harness(policy('inspect', { files }));
  files[0].content = 'mutated policy after startup';
  await writeFile(source, 'live content changed');
  const listed = content(await handle(toolCall('helper_list_files')));
  assert.equal(listed[0].id, 'f1');
  assert.equal('source' in listed[0], false);
  assert.match(content(await handle(toolCall('helper_read_file', { file: 'f1' }))).text, /2: needle/);
  assert.equal(content(await handle(toolCall('helper_search_text', { query: 'needle' }))).matches[0].line, 2);
  assert.equal(content(await handle(toolCall('helper_read_file', { file: source }))).error.code, 'UNKNOWN_FILE_ID');
  assert.ok(!JSON.stringify(events).includes('private-source'));
  assert.ok(!JSON.stringify(events).includes('needle'));
});

test('candidate writes stay isolated, exclusive, and bounded; file errors do not leak paths', async () => {
  const artifactDir = join(directory, 'candidates');
  const { events, handle } = await harness(policy('propose', { artifactDir }));
  for (const name of ['../escape.txt', 'C:escape.txt', 'sub/file.py', 'CON.txt', 'launch.exe']) {
    assert.equal(content(await handle(toolCall('helper_write_artifact', { name, content: 'candidate-secret' }))).error.code, 'INVALID_TOOL_ARGUMENTS');
  }
  const first = await handle(toolCall('helper_write_artifact', { name: 'candidate.py', content: 'print(1)' }));
  assert.equal(content(first).status, 'candidate_requires_supervisor_review');
  assert.equal(await readFile(join(artifactDir, 'candidate.py'), 'utf8'), 'print(1)');
  assert.equal(content(await handle(toolCall('helper_write_artifact', { name: 'candidate.py', content: 'replace' }))).error.code, 'ARTIFACT_ALREADY_EXISTS');
  assert.equal(content(await handle(toolCall('helper_write_artifact', { name: 'too-large.txt', content: 'x'.repeat(256 * 1024 + 1) }))).error.code, 'ARTIFACT_BUDGET_EXCEEDED');
  await mkdir(join(artifactDir, 'existing.txt'));
  const failed = await handle(toolCall('helper_write_artifact', { name: 'existing.txt', content: 'private-content' }));
  assert.equal(content(failed).error.code, 'TOOL_EXECUTION_FAILED');
  const audit = JSON.stringify(events);
  for (const secret of [directory, 'private-content', 'candidate-secret', 'existing.txt', 'print(1)']) assert.ok(!audit.includes(secret));
  assert.ok(!JSON.stringify(failed).includes(directory));
  assert.deepEqual((await readdir(artifactDir)).sort(), ['candidate.py', 'existing.txt']);
});

test('every allowed attempt has a unique paired audit record, including validation/budget/deadline errors', async () => {
  const { events, handle } = await harness(policy('inspect', { maxToolCalls: 2 }));
  const responses = await Promise.all([
    handle(toolCall('helper_list_files', {}, 10)),
    handle(toolCall('helper_read_file', { file: 'f1', arbitrary: 'private-value' }, 11)),
    handle(toolCall('helper_list_files', {}, 12)),
  ]);
  assert.equal(content(responses[1]).error.code, 'INVALID_TOOL_ARGUMENTS');
  assert.equal(content(responses[2]).error.code, 'TOOL_BUDGET_EXCEEDED');
  const records = events.slice(1);
  assert.deepEqual(records.map(event => event.event), ['tool_start', 'tool_end', 'tool_start', 'tool_end', 'tool_start', 'tool_end']);
  assert.equal(new Set(records.filter(record => record.event === 'tool_start').map(record => record.callId)).size, 3);
  for (let index = 0; index < records.length; index += 2) {
    assert.match(records[index].callId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(records[index].callId, records[index + 1].callId);
    assert.equal(records[index].tool, records[index + 1].tool);
  }
  assert.deepEqual(records.filter(record => record.event === 'tool_end').map(record => record.status), ['completed', 'error', 'error']);
  const expired = await harness(policy('inspect', { deadline: 0 }));
  assert.equal(content(await expired.handle(toolCall('helper_list_files'))).error.code, 'DEADLINE_EXCEEDED');
  assert.equal(expired.events[2].errorCode, 'DEADLINE_EXCEEDED');
});

test('audit persistence is awaited and a failed audit prevents further tool execution', async () => {
  let release, active = 0, maxActive = 0;
  const gate = new Promise(accept => { release = accept; });
  const records = [];
  const handle = await createMcpHandler(policy(), { audit: async record => {
    active++; maxActive = Math.max(maxActive, active);
    if (record.event === 'tool_start') await gate;
    records.push(record); active--;
  } });
  const a = handle(toolCall('helper_list_files', {}, 1));
  const b = handle(toolCall('helper_list_files', {}, 2));
  await new Promise(accept => setImmediate(accept));
  assert.equal(records.length, 1);
  release();
  await Promise.all([a, b]);
  assert.equal(maxActive, 1);
  assert.deepEqual(records.slice(1).map(record => record.event), ['tool_start', 'tool_end', 'tool_start', 'tool_end']);

  const failed = await createMcpHandler(policy('propose', { artifactDir: join(directory, 'must-not-write') }), { audit: async record => {
    if (record.event === 'tool_start') throw new Error('private-file-path-and-secret');
  } });
  const response = await failed(toolCall('helper_write_artifact', { name: 'candidate.txt', content: 'secret' }));
  assert.equal(response.error.message, 'Audit unavailable');
  assert.equal((await failed(toolCall('helper_list_files'))).error.message, 'Audit unavailable');
  await assert.rejects(readFile(join(directory, 'must-not-write', 'candidate.txt')), { code: 'ENOENT' });
  assert.ok(!JSON.stringify(response).includes('private-file-path'));
});

test('invalid policies fail before active audit, while snapshot hashes may describe original BOM bytes', async () => {
  let calls = 0;
  for (const p of [policy('bash'), policy('inspect', { maxToolCalls: 81 }), policy('inspect', { deadline: NaN }), policy('inspect', { artifactDir: '../unsafe' }), policy('inspect', { nonce: 'a\nb' })]) {
    await assert.rejects(createMcpHandler(p, { audit: async () => { calls++; } }), /INVALID_POLICY/);
  }
  assert.equal(calls, 0);
  const bomSource = join(directory, 'bom.txt');
  await writeFile(bomSource, '\uFEFFhello');
  const { handle } = await harness(policy('inspect', { files: await snapshotFiles([bomSource]) }));
  assert.match(content(await handle(toolCall('helper_read_file', { file: 'f1' }))).text, /hello/);
});

test('MCP malformed envelopes and tool notifications cannot cause writes', async () => {
  const { events, handle } = await harness(policy('propose'));
  for (const malformed of [[], null, 0, { id: 1, method: 'ping' }, { jsonrpc: '2.0', id: {}, method: 'ping' }]) {
    assert.equal((await handle(malformed)).error.code, -32600);
  }
  assert.equal((await handle(request('tools/list', []))).error.code, -32602);
  assert.equal((await handle(request('filesystem/read'))).error.code, -32601);
  const notification = toolCall('helper_write_artifact', { name: 'notification.txt', content: 'secret' });
  delete notification.id;
  assert.equal(await handle(notification), null);
  assert.equal(events.length, 1);
});

test('bounded stdio parser recovers after malformed/oversized input and handles split UTF-8 and EOF', async () => {
  const { handle } = await harness(policy('text'));
  const oversized = Buffer.alloc(MAX_LINE_BYTES + 256, 120);
  const data = Buffer.from(JSON.stringify(request('ping', {}, '中文')) + '\n');
  const chunks = [Buffer.from('{bad-json}\n'), oversized.subarray(0, 123), oversized.subarray(123), Buffer.from('\n'), ...Array.from(data, byte => Buffer.from([byte])), Buffer.from(JSON.stringify(request('ping', {}, 20)))];
  let output = '';
  await serveStdio(handle, Readable.from(chunks), new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } }));
  const messages = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(messages.length, 4);
  assert.equal(messages[0].error.code, -32700);
  assert.equal(messages[1].error.code, -32600);
  assert.equal(messages[2].id, '中文');
  assert.equal(messages[3].id, 20);
  assert.ok(!output.includes('bad-json'));
});

test('stdio CLI starts import-safely and emits only protocol stdout and sanitized audit', async () => {
  const path = fileURLToPath(new URL('../scripts/helper-mcp.mjs', import.meta.url));
  const policyPath = join(directory, 'cli-policy.json'), auditPath = join(directory, 'cli-audit.jsonl');
  await writeFile(policyPath, JSON.stringify(policy('inspect', { files: [{ id: 'f1', name: 'sample.txt', source: 'private source path', content: 'snapshot-secret', bytes: 15, sha256: hash('snapshot-secret') }] })));
  const child = spawn(process.execPath, [path, policyPath, auditPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const completed = new Promise((accept, reject) => { child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal })); });
  child.stdin.end([request('initialize', { protocolVersion: '2025-06-18' }), request('tools/list', {}, 2), toolCall('helper_read_file', { file: 'f1' }, 3)].map(JSON.stringify).join('\n') + '\n');
  assert.deepEqual(await completed, { code: 0, signal: null });
  assert.equal(stderr, '');
  const responses = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.length, 3);
  assert.match(content(responses[2]).text, /snapshot-secret/);
  const audit = await readFile(auditPath, 'utf8');
  assert.deepEqual(audit.trim().split('\n').map(line => JSON.parse(line).event), ['active', 'tool_start', 'tool_end']);
  assert.equal(JSON.parse(audit.split('\n')[0]).pid,child.pid);
  assert.ok(!audit.includes('snapshot-secret'));
  assert.ok(!audit.includes('private source path'));
});

test('a disconnected stdio client returns a classified error without an unhandled error event', async () => {
  const { handle } = await harness(policy('text'));
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('private-pipe-path')); } });
  await assert.rejects(serveStdio(handle, Readable.from([JSON.stringify(request('ping')) + '\n']), output), /^Error: OUTPUT_UNAVAILABLE$/);
});
