import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
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

test('backend verification preserves implicit Harness and rejects unsupported backends',()=>{
 assert.equal(verifyResult(valid()).mechanicalOk,true);
 assert.equal(verifyResult({...valid(),backend:'harness'}).mechanicalOk,true);
 for(const backend of ['',null,undefined,'retired-backend',{},1])assert.ok(verifyResult({...valid(),backend}).protocol.issues.some(entry=>entry.code==='backend_unsupported'));
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

test('ZCode requires the selected standard Z.ai provider, GLM model, Max and runtime evidence',()=>{
 const zcode={...valid(),backend:'zcode',runtimeEvidenceVerified:true,modelSelection:{provider:'zai-standard-api',model:'GLM-5.3-Flash',reasoningEffort:'max'}};
 assert.equal(verifyResult(zcode).mechanicalOk,true);
 for(const change of [
  {provider:'deepseek'},{provider:'zcode'},{provider:'account:zai-individual-coding-plan'},
  {model:'deepseek-flash'},{model:'GLM-5.3'},{model:'glm-5.3-flash'},{reasoningEffort:'high'}
 ])assert.ok(verifyResult({...zcode,modelSelection:{...zcode.modelSelection,...change}}).protocol.issues.some(item=>item.code==='model_mismatch'));
 for(const runtimeEvidenceVerified of [undefined,false,'true',1])assert.equal(verifyResult({...zcode,runtimeEvidenceVerified}).mechanicalOk,false);
 assert.equal(verifyResult({...zcode,backend:'retired-backend'}).mechanicalOk,false);
 assert.equal(verifyResult({...zcode,backend:'harness'}).mechanicalOk,false);
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

test('uniqueness preserves JSON semantics for special keys, strings and signed zero', () => {
  const schema={format:'json',type:'array',uniqueItems:true};
  const cases=[
    [[-0,0],true],
    [[0,'0',false,null,{},[]],false],
    [[{a:1,b:[2,3]},{b:[2,3],a:1}],true],
    [[{a:1,b:[2,3]},{b:[3,2],a:1}],false],
    [[JSON.parse('{"__proto__":{"x":1},"constructor":2}'),JSON.parse('{"constructor":2,"__proto__":{"x":1}}')],true],
    [[{'a,b':'c'},{a:'b,c'}],false],
    [[{'"x"':'[y]'},{x:'y'}],false],
    [[{'\u0000':'x'},{'':'\u0000x'}],false],
    [['é','e\u0301'],false],
    [['\ud800','\ud800'],true],
    [[{'10':1,'2':2},{'2':2,'10':1}],true],
  ];
  for(const [items,duplicate]of cases){
    const report=verifyResult(valid(JSON.stringify(items)),schema);
    assert.equal(report.contract.issues.some(entry=>entry.code==='duplicate_items'),duplicate,JSON.stringify(items));
    assert.equal(report.mechanicalOk,!duplicate);
  }
});

test('uniqueness matches an independent JSON deep-equality oracle on generated nested values',()=>{
  let seed=9137;
  const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  const primitives=[null,false,true,0,-0,2.5,'',']},:','中文','\ud800'];
  const value=depth=>{
    const kind=next()%4;
    if(!depth||kind<2)return primitives[next()%primitives.length];
    if(kind===2)return [value(depth-1),value(depth-1)];
    const keys=['b','a','__proto__','constructor','\u0000','10'];
    const result=Object.create(null);
    for(let i=0;i<2;i++)result[keys[next()%keys.length]]=value(depth-1);
    return result;
  };
  const samples=Array.from({length:80},()=>value(3));
  for(let i=0;i<200;i++){
    const left=samples[next()%samples.length],right=i%3===0?left:samples[next()%samples.length];
    const normalize=item=>JSON.parse(JSON.stringify(item));
    const expected=isDeepStrictEqual(normalize(left),normalize(right));
    const report=verifyResult(valid(JSON.stringify([left,right])),{format:'json',type:'array',uniqueItems:true});
    assert.equal(report.contract.issues.some(entry=>entry.code==='duplicate_items'),expected);
  }
});

test('direct API expected values retain per-item JSON round-trip normalization',()=>{
  const accessor=Object.defineProperty({},'a',{enumerable:true,get(){return 1;}});
  const serialized=Object.defineProperty({a:1},'toJSON',{value(){return {z:2};}});
  for(const expected of [[accessor,{a:1}],[serialized,{z:2}]]){
    assert.ok(validateContract({format:'json',type:'array',uniqueItems:true,expected}).some(entry=>entry.code==='contract_expected_constraints'));
  }
  assert.deepEqual(validateContract({format:'json',type:'array',uniqueItems:true,expected:[serialized,{a:1}]}),[]);
});

test('an 8000-item unique result completes within a bounded independent verifier process',()=>{
  const script=new URL('../scripts/verify-result.mjs',import.meta.url).href;
  const source=`import {verifyResult} from ${JSON.stringify(script)}; const result=${JSON.stringify(valid())}; result.final.text=JSON.stringify(Array.from({length:8000},(_,i)=>i)); const report=verifyResult(result,{format:'json',type:'array',uniqueItems:true}); console.log(JSON.stringify({ok:report.mechanicalOk}));`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:4096});
  assert.equal(child.error,undefined,child.error?.message);
  assert.equal(child.status,0,child.stderr);
  assert.deepEqual(JSON.parse(child.stdout),{ok:true});
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
