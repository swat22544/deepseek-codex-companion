import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createMonitor} from '../../../skills/deepseek-helper/scripts/live-monitor.mjs';
import {getRun,listRuns,summary} from '../server/store.mjs';
import {startServer} from '../server/http.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'companion-backend-test-'));
 t.after(async()=>{
  assert.match(relative(resolve(tmpdir()),resolve(root)),/^companion-backend-test-[^\\/]+$/);
  await rm(root,{recursive:true,force:true});
 });
 await mkdir(join(root,'runs'));
 return root;
}

test('ZCode monitor records GLM identity while Harness retains DeepSeek',async t=>{
 const root=await fixture(t);
 for(const [backend,label,model,display]of [['harness','Harness','deepseek-flash','DeepSeek-V41-Flash'],['zcode','ZCode','GLM-5.3-Flash','GLM-5.3-Flash']]){
  const monitor=await createMonitor({backend,instruction:'Backend identity fixture'},{directory:join(root,'runs')});
  try{
   const initial=JSON.parse(await readFile(monitor.path,'utf8'));
   assert.equal(initial.modelSelectionVerified,false);
   assert.deepEqual(initial.model,{model,reasoningEffort:'max'});
   monitor.harness({type:'session'});
   monitor.control({event:'model',model:'PRIVATE_MODEL',reasoningEffort:'PRIVATE_EFFORT'});
   await monitor.finish({ok:true,policyActive:true,modelSelectionVerified:true,final:{text:'fixture complete'}});
   const final=await getRun(monitor.id,root);
   assert.equal(final.backend,backend);
   assert.deepEqual(final.model,{model,reasoningEffort:'max'});
   assert.equal(final.modelSelectionVerified,true);
   assert.equal(final.events.find(event=>event.kind==='session').label,`${display} 已启动 · ${label}`);
   assert.equal(final.events.find(event=>event.kind==='model').label,`${display} / Max 已确认 · ${label}`);
   assert.equal(JSON.stringify(final).includes('PRIVATE'),false);
  }finally{await monitor.finish({ok:false});}
 }
});

test('supported records keep backend and model; missing backend remains Harness',async t=>{
 const root=await fixture(t),records=[];
 for(const backend of [undefined,'harness','zcode']){
  const record={id:randomUUID(),version:1,backend,done:true,status:'completed',startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),model:{model:backend==='zcode'?'GLM-5.3-Flash':'deepseek-flash',reasoningEffort:'max'}};
  const contents=JSON.stringify(record);await writeFile(join(root,'runs',record.id+'.json'),contents);
  records.push({record,contents});
 }
 const listed=await listRuns(root);
 assert.equal(listed.length,3);
 for(const {record,contents}of records){
  const detail=await getRun(record.id,root),brief=listed.find(item=>item.id===record.id);
  for(const result of [detail,brief]){
   assert.equal(result.backend,record.backend??'harness');assert.deepEqual(result.model,record.model);
  }
  assert.equal(await readFile(join(root,'runs',record.id+'.json'),'utf8'),contents);
 }
});

test('monitor store filters model metadata and does not relay unknown or mismatched identities',async t=>{
 const root=await fixture(t);
 for(const backend of ['harness','zcode']){
  const expected=backend==='zcode'?'GLM-5.3-Flash':'deepseek-flash';
  const valid={model:expected,reasoningEffort:'max',privatePayload:'PRIVATE'};
  assert.deepEqual(summary({backend,model:valid}).model,{model:expected,reasoningEffort:'max'});
  for(const model of [undefined,{}, {model:'PRIVATE',reasoningEffort:'PRIVATE'},{model:expected,reasoningEffort:'high'},{model:backend==='zcode'?'deepseek-flash':'GLM-5.3-Flash',reasoningEffort:'max'}]){
   const record={id:randomUUID(),version:1,backend,model,done:true,startedAt:new Date().toISOString()};
   await writeFile(join(root,'runs',record.id+'.json'),JSON.stringify(record));
   assert.equal((await getRun(record.id,root)).model,null);
   assert.equal(summary(record).model,null);
  }
 }
 for(const backend of ['PRIVATE',{},['zcode'],'constructor','retired-backend'])assert.equal(summary({backend}),null);
});

test('HTTP monitor exposes supported backends and rejects unsupported records',async t=>{
 const root=await fixture(t);
 const records=['zcode','harness','retired-backend'].map(backend=>({id:randomUUID(),version:1,backend,title:'same title',done:true,status:'completed',startedAt:new Date().toISOString(),model:{model:backend==='zcode'?'GLM-5.3-Flash':'deepseek-flash',reasoningEffort:'max',privatePayload:'PRIVATE'}}));
 for(const record of records)await writeFile(join(root,'runs',record.id+'.json'),JSON.stringify(record));
 const {server,url,token}=await startServer({root});
 try{
  const base=url.split('/#')[0],headers={Authorization:'Bearer '+token};
  const response=await fetch(base+'/api/runs',{headers});assert.equal(response.status,200);
  const body=await response.json();assert.equal(JSON.stringify(body).includes('PRIVATE'),false);
  assert.deepEqual(body.runs.map(run=>run.backend).sort(),['harness','zcode']);
  for(const record of records){
   const detail=await fetch(base+'/api/runs/'+record.id,{headers});
   if(record.backend==='retired-backend'){assert.equal(detail.status,404);continue;}
   assert.equal(detail.status,200);
   const body=await detail.json();assert.equal(JSON.stringify(body).includes('PRIVATE'),false);
   assert.equal(body.run.backend,record.backend);
   assert.equal(body.run.model.model,record.model.model);
  }
 }finally{await new Promise(resolve=>server.close(resolve));}
});
