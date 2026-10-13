import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,resolve} from 'node:path';
import {validateRequest,snapshotFiles,createToolRuntime,hash} from '../scripts/helper-policy.mjs';
const dir=await mkdtemp(join(tmpdir(),'dsh-helper-tests-'));
after(async()=>{
 const target=resolve(dir);
 assert.match(relative(resolve(tmpdir()),target),/^dsh-helper-tests-[^\\/]+$/);
 await rm(target,{recursive:true,force:true});
});
const file=join(dir,'sample.py');await writeFile(file,'one\nneedle\nthree\n');
const snapshots=await snapshotFiles([file]);
const policy=mode=>({mode,files:snapshots,maxToolCalls:80,deadline:Date.now()+60000,artifactDir:join(dir,mode)});
test('request backwards compatibility and finite budgets',()=>{
 assert.equal(validateRequest({taskType:'extract',instruction:'x',input:''}).mode,'text');
 assert.equal(validateRequest({taskType:'review',instruction:'x',input:'',timeoutMs:1800000}).timeoutMs,1800000);
 assert.throws(()=>validateRequest({taskType:'review',instruction:'x',input:'',timeoutMs:3600001}));
 assert.throws(()=>validateRequest({taskType:'review',instruction:'x',input:'',mode:'inspect',files:['../x']}));
});
test('snapshots immutable and reads/search bounded',async()=>{
 await writeFile(file,'changed');const r=createToolRuntime(policy('inspect'));
 assert.match((await r.execute('helper_read_file',{file:'f1'})).text,/2: needle/);
 assert.equal((await r.execute('helper_search_text',{query:'needle'})).matches[0].line,2);
 await assert.rejects(r.execute('helper_read_file',{file:file}));
 await assert.rejects(r.execute('helper_write_artifact',{name:'bad.txt',content:'x'}));
});
test('text denies all tools',async()=>{
 const r=createToolRuntime(policy('text'));await assert.rejects(r.execute('helper_list_files',{}));
});
test('candidate writes isolated, exclusive, traversal/device paths rejected',async()=>{
 const r=createToolRuntime(policy('propose'));
 for(const name of ['../escape.txt','C:escape.txt','sub/file.py','CON.txt','name.exe','x.']) await assert.rejects(r.execute('helper_write_artifact',{name,content:'x'}));
 const artifact=await r.execute('helper_write_artifact',{name:'candidate.py',content:'print(1)'});
 assert.equal(artifact.sha256,hash('print(1)'));
 await assert.rejects(r.execute('helper_write_artifact',{name:'candidate.py',content:'replace'}));
 assert.equal(await readFile(join(dir,'propose','candidate.py'),'utf8'),'print(1)');
 assert.equal(await readFile(file,'utf8'),'changed');
});
test('parallel writes cannot bypass total budget',async()=>{
 const r=createToolRuntime({...policy('propose'),artifactDir:join(dir,'budget')});
 const results=await Promise.allSettled(Array.from({length:6},(_,i)=>r.execute('helper_write_artifact',{name:`a${i}.txt`,content:'x'.repeat(256*1024)})));
 assert.equal(results.filter(x=>x.status==='fulfilled').length,4);
});
test('call/deadline limits and secret-like source exclusion',async()=>{
 const r=createToolRuntime({...policy('inspect'),maxToolCalls:1});await r.execute('helper_list_files',{});await assert.rejects(r.execute('helper_list_files',{}));
 const expired=createToolRuntime({...policy('inspect'),deadline:0});await assert.rejects(expired.execute('helper_list_files',{}));
 const env=join(dir,'.env');await writeFile(env,'DUMMY=1');await assert.rejects(snapshotFiles([env]));
 const binary=join(dir,'binary.dat');await writeFile(binary,Buffer.from([0,1]));await assert.rejects(snapshotFiles([binary]));
 await assert.rejects(snapshotFiles([dir]));
});
