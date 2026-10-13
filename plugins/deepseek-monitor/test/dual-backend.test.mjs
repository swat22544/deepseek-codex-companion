import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createMonitor} from '../../../skills/deepseek-helper/scripts/live-monitor.mjs';
import {getRun,listRuns,summary} from '../server/store.mjs';

test('parallel backends persist separate records and fixed source/model metadata',async()=>{
 const root=await mkdtemp(join(tmpdir(),'deepseek-backends-'));
 const monitors=[];
 try{
  monitors.push(...await Promise.all(['harness','opencode'].map(backend=>createMonitor({backend,instruction:'Same task title',mode:'propose'},{directory:join(root,'runs')}))));
  assert.notEqual(monitors[0].id,monitors[1].id);
  for(const [index,monitor] of monitors.entries()){
   monitor.harness({type:'session',directory:'PRIVATE DIRECTORY'});
   monitor.control({event:'model',backend:'PRIVATE BACKEND',apiKey:'PRIVATE KEY'});
   monitor.control({event:'active'});
   await monitor.finish({ok:true,policyActive:true,modelSelectionVerified:true,final:{text:'Reply '+index}});
  }
  const records=await Promise.all(monitors.map(monitor=>getRun(monitor.id,root)));
  for(const [index,record] of records.entries()){
   const backend=index?'opencode':'harness',label=index?'OpenCode':'Harness';
   assert.equal(record.backend,backend);
   assert.deepEqual(record.model,{model:'deepseek-flash',reasoningEffort:'max'});
   assert.equal(record.events.find(event=>event.kind==='session').label,`DeepSeek 已启动 · ${label}`);
   assert.equal(record.events.find(event=>event.kind==='model').label,`Flash / Max 已确认 · ${label}`);
   assert.equal(record.reply,'Reply '+index);
   assert.equal(record.done,true);
   assert.equal(record.modelSelectionVerified,true);
   assert.equal(JSON.stringify(record).includes('PRIVATE'),false);
  }
  assert.deepEqual((await listRuns(root)).map(record=>record.backend).sort(),['harness','opencode']);
 }finally{
  await Promise.all(monitors.map(monitor=>monitor.finish({ok:false})));
  await rm(root,{recursive:true,force:true});
 }
});

test('monitor creation defaults legacy or arbitrary backend values without persisting them',async()=>{
 const root=await mkdtemp(join(tmpdir(),'deepseek-backend-safe-'));
 try{
  for(const backend of [undefined,null,'HARNESS','PRIVATE C:/credentials',{path:'PRIVATE PATH'},['opencode']]){
   const monitor=await createMonitor({backend,instruction:'Source fallback'},{directory:join(root,'runs')});
   await monitor.finish({ok:true});
   const raw=await readFile(monitor.path,'utf8'),record=JSON.parse(raw);
   assert.equal(record.backend,'harness');
   assert.equal(raw.includes('PRIVATE'),false);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test('legacy detail/list and summary normalize backend through a fixed allowlist',async()=>{
 const root=await mkdtemp(join(tmpdir(),'deepseek-backend-legacy-'));
 try{
  await mkdir(join(root,'runs'));
  for(const backend of [undefined,'harness','opencode','PRIVATE UNKNOWN',{credential:'PRIVATE KEY'},['opencode']]){
   const id=randomUUID(),expected=backend==='opencode'?'opencode':'harness';
   const record={version:1,id,done:true,status:'completed',startedAt:new Date().toISOString(),backend};
   await writeFile(join(root,'runs',id+'.json'),JSON.stringify(record));
   assert.equal(summary(record).backend,expected);
   const detail=await getRun(id,root);
   assert.equal(detail.backend,expected);
   assert.equal(JSON.stringify(detail).includes('PRIVATE'),false);
  }
  const listed=await listRuns(root);
  assert.equal(listed.length,6);
  assert.equal(listed.filter(record=>record.backend==='opencode').length,1);
  assert.equal(JSON.stringify(listed).includes('PRIVATE'),false);
 }finally{await rm(root,{recursive:true,force:true});}
});
