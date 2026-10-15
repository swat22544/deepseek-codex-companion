import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createMonitor} from '../../../skills/deepseek-helper/scripts/live-monitor.mjs';
import {getRun,listRuns,summary} from '../server/store.mjs';
import {startServer} from '../server/http.mjs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

test('public stream updates, retry rollback, final replacement, private data exclusion',async()=>{
 const root=await mkdtemp(join(tmpdir(),'deepseek-monitor-test-'));
 const m=await createMonitor({instruction:'任务',input:'PRIVATE INPUT'}, {directory:join(root,'runs')});
 m.harness({type:'thinking',text:'PRIVATE REASONING'});
 m.harness({type:'tool_call',tool:'helper_read_file',input:{secret:'PRIVATE ARGS'}});
 m.control({event:'reply_stream',type:'start',attemptId:'a'});
 m.control({event:'reply_stream',type:'text_delta',attemptId:'a',blockIndex:0,text:'discard'});
 m.control({event:'reply_stream',type:'end',attemptId:'a',outcome:{kind:'abandoned'}});
 m.control({event:'reply_stream',type:'start',attemptId:'b'});
 m.control({event:'reply_stream',type:'text_delta',attemptId:'b',blockIndex:0,text:'live text'});
 await new Promise(r=>setTimeout(r,850));
 const live=await getRun(m.id,root);assert.equal(live.draft,'live text');assert.equal(live.done,false);
 m.harness({type:'text',text:'do not duplicate'});
 m.harness({type:'final',text:'EXACT FINAL'});
 m.control({event:'reply_stream',type:'end',attemptId:'b',outcome:{kind:'committed',eventType:'assistant/message'}});
 await m.finish({ok:true,final:{text:'EXACT FINAL'},policyActive:true,modelSelectionVerified:true});
 const bytes=await readFile(m.path,'utf8'),done=JSON.parse(bytes);
 assert.equal(done.reply,'EXACT FINAL');assert.equal(done.draft,'');assert.equal(done.status,'completed');assert.ok(!bytes.includes('PRIVATE'));assert.ok(!bytes.includes('discard'));
 assert.equal((await listRuns(root)).length,1);await assert.rejects(getRun('../policy',root));
});
test('stale observation does not claim model failure or mark its execution done',async()=>{
 const root=await mkdtemp(join(tmpdir(),'deepseek-monitor-stale-')),id=randomUUID();await mkdir(join(root,'runs'));
 await writeFile(join(root,'runs',id+'.json'),JSON.stringify({id,version:1,done:false,updatedAt:'2020-01-01T00:00:00Z'}));
 const result=await getRun(id,root);
 assert.equal(result.status,'interrupted');assert.equal(result.done,false);assert.equal(result.observationStale,true);
 assert.match(result.error,/这不等于模型失败/);assert.equal(summary(result).observationStale,true);
});
test('summary keeps timing and timeout fields with a bounded whitelist',()=>{
 const timing={taskSize:'large',sizeSource:'auto',totalSource:'explicit',idleSource:'auto',totalTimeoutMs:1200000,idleTimeoutMs:420000,inputBytes:100,fileCount:12,snapshotBytes:3000,totalElapsedMs:900000,idleElapsedMs:120000,totalRemainingMs:300000,idleRemainingMs:300000,lastProgressKind:'model_output'};
 const timeout={kind:'total',limitMs:1200000,elapsedMs:1200001,totalElapsedMs:1200001,idleElapsedMs:450};
 const result=summary({timing:{...timing,privatePayload:{secret:'do not expose'}},timeout:{...timeout,rawPrompt:'do not expose'}});
 assert.deepEqual(result.timing,timing);assert.deepEqual(result.timeout,timeout);
 assert.ok(!JSON.stringify(result).includes('do not expose'));
});
test('legacy and malformed timing never invent a budget or forward unbounded data',()=>{
 assert.equal(Object.hasOwn(summary({}), 'timing'),false);
 assert.equal(Object.hasOwn(summary({}), 'timeout'),false);
 assert.equal(summary({timeout:null}).timeout,null);
 for(const timing of [null,[],true,'text',{totalTimeoutMs:-1,idleTimeoutMs:'300000',fileCount:Infinity,taskSize:{x:1},sizeSource:'secret',lastProgressKind:'unexpected'}])assert.equal(summary({timing}).timing,undefined);
 for(const timeout of [[],{kind:'network'},{kind:{x:1}},'idle'])assert.equal(summary({timeout}).timeout,undefined);
 assert.deepEqual(summary({timing:{taskSize:'small',lastProgressKind:null},timeout:{kind:'idle',limitMs:NaN,elapsedMs:-4}}).timing,{taskSize:'small',lastProgressKind:null});
 assert.deepEqual(summary({timeout:{kind:'idle',limitMs:NaN,elapsedMs:-4}}).timeout,{kind:'idle'});
});
test('MCP list exposes backend, safe timing summary and timeout cause',async()=>{
 const codexHome=await mkdtemp(join(tmpdir(),'deepseek-monitor-timing-mcp-')),id=randomUUID();
 const runs=join(codexHome,'deepseek-monitor','runs');await mkdir(runs,{recursive:true});
 await writeFile(join(runs,id+'.json'),JSON.stringify({id,version:1,backend:'zcode',status:'failed',done:true,startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),timing:{taskSize:'large',totalTimeoutMs:1200000,idleTimeoutMs:420000,totalElapsedMs:500000,idleElapsedMs:420000,privatePayload:'PRIVATE'},timeout:{kind:'idle',limitMs:420000,elapsedMs:420000,extra:'PRIVATE'}}));
 const child=spawn(process.execPath,[fileURLToPath(new URL('../server/mcp.mjs',import.meta.url))],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,CODEX_HOME:codexHome}});
 const reader=createInterface({input:child.stdout});
 try{
  const response=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('MCP timing test timed out')),5000);reader.on('line',line=>{const message=JSON.parse(line);if(message.id===1){clearTimeout(timer);resolve(message);}});});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'monitor_list',arguments:{}}})+'\n');
  const message=await response,record=message.result.structuredContent.runs[0];
  assert.equal(record.backend,'zcode');assert.equal(record.timing.totalTimeoutMs,1200000);assert.equal(record.timeout.kind,'idle');assert.ok(!JSON.stringify(message).includes('PRIVATE'));
 }finally{reader.close();child.stdin.end();child.kill();}
});
test('HTTP monitor requires capability and rejects cross-origin and writes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'deepseek-monitor-http-'));
 const {server,url,token}=await startServer({root});
 try{
  const base=url.split('/#')[0];
  assert.equal((await fetch(base+'/api/runs')).status,401);
  assert.equal((await fetch(base+'/api/runs',{headers:{Authorization:'Bearer '+token,Origin:'https://example.com'}})).status,403);
  assert.equal((await fetch(base+'/api/runs',{method:'POST',headers:{Authorization:'Bearer '+token}})).status,405);
  const good=await fetch(base+'/api/runs',{headers:{Authorization:'Bearer '+token}});assert.equal(good.status,200);assert.deepEqual(await good.json(),{runs:[]});
 }finally{await new Promise(r=>server.close(r));}
});
