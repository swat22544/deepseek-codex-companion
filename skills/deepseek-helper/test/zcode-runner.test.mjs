import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildZCodeConfig,verifyZCodeSnapshot,zcodeToolNames,createZCodeClient,ZCODE_MODEL,mergeCleanup,assertCleanZCodeAncestors} from '../scripts/zcode-runner.mjs';
const require=createRequire(import.meta.url);
const {ENDPOINT,validateWireRequest,createSseInspector}=require('../scripts/zcode-guard.cjs');
const policy={sessionId:'sess_test',allowedTools:[]};
const body=()=>({model:'GLM-5.3-Flash',reasoning_effort:'high',thinking:{type:'enabled'},enable_thinking:true,reasoning:{effort:'high'},stream:true,messages:[{role:'user',content:'supplied task'}]});
const validate=(value,options={})=>validateWireRequest(options.url??ENDPOINT,{method:'POST',body:JSON.stringify(value),...options.init},options.policy??policy);
const snapshot=()=>({session:{sessionId:'sess_test'},projection:{sessionId:'sess_test',status:'idle',turnCount:1,activeToolCalls:[],pendingPermissions:[]},settings:{model:{current:{providerId:'zai-standard-api',modelId:'GLM-5.3-Flash',options:{reasoningLevel:'high'}}},thoughtLevel:{current:'high',available:[{value:'low'},{value:'high'},{value:'max'}]}}});

test('ZCode exact standard API model and configured high effort are independently fixed',()=>{
  assert.deepEqual(ZCODE_MODEL,{provider:'zai-standard-api',model:'GLM-5.3-Flash',reasoningEffort:'high'});
  assert.deepEqual(validate(body()),{model:'GLM-5.3-Flash',reasoningEffort:'high',tools:[]});
  for(const mutation of [b=>b.model='GLM-5.3',b=>b.model='glm-5.3-flash',b=>b.reasoning_effort='max',b=>b.reasoning_effort='low',b=>b.reasoning.effort='max',b=>b.thinking.type='disabled',b=>b.enable_thinking=false,b=>delete b.reasoning,b=>b.stream=false]){
    const candidate=body();mutation(candidate);assert.throws(()=>validate(candidate),/MODEL_MISMATCH/);
  }
});
test('wire guard rejects alternate providers, credentials in URL, queries, and non-POST',()=>{
  for(const url of ['https://api.z.ai/api/anthropic/messages','https://open.bigmodel.cn/api/paas/v4/chat/completions',ENDPOINT+'?token=SECRET','https://secret@api.z.ai/api/paas/v4/chat/completions'])assert.throws(()=>validate(body(),{url}),/ENDPOINT_MISMATCH/);
  assert.throws(()=>validate(body(),{init:{method:'GET'}}),/METHOD_MISMATCH/);
});
test('wire guard checks exact tool set including duplicates and missing tools',()=>{
  const allowedTools=zcodeToolNames('inspect'),makeTool=name=>({type:'function',function:{name,parameters:{type:'object'}}});
  const good={...body(),tools:allowedTools.map(makeTool)};
  assert.equal(validate(good,{policy:{...policy,allowedTools}}).tools.length,3);
  for(const names of [[...allowedTools,'Bash'],allowedTools.slice(1),[...allowedTools,allowedTools[0]]])assert.throws(()=>validate({...body(),tools:names.map(makeTool)},{policy:{...policy,allowedTools}}),/TOOL_MISMATCH/);
  assert.throws(()=>validate(good),/TOOL_MISMATCH/);
  assert.deepEqual(zcodeToolNames('text'),[]);assert.equal(zcodeToolNames('propose').length,4);
});
test('wire guard requires a supervisor-bound session and bounded parseable body',()=>{
  assert.throws(()=>validate(body(),{policy:{...policy,sessionId:null}}),/SESSION_NOT_READY/);
  assert.throws(()=>validateWireRequest(ENDPOINT,{method:'POST',body:'broken'},policy),/BODY_INVALID/);
  assert.throws(()=>validateWireRequest(ENDPOINT,{method:'POST',body:'x'.repeat(4*1024*1024+1)},policy),/BODY_INVALID/);
});
test('SSE inspector exposes public text but only counts private reasoning',()=>{
  const output=[],inspector=createSseInspector(e=>output.push(e));
  const data=Buffer.from('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'PRIVATE_SENTINEL',content:'公开答案😀'}}]})+'\n\n'+'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\n'+'data: [DONE]\n');
  for(const byte of data)inspector.push(Uint8Array.of(byte));inspector.finish();
  assert.equal(JSON.stringify(output).includes('PRIVATE_SENTINEL'),false);
  assert.equal(output.find(e=>e.event==='reply_stream').text,'公开答案😀');
  assert.equal(output.find(e=>e.event==='progress').charCount,'PRIVATE_SENTINEL公开答案😀'.length);
  assert.equal(output.at(-1).reason,'stop');
});
test('SSE inspector does not turn comments or unknown events into progress',()=>{
  const output=[],inspector=createSseInspector(e=>output.push(e));inspector.push(Buffer.from(': heartbeat\n\nevent: ping\ndata: {"arbitrary":"ignored"}\n'));inspector.finish();assert.deepEqual(output,[]);
  assert.throws(()=>{const bad=createSseInspector(()=>{});bad.push(Buffer.from('data: invalid\n'));},/STREAM_INVALID/);
  assert.throws(()=>{const limited=createSseInspector(()=>{},{maxBytes:3});limited.push(Buffer.from('1234'));},/STREAM_LIMIT/);
});
test('ZCode config disables unrelated skills, hooks, plugins and subagents',()=>{
  const config=buildZCodeConfig('isolated',[]);
  assert.equal(config.plugins.enabled,false);assert.equal(config.skills.enabled,false);assert.equal(config.hooks.enabled,false);assert.equal(config.features.subagent,false);assert.equal(config.features.memory,false);assert.deepEqual(config.mcp.servers,{});assert.equal(config.permission.mode,'guarded');
});
test('snapshot verification separates pre-input placeholder from completed identity',()=>{
  assert.equal(verifyZCodeSnapshot(snapshot(),'sess_test',{completed:true}),true);
  const initial=snapshot();initial.projection.sessionId='unknown';initial.projection.turnCount=0;
  assert.equal(verifyZCodeSnapshot(initial,'sess_test'),true);
  assert.throws(()=>verifyZCodeSnapshot(initial,'sess_test',{completed:true}),/evidence mismatch/);
  for(const mutation of [s=>s.settings.model.current.providerId='zai-api',s=>s.settings.model.current.modelId='GLM-5.3',s=>s.settings.model.current.options.reasoningLevel='max',s=>s.settings.model.current.options.reasoningLevel='low',s=>s.settings.thoughtLevel.current='max',s=>s.projection.sessionId='sess_other']){
    const candidate=snapshot();mutation(candidate);assert.throws(()=>verifyZCodeSnapshot(candidate,'sess_test'),/evidence mismatch/);
  }
});
test('completed snapshot rejects pending tool execution and permissions',()=>{
  for(const mutation of [s=>s.projection.status='running',s=>s.projection.activeToolCalls=[{}],s=>s.projection.pendingPermissions=[{}]]){
    const candidate=snapshot();mutation(candidate);assert.throws(()=>verifyZCodeSnapshot(candidate,'sess_test',{completed:true}),/completion evidence/);
  }
});
test('snapshot verification binds the isolated workspace',()=>{
  const candidate=snapshot();candidate.session.workspace={workspacePath:'isolated',workspaceKey:'isolated'};
  assert.equal(verifyZCodeSnapshot(candidate,'sess_test',{workspace:'isolated'}),true);
  assert.throws(()=>verifyZCodeSnapshot(candidate,'sess_test',{workspace:'user-project'}),/workspace evidence/);
});
test('cleanup merging never erases previous incomplete process termination',()=>{
  assert.deepEqual(mergeCleanup({requested:true,treeKillConfirmed:false,incomplete:true},{requested:false,treeKillConfirmed:false,incomplete:false}),{requested:true,treeKillConfirmed:false,incomplete:true});
  assert.deepEqual(mergeCleanup({requested:false,treeKillConfirmed:false,incomplete:false},{requested:true,treeKillConfirmed:true,incomplete:false}),{requested:true,treeKillConfirmed:true,incomplete:false});
});
test('ancestor project config is rejected before loading ZCode',()=>{
  const root=mkdtempSync(join(tmpdir(),'zcode-ancestor-test-')),workspace=join(root,'child');mkdirSync(workspace);
  try{writeFileSync(join(root,'zcode.json'),'{}');assert.throws(()=>assertCleanZCodeAncestors(workspace),/ancestor project configuration/);}finally{rmSync(root,{recursive:true,force:true});}
});
test('installed network guard forbids redirect forwarding and filters private stream text',()=>{
  const root=mkdtempSync(join(tmpdir(),'zcode-network-test-')),policyPath=join(root,'policy.json'),auditPath=join(root,'audit.jsonl');
  const fixturePolicy={...policy,nonce:'fixture',auditPath,maxModelRequests:1,deadline:Date.now()+20000};writeFileSync(policyPath,JSON.stringify(fixturePolicy));
  const modulePath=fileURLToPath(new URL('../scripts/zcode-guard.cjs',import.meta.url));
  const code=`(async()=>{let redirect;globalThis.fetch=async(u,i)=>{redirect=i.redirect;return new Response('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'PRIVATE_SENTINEL',content:'public'}}]})+'\\n',{headers:{'content-type':'text/event-stream'}});};require(${JSON.stringify(modulePath)}).installGuard(${JSON.stringify(policyPath)});const response=await fetch(${JSON.stringify(ENDPOINT)},{method:'POST',redirect:'follow',headers:{authorization:'Bearer PRIVATE_HEADER'},body:${JSON.stringify(JSON.stringify(body()))}});await response.text();console.log(JSON.stringify({redirect,audit:require('node:fs').readFileSync(${JSON.stringify(auditPath)},'utf8')}));})().catch(()=>process.exitCode=1);`;
  try{const run=spawnSync(process.execPath,['-e',code],{encoding:'utf8',timeout:10000,windowsHide:true});assert.equal(run.status,0,run.stderr);const result=JSON.parse(run.stdout);assert.equal(result.redirect,'error');assert.match(result.audit,/public/);assert.doesNotMatch(result.audit,/PRIVATE_SENTINEL|PRIVATE_HEADER|authorization/);}finally{rmSync(root,{recursive:true,force:true});}
});
test('NDJSON client exchanges control messages and closes its own process',async()=>{
  const source=`let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);process.stdout.write(JSON.stringify({id:m.id,result:{accepted:m.method}})+'\\n');}});`;
  const client=createZCodeClient(process.execPath,['-e',source]);
  assert.deepEqual(await client.rpc('test',{}),{accepted:'test'});
  const end=await client.close();assert.equal(end.exitCode,0);assert.equal(end.cleanup.incomplete,false);
});
test('NDJSON client hides provider error messages behind safe categories',async()=>{
  const source=`process.stdin.on('data',d=>{const m=JSON.parse(d);process.stdout.write(JSON.stringify({id:m.id,error:{status:429,message:'PRIVATE_SENTINEL rate limit exceeded'}})+'\\n');});`;
  const client=createZCodeClient(process.execPath,['-e',source]);
  try{await assert.rejects(client.rpc('test',{}),e=>{assert.equal(e.message.includes('PRIVATE_SENTINEL'),false);assert.equal(JSON.stringify(e.details).includes('PRIVATE_SENTINEL'),false);assert.equal(e.details.httpStatus,429);return true;});}finally{await client.close();}
});
