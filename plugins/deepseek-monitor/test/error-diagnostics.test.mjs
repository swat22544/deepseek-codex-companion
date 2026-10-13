import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createMonitor} from '../../../skills/deepseek-helper/scripts/live-monitor.mjs';
import {getRun,listRuns,summary} from '../server/store.mjs';
import {startServer} from '../server/http.mjs';

const extra={message:'PRIVATE_MESSAGE',headers:{Authorization:'PRIVATE_TOKEN'},body:'PRIVATE_BODY',url:'PRIVATE_URL',path:'PRIVATE_PATH'};
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'deepseek-error-diagnostics-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 return root;
}
const detail={type:'provider.invalid-request',httpStatus:400,source:'session',reason:'missing_reasoning_content'};
const recovery={status:'recovered',checkedMessages:3};

test('monitor persists only safe error and diagnostic fields, never exception objects',async t=>{
 const root=await fixture(t),monitor=await createMonitor({backend:'opencode',instruction:'Diagnostic projection'},{directory:join(root,'runs')});
 const result=await monitor.finish({ok:false,error:{...extra},errorDetails:{...detail,...extra},diagnosticRecovery:{...recovery,...extra}});
 assert.equal(result.available,true);
 const raw=await readFile(monitor.path,'utf8'),record=JSON.parse(raw);
 assert.deepEqual(record.errorDetails,detail);assert.deepEqual(record.diagnosticRecovery,recovery);
 assert.equal(record.error,null);assert.equal(record.status,'failed');assert.equal(record.done,true);
 assert.equal(raw.includes('PRIVATE'),false);
 assert.deepEqual(summary(record).errorDetails,detail);
 assert.deepEqual((await listRuns(root))[0].diagnosticRecovery,recovery);
});

test('writer and store normalize unknown diagnostic values without forwarding raw data',async t=>{
 const root=await fixture(t);
 for(const type of ['PRIVATE_UNKNOWN',{toString:'PRIVATE_TYPE'},['provider.auth']]){
  const monitor=await createMonitor({instruction:'Unknown diagnosis'},{directory:join(root,'runs')});
  await monitor.finish({ok:false,errorDetails:{type,httpStatus:401.5,source:'cli',reason:'PRIVATE_REASON',...extra},diagnosticRecovery:{status:'PRIVATE_STATUS',checkedMessages:1,...extra}});
  const raw=await readFile(monitor.path,'utf8'),record=JSON.parse(raw);
  assert.deepEqual(record.errorDetails,{type:'unknown',httpStatus:null,source:'cli',reason:null});
  assert.equal(record.diagnosticRecovery,null);assert.equal(raw.includes('PRIVATE'),false);
  assert.deepEqual(summary({errorDetails:{type,httpStatus:'401',source:'cli',reason:{private:'PRIVATE'}}}).errorDetails,{type:'unknown',httpStatus:null,source:'cli',reason:null});
 }
});

test('diagnostic projection accepts fixed types/reasons and only valid HTTP integers',()=>{
 const types=['unknown','aborted','permission.rejected','tool.execution','provider.rate-limit','provider.auth','provider.quota','provider.content-filter','provider.transport','provider.internal','provider.invalid-output','provider.invalid-request','provider.unsupported-operation','provider.no-route','provider.unknown','provider.timeout'];
 const reasons=['connection_reset','connection_refused','dns_failure','tls_failure','stream_interrupted','request_timeout','rate_limited','quota_exceeded','context_length_exceeded','missing_reasoning_content','invalid_tool_call','invalid_api_key','permission_denied','cancelled','provider_unavailable'];
 for(const type of types)assert.equal(summary({errorDetails:{...detail,type}}).errorDetails.type,type);
 for(const reason of reasons)assert.equal(summary({errorDetails:{...detail,reason}}).errorDetails.reason,reason);
 for(const httpStatus of [100,400,401,429,500,599])assert.equal(summary({errorDetails:{...detail,httpStatus}}).errorDetails.httpStatus,httpStatus);
 for(const httpStatus of [null,undefined,99,600,400.1,'401',Infinity,{},NaN])assert.equal(summary({errorDetails:{...detail,httpStatus}}).errorDetails.httpStatus,null);
 for(const source of ['cli','http','session'])assert.equal(summary({errorDetails:{...detail,source}}).errorDetails.source,source);
 for(const source of [undefined,null,'PRIVATE',{},['session']])assert.equal(summary({errorDetails:{...detail,source}}).errorDetails,null);
});

test('diagnostic recovery requires a known status and an actual nonnegative safe count',()=>{
 for(const status of ['not_needed','skipped','recovered','unavailable','failed','timed_out'])assert.deepEqual(summary({diagnosticRecovery:{status,checkedMessages:0,...extra}}).diagnosticRecovery,{status,checkedMessages:0});
 for(const checkedMessages of [undefined,null,-1,0.5,'2',Infinity,Number.MAX_SAFE_INTEGER+1,{}])assert.equal(summary({diagnosticRecovery:{status:'recovered',checkedMessages}}).diagnosticRecovery,null);
 for(const value of [null,[],true,'PRIVATE',{status:'constructor',checkedMessages:2}])assert.equal(summary({diagnosticRecovery:value}).diagnosticRecovery,null);
});

test('writer and summaries keep at most three independently projected error evidence records',async t=>{
 const root=await fixture(t),monitor=await createMonitor({backend:'opencode',instruction:'Independent evidence'},{directory:join(root,'runs')});
 const cli={type:'provider.transport',httpStatus:null,source:'cli',reason:'connection_reset'};
 const http={type:'unknown',httpStatus:502,source:'http',reason:null};
 const evidence=[{source:'PRIVATE',...extra},null,{...cli,...extra},{...http,...extra},{...detail,...extra},{type:'provider.auth',source:'http',httpStatus:401}];
 await monitor.finish({ok:false,errorDetails:cli,errorEvidence:evidence});
 const raw=await readFile(monitor.path,'utf8'),record=JSON.parse(raw);
 assert.deepEqual(record.errorDetails,cli);assert.deepEqual(record.errorEvidence,[cli,http,detail]);
 assert.equal(raw.includes('PRIVATE'),false);
 assert.deepEqual(summary({errorEvidence:evidence}).errorEvidence,[cli,http,detail]);
 assert.deepEqual((await getRun(record.id,root)).errorEvidence,[cli,http,detail]);
 assert.deepEqual((await listRuns(root))[0].errorEvidence,[cli,http,detail]);
 for(const value of [null,{},'PRIVATE',false])assert.deepEqual(summary({errorEvidence:value}).errorEvidence,[]);
 assert.deepEqual(summary({errorEvidence:[{source:'cli',type:{toString:'PRIVATE'},httpStatus:'401',reason:['PRIVATE']}]}).errorEvidence,[{source:'cli',type:'unknown',httpStatus:null,reason:null}]);
});

test('legacy records retain generic errors and do not invent diagnostic fields',async t=>{
 const root=await fixture(t),id=randomUUID();await mkdir(join(root,'runs'));
 const record={id,version:1,done:true,status:'failed',startedAt:new Date().toISOString(),error:'OpenCode reported a runtime/provider error.'};
 await writeFile(join(root,'runs',id+'.json'),JSON.stringify(record));
 const loaded=await getRun(id,root),listed=(await listRuns(root))[0];
 assert.equal(loaded.error,record.error);
 for(const value of [loaded,listed,summary({})]){
  assert.equal(Object.hasOwn(value,'errorDetails'),false);
  assert.equal(Object.hasOwn(value,'errorEvidence'),false);
  assert.equal(Object.hasOwn(value,'diagnosticRecovery'),false);
 }
});

test('HTTP detail and list independently remove arbitrary nested diagnostics from disk',async t=>{
 const root=await fixture(t),id=randomUUID();await mkdir(join(root,'runs'));
 await writeFile(join(root,'runs',id+'.json'),JSON.stringify({id,version:1,done:true,status:'failed',startedAt:new Date().toISOString(),error:{...extra},errorDetails:{...detail,...extra},errorEvidence:[{...extra,source:'PRIVATE'},{...detail,...extra}],diagnosticRecovery:{...recovery,...extra}}));
 const {server,url,token}=await startServer({root});
 try{
  const base=url.split('/#')[0],headers={Authorization:'Bearer '+token};
  const loaded=await(await fetch(base+'/api/runs/'+id,{headers})).json();
  const listed=await(await fetch(base+'/api/runs',{headers})).json();
  assert.deepEqual(loaded.run.errorDetails,detail);assert.deepEqual(listed.runs[0].diagnosticRecovery,recovery);
  assert.deepEqual(loaded.run.errorEvidence,[detail]);assert.deepEqual(listed.runs[0].errorEvidence,[detail]);
  assert.equal(JSON.stringify({loaded,listed}).includes('PRIVATE'),false);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
