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
  monitors.push(...await Promise.all(['harness','zcode'].map(backend=>createMonitor({backend,instruction:'Same task title',mode:'propose'},{directory:join(root,'runs')}))));
  assert.notEqual(monitors[0].id,monitors[1].id);
  for(const [index,monitor] of monitors.entries()){
   monitor.harness({type:'session',directory:'PRIVATE DIRECTORY'});
   monitor.control({event:'model',backend:'PRIVATE BACKEND',apiKey:'PRIVATE KEY'});
   monitor.control({event:'active'});
   await monitor.finish({ok:true,policyActive:true,modelSelectionVerified:true,final:{text:'Reply '+index}});
  }
  const records=await Promise.all(monitors.map(monitor=>getRun(monitor.id,root)));
  for(const [index,record] of records.entries()){
   const backend=index?'zcode':'harness',label=index?'ZCode':'Harness',model=index?'GLM-5.3-Flash':'deepseek-flash',display=index?'GLM-5.3-Flash':'DeepSeek-V4.1-Flash-1017';
   assert.equal(record.backend,backend);
   assert.deepEqual(record.model,{model,reasoningEffort:index?'high':'max'});
   assert.equal(record.events.find(event=>event.kind==='session').label,`${display} 已启动 · ${label}`);
   assert.equal(record.events.find(event=>event.kind==='model').label,`${display} / ${index?'High':'Max'} 已确认 · ${label}`);
   assert.equal(record.reply,'Reply '+index);
   assert.equal(record.done,true);
   assert.equal(record.modelSelectionVerified,true);
   assert.equal(JSON.stringify(record).includes('PRIVATE'),false);
  }
  assert.deepEqual((await listRuns(root)).map(record=>record.backend).sort(),['harness','zcode']);
 }finally{
  await Promise.all(monitors.map(monitor=>monitor.finish({ok:false})));
  await rm(root,{recursive:true,force:true});
 }
});

test('monitor creation defaults missing backend and rejects explicit unsupported values',async()=>{
 const root=await mkdtemp(join(tmpdir(),'deepseek-backend-safe-'));
 try{
  const monitor=await createMonitor({instruction:'Source fallback'},{directory:join(root,'runs')});
  await monitor.finish({ok:true});
  assert.equal(JSON.parse(await readFile(monitor.path,'utf8')).backend,'harness');
  for(const backend of [null,'HARNESS','retired-backend','PRIVATE C:/credentials',{path:'PRIVATE PATH'},['zcode']])await assert.rejects(()=>createMonitor({backend,instruction:'Invalid source'},{directory:join(root,'runs')}),/Unsupported monitor backend/);
  assert.equal((await listRuns(root)).length,1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('detail rejects unsupported backends and list omits them without a Harness fallback',async()=>{
 const root=await mkdtemp(join(tmpdir(),'deepseek-backend-legacy-'));
 try{
  await mkdir(join(root,'runs'));
  for(const backend of [undefined,'harness','zcode','retired-backend','PRIVATE UNKNOWN',{credential:'PRIVATE KEY'},['zcode']]){
   const id=randomUUID(),supported=backend===undefined||backend==='harness'||backend==='zcode';
   const record={version:1,id,done:true,status:'completed',startedAt:new Date().toISOString(),backend};
   await writeFile(join(root,'runs',id+'.json'),JSON.stringify(record));
   if(supported){
    assert.equal(summary(record).backend,backend??'harness');
    const detail=await getRun(id,root);
    assert.equal(detail.backend,backend??'harness');
    assert.equal(JSON.stringify(detail).includes('PRIVATE'),false);
   }else{
    assert.equal(summary(record),null);
    await assert.rejects(()=>getRun(id,root),/Unsupported run backend/);
   }
  }
  const listed=await listRuns(root);
  assert.equal(listed.length,3);
  assert.equal(listed.filter(record=>record.backend==='zcode').length,1);
  assert.equal(JSON.stringify(listed).includes('PRIVATE'),false);
 }finally{await rm(root,{recursive:true,force:true});}
});
