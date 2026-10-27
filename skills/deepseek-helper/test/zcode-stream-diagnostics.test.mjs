import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';

// A local protocol fixture, not a provider call. The real runner and preloaded
// guard run unchanged; the fixture supplies the failure envelopes/audit records.
test('runner preserves local stream-limit evidence through a simultaneous unknown turn.failed',async t=>{
 const root=await mkdtemp(join(tmpdir(),'zcode-stream-diagnostic-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'resources','glm'),{recursive:true});
 const fixture=`
 const fs=require('node:fs');
 if(process.argv.includes('--version')){console.log('0.16.9');process.exit(0);}
 const sessionId='sess_fixture';let workspace,buffer='';
 const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
 process.stdin.on('data',data=>{buffer+=data;let pos;while((pos=buffer.indexOf('\\n'))>=0){const m=JSON.parse(buffer.slice(0,pos));buffer=buffer.slice(pos+1);let result={};
 if(m.method==='session/create'){workspace=m.params.workspace;result={session:{sessionId,workspace},projection:{sessionId,status:'idle',turnCount:0,activeToolCalls:[],pendingPermissions:[]},settings:{model:{current:m.params.model},thoughtLevel:{current:'high',available:[{value:'high'},{value:'max'}]}}};}
 if(m.method==='session/subscribe')result={eventSeq:0};
 send({id:m.id,result});
 if(m.method==='session/send')setTimeout(()=>{
  const p=JSON.parse(fs.readFileSync(process.env.CODEX_ZCODE_POLICY,'utf8'));
  const events=[{event:'model',provider:'zai-standard-api',model:'GLM-5.3-Flash',reasoningEffort:'high',tools:[]},{event:'progress',charCount:41943},{event:'stream_error',code:'ZCODE_STREAM_LIMIT',wireBytes:8388800,dataEvents:41943,activityChars:41943,publicChars:0}];
  fs.appendFileSync(p.auditPath,events.map((e,i)=>JSON.stringify({nonce:p.nonce,seq:i+2,sessionId,requestIndex:1,...e})).join('\\n')+'\\n');
  send({method:'session/event',params:{sessionId,seq:1,type:'turn.failed',payload:{error:{type:'unmapped_vendor_type',message:'PRIVATE_SENTINEL'}}}});
 },20);
 }});
 `;
 await writeFile(join(root,'resources','glm','zcode.cjs'),fixture);
 const moduleUrl=new URL('../scripts/zcode-runner.mjs',import.meta.url).href;
 const source=`import {delegate} from ${JSON.stringify(moduleUrl)};const r=await delegate({backend:'zcode',taskType:'debug',mode:'text',instruction:'Local diagnostic fixture',input:'No provider call',taskSize:'small'});console.log(JSON.stringify(r));`;
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--input-type=module','-e',source],{cwd:root,env:{...process.env,DEEPSEEK_ZCODE_HOME:root,CODEX_HOME:join(root,'codex')},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.on('error',reject);
  child.on('close',code=>{try{assert.equal(code,0,err);resolve(JSON.parse(out));}catch(e){reject(e);}});
 });
 assert.equal(result.ok,false);assert.equal(result.timeout,null);assert.equal(result.cleanup.incomplete,false);
 assert.equal(result.cleanup.treeKillConfirmed,true);assert.match(result.error,/ZCODE_STREAM_LIMIT/);
 const detail={type:'supervisor.output-limit',httpStatus:null,source:'guard',reason:'stream_size_limit'};
 assert.deepEqual(result.errorDetails,detail);
 assert.ok(result.errorEvidence.some(e=>e.source==='guard'));
 assert.ok(result.errorEvidence.some(e=>e.source==='session'&&e.type==='unknown'));
 assert.deepEqual(result.streamDiagnostics,[{requestIndex:1,outcome:'error',code:'ZCODE_STREAM_LIMIT',wireBytes:8388800,dataEvents:41943,activityChars:41943,publicChars:0}]);
 const monitor=JSON.parse(await readFile(result.monitor.path,'utf8'));assert.deepEqual(monitor.errorDetails,detail);
 assert.equal(JSON.stringify({result,monitor}).includes('PRIVATE_SENTINEL'),false);
});
