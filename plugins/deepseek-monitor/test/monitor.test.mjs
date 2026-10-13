import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createMonitor} from '../../../skills/deepseek-helper/scripts/live-monitor.mjs';
import {getRun,listRuns} from '../server/store.mjs';
import {startServer} from '../server/http.mjs';

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
test('stale unfinished task is visibly interrupted',async()=>{
 const root=await mkdtemp(join(tmpdir(),'deepseek-monitor-stale-')),id=randomUUID();await mkdir(join(root,'runs'));
 await writeFile(join(root,'runs',id+'.json'),JSON.stringify({id,version:1,done:false,updatedAt:'2020-01-01T00:00:00Z'}));
 assert.equal((await getRun(id,root)).status,'interrupted');
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
