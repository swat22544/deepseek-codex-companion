import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildOpenCodeConfig,verifyRuntimeEvidence,runOwned,assertCleanGlobalConfig,AGENT} from '../scripts/opencode-runner.mjs';
import {validateRequest} from '../scripts/helper-policy.mjs';
import {delegate} from '../scripts/delegate.mjs';

test('unknown backends never silently enter Harness',async()=>{
  const request={taskType:'draft',instruction:'Bounded task',input:''};
  assert.equal(validateRequest(request).backend,'harness');
  for(const backend of ['typo',null,{},false])await assert.rejects(()=>delegate({...request,backend}),/backend must/);
});

test('OpenCode modes deny all builtins and allow only their named snapshot tools',()=>{
  for(const [mode,count]of [['text',0],['inspect',3],['propose',4]]){
    const c=buildOpenCodeConfig({mode,policyPath:join(tmpdir(),'policy.json'),mcpAuditPath:join(tmpdir(),'audit.jsonl'),guardPath:join(tmpdir(),'guard.mjs')});
    assert.deepEqual(c.agents[AGENT].permissions[0],{action:'*',resource:'*',effect:'deny'});
    assert.equal(c.agents[AGENT].permissions.length,count+1);
    assert.equal(c.agents[AGENT].model,'deepseek/deepseek-flash#max');
    assert.equal(Object.keys(c.mcp.servers).length,count?1:0);
    if(count)assert.equal(c.mcp.servers.codex_helper.codemode,false);
    assert.equal(c.compaction.auto,false);assert.equal(c.warming,false);
    assert.ok(c.agents[AGENT].permissions.slice(1).every(p=>p.action.startsWith('codex_helper_helper_')));
  }
});

test('runtime evidence requires the fixed model on every step and terminal public text',()=>{
  const model={id:'deepseek-flash',providerID:'deepseek',variant:'max'};
  const session={id:'ses_test',agent:AGENT,model,outcome:'succeeded',time:{idle:100}};
  const message={id:'msg_1',type:'assistant',agent:AGENT,model,time:{completed:90},finish:'stop',content:[{type:'reasoning',text:'PRIVATE SENTINEL'},{type:'text',text:'public answer'}]};
  assert.equal(verifyRuntimeEvidence(session,[message],'ses_test').final.text,'public answer');
  for(const wrong of [{...message,model:{...model,variant:'high'}},{...message,agent:'build'},{...message,time:{}},{...message,error:true},{...message,finish:'tool-calls'},{...message,content:[{type:'reasoning',text:'PRIVATE'}]}])assert.throws(()=>verifyRuntimeEvidence(session,[wrong],'ses_test'));
  assert.throws(()=>verifyRuntimeEvidence({...session,outcome:'running'},[message],'ses_test'));
  assert.throws(()=>verifyRuntimeEvidence(session,[],'ses_test'));
});

test('owned child captures success, rejects failures and refuses output over budget',async()=>{
  assert.equal((await runOwned(process.execPath,['-e','process.stdout.write("safe")'])).output,'safe');
  await assert.rejects(()=>runOwned(process.execPath,['-e','process.stderr.write("PRIVATE SENTINEL");process.exit(7)']),e=>e.exitCode===7&&!e.message.includes('PRIVATE')&&e.cleanup.incomplete===false);
  await assert.rejects(()=>runOwned(process.execPath,['-e','process.stdout.write("x".repeat(9000))'],{maxBytes:100}),/output limit/);
});

test('owned child is killed on watchdog expiry and reports its cleanup',async()=>{
  await assert.rejects(()=>runOwned(process.execPath,['-e','setInterval(()=>{},1000)'],{limitMs:150}),e=>e.cleanup.requested===true&&e.cleanup.treeKillConfirmed===true&&e.cleanup.incomplete===false&&/timed out/.test(e.message));
});

test('system plugins fail closed without reading their contents',async()=>{
  const root=await mkdtemp(join(tmpdir(),'oc-policy-'));
  try{
    const env={XDG_CONFIG_HOME:join(root,'config'),ProgramData:join(root,'system')};
    await assertCleanGlobalConfig({env,home:root});
    await mkdir(join(env.ProgramData,'opencode','plugins'),{recursive:true});
    await writeFile(join(env.ProgramData,'opencode','plugins','untrusted.js'),'throw new Error("must not execute")');
    await assert.rejects(()=>assertCleanGlobalConfig({env,home:root}),/requires review/);
  }finally{await rm(root,{recursive:true,force:true});}
});
