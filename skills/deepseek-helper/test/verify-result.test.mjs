import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyResult, validateContract } from '../scripts/verify-result.mjs';

const valid = (text = '["TASK-2","TASK-32"]') => ({
  ok: true, trust: 'unverified_candidate', verificationRequired: true,
  policyActive: true, modelSelectionVerified: true, modelSelection: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
  modelRequests: 1, exitCode: 0, sessionId: 'test-session', stopReason: { kind: 'completed' },
  cleanup: { requested: false, treeKillConfirmed: false, incomplete: false }, error: null,
  final: { type: 'final', text }, toolCalls: [], toolResults: [],
});
const contract = { format: 'json', type: 'array', uniqueItems: true, expected: ['TASK-2', 'TASK-32'] };

test('protocol passing does not imply independent or semantic acceptance; input is unchanged', () => {
  const result = valid();
  const before = JSON.stringify(result);
  const report = verifyResult(result);
  assert.equal(report.mechanicalOk, true);
  assert.equal(report.contract.status, 'not_requested');
  assert.equal(report.independentReviewRequired, true);
  assert.equal(report.semanticAcceptance, false);
  assert.equal(report.trust, 'unverified_candidate');
  assert.equal(JSON.stringify(result), before);
  assert.equal(verifyResult({ id: 'T01', result }).mechanicalOk, true);
  assert.equal(verifyResult({ ok: false, result }).mechanicalOk, false);
});

test('protocol rejects missing, malformed or contradictory recorded guarantees', () => {
  for (const change of [
    { ok: false }, { policyActive: 1 }, { modelSelectionVerified: false }, { modelSelection: null },
    { modelRequests: 0 }, { modelRequests: 1.2 }, { exitCode: '0' }, { stopReason: { kind: 'cancelled' } },
    { cleanup: {} }, { cleanup: { incomplete: true } }, { cleanup: { incomplete: false, requested: true, treeKillConfirmed: false } },
    { final: { type: 'final', text: '  ' } }, { final: { type: 'draft', text: 'x' } },
    { error: 'failed' }, { sessionId: '' }, { verificationRequired: false }, { trust: 'trusted' },
  ]) assert.equal(verifyResult({ ...valid(), ...change }).mechanicalOk, false, JSON.stringify(change));
  for (const value of [null, [], true, 'text', {}]) assert.equal(verifyResult(value).mechanicalOk, false);
  for (const key of ['provider', 'model', 'reasoningEffort']) {
    const result = valid(); result.modelSelection[key] = 'fallback';
    assert.ok(verifyResult(result).protocol.issues.some(entry => entry.code === 'model_mismatch'));
  }
});

test('backend verification preserves legacy Harness and requires OpenCode runtime evidence and exact provider', () => {
  assert.equal(verifyResult(valid()).mechanicalOk,true);
  assert.equal(verifyResult({...valid(),backend:'harness'}).mechanicalOk,true);
  const opencode={...valid(),backend:'opencode',runtimeEvidenceVerified:true,modelSelection:{provider:'deepseek',model:'deepseek-flash',reasoningEffort:'max'}};
  assert.equal(verifyResult(opencode).mechanicalOk,true);
  for(const backend of ['',null,undefined,'unknown',{},1]){
    assert.ok(verifyResult({...valid(),backend}).protocol.issues.some(entry=>entry.code==='backend_unsupported'));
  }
  for(const value of [false,undefined,1,'true']){
    assert.ok(verifyResult({...opencode,runtimeEvidenceVerified:value}).protocol.issues.some(entry=>entry.code==='runtime_evidence_unverified'));
  }
  for(const result of [
    {...opencode,modelSelection:{...opencode.modelSelection,provider:'deepseek-official'}},
    {...valid(),modelSelection:{...valid().modelSelection,provider:'deepseek'}},
    {...opencode,modelSelection:{...opencode.modelSelection,model:'deepseek-chat'}},
    {...opencode,modelSelection:{...opencode.modelSelection,reasoningEffort:'high'}},
  ])assert.ok(verifyResult(result).protocol.issues.some(entry=>entry.code==='model_mismatch'));
  assert.equal(verifyResult({...opencode,cleanup:{incomplete:true}}).mechanicalOk,false);
  assert.equal(verifyResult({...opencode,policyActive:false}).mechanicalOk,false);
});

test('tool failures are separate from a structurally completed protocol', () => {
  const result = valid();
  result.toolCalls = [{ callId: 'c1', tool: 'read_snapshot' }];
  result.toolResults = [{ callId: 'c1', status: 'error' }];
  const report = verifyResult(result);
  assert.equal(report.protocol.ok, true);
  assert.equal(report.tools.ok, false);
  assert.equal(report.mechanicalOk, false);
  assert.deepEqual(report.tools.errors, [{ callId: 'c1', tool: 'read_snapshot', status: 'error' }]);
});

test('unmatched, missing and duplicate tool records fail protocol', () => {
  for (const [calls, results] of [
    [null, []], [[], null], [[{}], []], [[], [{ callId: 'x', status: 'completed' }]],
    [[{ callId: 'x', tool: 'read' }], []],
    [[{ callId: 'x', tool: 'read' }, { callId: 'x', tool: 'read' }], [{ callId: 'x', status: 'completed' }]],
    [[{ callId: 'x', tool: 'read' }], [{ callId: 'x', status: 'completed' }, { callId: 'x', status: 'completed' }]],
    [[{ callId: 'x', tool: 'read' }], [{ callId: 'x', status: 'unknown' }]],
  ]) assert.equal(verifyResult({ ...valid(), toolCalls: calls, toolResults: results }).protocol.ok, false);
});

test('whole final text must be JSON: no fences, prefixes, trailing prose or overflow numbers', () => {
  for (const text of ['```json\n[]\n```', 'Answer: []', '[]\n\nFilter applied: x', '[] []', '{', '1e999']) {
    const report = verifyResult(valid(text), contract);
    assert.equal(report.contract.status, 'failed', text);
    assert.equal(report.contract.issues[0].code, 'strict_json', text);
  }
  assert.equal(verifyResult(valid(' \r\n["TASK-2","TASK-32"]\t'), contract).mechanicalOk, true);
});

test('expected independently computed answer catches omissions, extras, duplicates and order mistakes', () => {
  for (const text of ['["TASK-2"]', '["TASK-2","TASK-32","TASK-99"]', '["TASK-32","TASK-2"]', '["TASK-2","TASK-32","TASK-32"]']) {
    assert.equal(verifyResult(valid(text), contract).contract.status, 'failed');
  }
  assert.equal(verifyResult(valid(), contract).mechanicalOk, true);
});

test('JSON equality ignores object key order but preserves value types, nested data and array order', () => {
  const schema = { format: 'json', type: 'object', expected: { a: 1, b: [{ x: true, y: null }, 2] } };
  assert.equal(verifyResult(valid('{"b":[{"y":null,"x":true},2],"a":1}'), schema).mechanicalOk, true);
  assert.equal(verifyResult(valid('{"a":"1","b":[{"x":true,"y":null},2]}'), schema).mechanicalOk, false);
  assert.equal(verifyResult(valid('{"a":1,"b":[2,{"x":true,"y":null}]}'), schema).mechanicalOk, false);
  assert.equal(verifyResult(valid('[{"a":1,"b":2},{"b":2,"a":1}]'), { format: 'json', type: 'array', uniqueItems: true }).mechanicalOk, false);
});

test('explicit types distinguish null, arrays, objects, integers, numbers, strings and booleans', () => {
  for (const [type, value] of [['null', null], ['array', []], ['object', {}], ['integer', 3], ['number', 2.5], ['string', 'x'], ['boolean', false]]) {
    assert.equal(verifyResult(valid(JSON.stringify(value)), { format: 'json', type, expected: value }).mechanicalOk, true);
  }
  for (const [type, text] of [['object', 'null'], ['object', '[]'], ['integer', '2.5'], ['number', '"1"'], ['boolean', '0']]) {
    assert.ok(verifyResult(valid(text), { format: 'json', type }).contract.issues.some(entry => entry.code === 'type_mismatch'));
  }
});

test('top-level key contracts reject omissions and extras with own-property semantics', () => {
  const schema = { format: 'json', type: 'object', requiredKeys: ['ok'], allowedKeys: ['ok', 'data'] };
  assert.equal(verifyResult(valid('{"ok":false}'), schema).mechanicalOk, true);
  assert.equal(verifyResult(valid('{"data":1}'), schema).mechanicalOk, false);
  assert.equal(verifyResult(valid('{"ok":true,"extra":1}'), schema).mechanicalOk, false);
  assert.equal(verifyResult(valid('{}'), { format: 'json', type: 'object', requiredKeys: ['toString'] }).mechanicalOk, false);
  assert.equal(verifyResult(valid('{"__proto__":1}'), { format: 'json', type: 'object', requiredKeys: ['__proto__'], allowedKeys: ['__proto__'] }).mechanicalOk, true);
});

test('invalid or inconsistent contracts fail closed; unsupported schema options are not ignored', () => {
  const circular = {}; circular.self = circular;
  for (const schema of [null, [], {}, { format: 'text', type: 'string' }, { format: 'json', type: '' },
    { format: 'json', type: 'array', items: { type: 'string' } },
    { format: 'json', type: 'array', requiredKeys: [] }, { format: 'json', type: 'object', uniqueItems: true },
    { format: 'json', type: 'array', uniqueItems: 'true' },
    { format: 'json', type: 'object', requiredKeys: ['x', 'x'] },
    { format: 'json', type: 'object', requiredKeys: ['x'], allowedKeys: [] },
    { format: 'json', type: 'integer', expected: 2.5 },
    { format: 'json', type: 'number', expected: Infinity },
    { format: 'json', type: 'null', expected: undefined },
    { format: 'json', type: 'object', expected: circular },
    { format: 'json', type: 'array', uniqueItems: true, expected: [1, 1] },
    { format: 'json', type: 'object', requiredKeys: ['x'], expected: {} },
  ]) {
    assert.ok(validateContract(schema).length);
    assert.equal(verifyResult(valid(), schema).contract.status, 'invalid');
  }
});

test('CLI uses exit 0/1/2, supports evaluation envelope and does not create repaired output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deepseek-verifier-'));
  try {
    const resultPath = join(dir, 'result.json');
    const contractPath = join(dir, 'contract.json');
    const script = fileURLToPath(new URL('../scripts/verify-result.mjs', import.meta.url));
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true });
    await writeFile(resultPath, JSON.stringify({ result: valid() }));
    await writeFile(contractPath, JSON.stringify(contract));
    assert.equal(run(resultPath, '--contract', contractPath).status, 0);
    await writeFile(resultPath, JSON.stringify(valid('["TASK-2"]')));
    const failed = run(resultPath, '--contract', contractPath);
    assert.equal(failed.status, 1);
    assert.equal(JSON.parse(failed.stdout).contract.issues[0].code, 'expected_mismatch');
    await writeFile(contractPath, '{}');
    assert.equal(run(resultPath, '--contract', contractPath).status, 2);
    assert.equal(run(resultPath, '--unknown', contractPath).status, 2);
    assert.equal(run(join(dir, 'missing.json')).status, 2);
    assert.equal(run('--help').status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
