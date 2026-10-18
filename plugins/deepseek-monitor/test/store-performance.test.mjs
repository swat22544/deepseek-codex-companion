import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,readFile,rm,utimes} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {listRuns} from '../server/store.mjs';

const idPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const idFor=index=>`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`;
async function tempRoot(t,label){
  const root=await mkdtemp(join(tmpdir(),label));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return root;
}
async function writeRecord(root,id,record={}){
  const path=join(root,'runs',id+'.json');
  await writeFile(path,JSON.stringify({version:1,id,done:true,status:'completed',backend:'harness',...record}));
  return path;
}

test('listRuns keeps the newest 100 by startedAt even when names and mtimes disagree',async t=>{
  const root=await tempRoot(t,'monitor-list-newest-');
  await mkdir(join(root,'runs'));
  const base=Date.parse('2026-10-14T12:00:00Z'),total=130;
  for(let index=0;index<total;index++){
    const path=await writeRecord(root,idFor(index),{startedAt:new Date(base-index*1000).toISOString(),title:'record-'+index});
    // Newer actual times receive older mtimes, so neither filename nor mtime can drive selection.
    const stamp=new Date(base+index*1000);
    await utimes(path,stamp,stamp);
  }
  await writeFile(join(root,'runs',idFor(500)+'.json'),JSON.stringify({version:1,id:idFor(500),done:true,status:'completed',startedAt:42}));
  await writeFile(join(root,'runs',idFor(501)+'.json'),'{not json');
  await writeFile(join(root,'runs',idFor(502)+'.json'),JSON.stringify({version:1,id:idFor(502),done:true,status:'completed',startedAt:new Date(base+60000).toISOString(),backend:'retired-backend'}));
  await writeFile(join(root,'runs','not-a-run.json'),JSON.stringify({version:1,id:'not-a-run',done:true,status:'completed',startedAt:new Date(base+60000).toISOString()}));
  const listed=await listRuns(root);
  assert.equal(listed.length,100);
  assert.deepEqual(listed.map(record=>record.title),Array.from({length:100},(_,index)=>'record-'+index));
  assert.equal(listed[0].startedAt,new Date(base).toISOString());
  for(let index=1;index<listed.length;index++)assert.ok(Date.parse(listed[index-1].startedAt)>=Date.parse(listed[index].startedAt));
});

test('listRuns keeps readdir order for equal startedAt and truncates to 100',async t=>{
  const root=await tempRoot(t,'monitor-list-ties-');
  await mkdir(join(root,'runs'));
  const startedAt='2026-10-14T00:00:00.000Z';
  for(let index=0;index<105;index++)await writeRecord(root,idFor(index),{startedAt,title:'tie-'+index});
  const names=await readdir(join(root,'runs'));
  const expected=names.filter(name=>idPattern.test(name.slice(0,-5))&&name.endsWith('.json')).slice(0,100).map(name=>name.slice(0,-5));
  const listed=await listRuns(root);
  assert.equal(listed.length,100);
  assert.deepEqual(listed.map(record=>record.id),expected);
});

test('listRuns isolates unusable records and only swallows ENOENT',async t=>{
  const root=await tempRoot(t,'monitor-list-isolation-');
  assert.deepEqual(await listRuns(root),[]);
  await mkdir(join(root,'runs'));
  await writeRecord(root,idFor(0),{startedAt:'2026-10-14T00:00:00.000Z',title:'kept'});
  // A legacy record without startedAt is normalized through updatedAt by getRun.
  await writeRecord(root,idFor(1),{updatedAt:'2026-10-14T01:00:00.000Z',title:'legacy'});
  await writeFile(join(root,'runs',idFor(2)+'.json'),JSON.stringify({version:1,id:idFor(2),done:true,status:'completed',startedAt:null}));
  await writeFile(join(root,'runs',idFor(3)+'.json'),JSON.stringify({version:1,id:idFor(3),done:true,status:'completed',startedAt:new Date().toISOString(),backend:'retired-backend'}));
  await writeFile(join(root,'runs',idFor(4)+'.json'),'{not json');
  const listed=await listRuns(root);
  assert.deepEqual(listed.map(record=>record.title),['legacy','kept']);
  await rm(join(root,'runs'),{recursive:true,force:true});
  await writeFile(join(root,'runs'),'not a directory');
  await assert.rejects(listRuns(root),error=>error.code==='ENOTDIR');
});

test('production history reader keeps at most eight file reads in flight',async t=>{
  const root=await tempRoot(t,'monitor-list-concurrency-');
  // Instrument only the filesystem boundary; execute the production reader.
  const shim=join(root,'instrumented-fs.mjs');
  await writeFile(shim,`export const metrics={active:0,peak:0,reads:0};
    export async function readdir(){return Array.from({length:64},(_,i)=>'00000000-0000-4000-8000-'+String(i).padStart(12,'0')+'.json');}
    export async function stat(){return {size:100};}
    export async function readFile(path){
      metrics.reads++;metrics.active++;metrics.peak=Math.max(metrics.peak,metrics.active);
      try {await new Promise(resolve=>setImmediate(resolve));
        const id=path.replaceAll('\\\\','/').split('/').at(-1).slice(0,-5);
        return JSON.stringify({version:1,id,done:true,startedAt:'2026-10-18T00:00:00Z'});
      }finally{metrics.active--;}
    }`);
  const source=await readFile(new URL('../server/store.mjs',import.meta.url),'utf8');
  const modulePath=join(root,'instrumented-store.mjs');
  await writeFile(modulePath,source.replace("'node:fs/promises'",JSON.stringify(pathToFileURL(shim).href)));
  const {listRuns:instrumented}=await import(pathToFileURL(modulePath).href);
  assert.equal((await instrumented(root)).length,64);
  const {metrics}=await import(pathToFileURL(shim).href);
  assert.equal(metrics.reads,64);
  assert.ok(metrics.peak>1&&metrics.peak<=8,JSON.stringify(metrics));
  assert.equal(metrics.active,0);
});
