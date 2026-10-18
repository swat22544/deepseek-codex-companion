import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runBatch, validateBatch} from '../scripts/delegate-batch.mjs';
import {delegate} from '../scripts/delegate.mjs';
import {delegate as harness} from '../scripts/supervised-runner.mjs';
import {delegate as zcode} from '../scripts/zcode-runner.mjs';

const plan = () => ({version: 1, independent: true, tasks: ['harness', 'zcode'].map(backend => ({
  id: backend + '-work', request: {backend, taskType: 'draft', mode: 'text', instruction: 'Independent package', input: ''}
}))});
const valid = backend => ({
  backend, ok: true, trust: 'unverified_candidate', verificationRequired: true,
  policyActive: true, modelSelectionVerified: true, runtimeEvidenceVerified: true,
  modelSelection: backend === 'zcode'
    ? {provider: 'zai-standard-api', model: 'GLM-5.3-Flash', reasoningEffort: 'max'}
    : {provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max'},
  modelRequests: 1, exitCode: 0, sessionId: backend + '-session', stopReason: {kind: 'completed'},
  cleanup: {requested: false, treeKillConfirmed: false, incomplete: false}, error: null,
  final: {type: 'final', text: 'Candidate'}, toolCalls: [], toolResults: [], artifacts: []
});
async function output(t) {
  const root = await mkdtemp(join(tmpdir(), 'companion-batch-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return join(root, 'results');
}

test('batch requires independent packages, explicit distinct routes, and portable distinct ids', () => {
  for (const change of [
    p => {delete p.independent;}, p => {p.tasks.pop();}, p => {p.tasks.push(p.tasks[0]);},
    p => {delete p.tasks[1].request.backend;}, p => {p.tasks[1].request.backend = 'harness';},
    p => {p.tasks[1].request.backend = 'auto';}, p => {p.tasks[1].id = p.tasks[0].id;},
    p => {p.tasks[0].id = '../outside';}, p => {p.tasks[0].id = 'con';},
    p => {p.tasks[0].id = 'batch-plan';}, p => {p.tasks[1].id = 'batch-result';},
    p => {p.tasks[1].request.totalTimeoutMs = -1;}
  ]) {const p = plan(); change(p); assert.throws(() => validateBatch(p));}
  const p = plan(), normalized = validateBatch(p);
  normalized.tasks[0].request.files.push('unrelated');
  assert.equal(p.tasks[0].request.files, undefined, 'normalization does not mutate caller input');
});

test('both backends start before either settles; result evidence is separate and untrusted', {timeout: 3000}, async t => {
  const outputDir = await output(t), starts = [], releases = [];
  const promise = runBatch(plan(), {outputDir, invoke: request => {
    starts.push(request.backend);
    return new Promise(resolve => {
      releases.push(() => resolve(valid(request.backend)));
      if (releases.length === 2) for (const release of releases) release();
    });
  }});
  const result = await promise;
  assert.deepEqual(starts, ['harness', 'zcode']);
  assert.equal(result.ok, true);
  assert.equal(result.semanticAcceptance, false);
  assert.equal(result.verificationRequired, true);
  assert.equal(result.trust, 'unverified_candidate');
  for (const task of result.tasks) {
    const record = JSON.parse(await readFile(task.resultPath, 'utf8'));
    assert.equal(record.backend, task.backend);
    assert.equal(task.mechanicalOk, true);
  }
  assert.deepEqual((await readdir(outputDir)).sort(), ['batch-plan.json', 'batch-result.json', 'harness-work.json', 'zcode-work.json']);
});

test('one backend failure is saved without retrying, rerouting, or discarding its peer', async t => {
  const outputDir = await output(t), calls = [];
  const result = await runBatch(plan(), {outputDir, invoke: async request => {
    calls.push(request.backend);
    if (request.backend === 'harness') throw new Error('Synthetic unavailable backend');
    return valid('zcode');
  }});
  assert.equal(result.ok, false);
  assert.deepEqual(calls, ['harness', 'zcode']);
  assert.deepEqual(result.tasks.map(t => t.status), ['failed', 'completed']);
  assert.equal(JSON.parse(await readFile(result.tasks[0].resultPath, 'utf8')).error, 'Synthetic unavailable backend');
});

test('an ok flag cannot mask a mismatched route or unverified runtime', async t => {
  for (const kind of ['route', 'evidence', 'cleanup']) {
    const outputDir = await output(t);
    const result = await runBatch(plan(), {outputDir, invoke: async request => {
      const record = valid(request.backend);
      if (request.backend === 'zcode') {
        if (kind === 'route') return valid('harness');
        if (kind === 'evidence') record.runtimeEvidenceVerified = false;
        if (kind === 'cleanup') record.cleanup.incomplete = true;
      }
      return record;
    }});
    assert.equal(result.ok, false);
    assert.equal(result.tasks[1].mechanicalOk, false);
  }
});

test('missing snapshots and existing result directories fail before invoking any model', async t => {
  const outputDir = await output(t);
  let calls = 0;
  const invoke = async request => {calls++; return valid(request.backend);};
  for (const id of ['batch-plan','batch-result']) {
    const collision=plan(); collision.tasks[0].id=id;
    await assert.rejects(runBatch(collision,{outputDir,invoke}));
    assert.equal(calls,0,'reserved output collision must be rejected before model calls');
  }
  const p = plan();
  p.tasks[1].request.mode = 'inspect'; p.tasks[1].request.files = [join(outputDir, 'missing.mjs')];
  await assert.rejects(runBatch(p, {outputDir, invoke}));
  assert.equal(calls, 0);
  await runBatch(plan(), {outputDir, invoke});
  const before = await readFile(join(outputDir, 'batch-result.json'), 'utf8');
  await assert.rejects(runBatch(plan(), {outputDir, invoke}), {code: 'EEXIST'});
  assert.equal(calls, 2);
  assert.equal(await readFile(join(outputDir, 'batch-result.json'), 'utf8'), before);
});

test('batch cancellation reaches both running invocations and saves both failures', async t => {
  const outputDir = await output(t), abort = new AbortController();
  let calls = 0;
  const result = await runBatch(plan(), {outputDir, signal: abort.signal, invoke: (request, {signal}) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), {once: true});
    if (++calls === 2) abort.abort(new Error('Synthetic cancellation'));
  })});
  assert.equal(calls, 2);
  assert.equal(result.ok, false);
  assert.ok(result.tasks.every(task => task.saved && task.status === 'failed'));
});

test('pre-cancelled batch and either backend perform no setup or model invocation', async t => {
  const outputDir = await output(t), abort = new AbortController();
  abort.abort(new Error('Already cancelled'));
  await assert.rejects(runBatch(plan(), {outputDir, signal: abort.signal, invoke: () => assert.fail('must not run')}), /Already cancelled/);
  for (const run of [delegate, harness, zcode]) await assert.rejects(run({}, {signal: abort.signal}), /Already cancelled/);
});
