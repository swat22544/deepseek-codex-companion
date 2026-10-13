import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyError,ERROR_TYPES,ERROR_REASONS,recoverErrorDiagnostic,isRecoveryEligible} from '../scripts/opencode-errors.mjs';

const model={providerID:'deepseek',id:'deepseek-flash',variant:'max'},agent='codex-helper',sessionID='ses_fixture',location='D:/scoped/task';
const session={id:sessionID,agent,model,location:{directory:location}};
const assistant={id:'msg_latest',type:'assistant',agent,model,time:{completed:1}};
const error={type:'provider.transport',status:502,message:'connection reset ECONNRESET. Bearer PRIVATE_KEY',response:{body:'PRIVATE_REQUEST_BODY'},headers:{authorization:'PRIVATE_HEADER'},reasoning:'PRIVATE_REASONING'};
const base={failed:true,eligible:true,sessionID,agent,model,location,details:classifyError({},'cli')};
const safe=value=>assert.doesNotMatch(JSON.stringify(value),/PRIVATE|Bearer|headers|response|message|reasoning/i);
const queryFor=(data,{owningSession=session}={})=>async operation=>operation==='session.get'?{data:owningSession}:{data,cursor:{}};

test('recovery requires nonce-audited activation, the same verified session and confirmed cleanup',()=>{
  const evidence={failed:true,timeout:null,auditError:null,policyActive:true,mcpActive:true,modelRequests:2,sessionID,verifiedSessionID:sessionID,cleanup:{incomplete:false},cliErrorSeen:true,exitCode:1};
  assert.equal(isRecoveryEligible(evidence),true);
  for(const patch of [{failed:false},{timeout:'idle'},{auditError:new Error('audit EOF invalid')},{policyActive:false},{mcpActive:false},{modelRequests:0},{verifiedSessionID:null},{verifiedSessionID:'ses_other'},{cleanup:{incomplete:true}},{cliErrorSeen:false,exitCode:0}])assert.equal(isRecoveryEligible({...evidence,...patch}),false);
});

test('official error types, integer HTTP status and fixed reasons survive without raw provider fields',()=>{
  for(const type of ERROR_TYPES) {
    const result=classifyError({...error,type},'cli');
    assert.deepEqual(result,{type,httpStatus:502,source:'cli',reason:'connection_reset'});safe(result);
  }
  const patterns={missing_reasoning_content:'Missing required reasoning_content',context_length_exceeded:'context_length_exceeded',invalid_api_key:'invalid_api_key',connection_reset:'ECONNRESET',connection_refused:'ECONNREFUSED',dns_failure:'ENOTFOUND',tls_failure:'CERT_HAS_EXPIRED',stream_interrupted:'The provider response ended unexpectedly.',request_timeout:'UND_ERR_CONNECT_TIMEOUT',rate_limited:'Too many requests',quota_exceeded:'Insufficient balance',invalid_tool_call:'Invalid tool call',permission_denied:'Permission denied',cancelled:'Session cancelled',provider_unavailable:'Service unavailable'};
  assert.deepEqual(Object.keys(patterns).sort(),[...ERROR_REASONS].sort());
  for(const [reason,message] of Object.entries(patterns))assert.equal(classifyError({message},'cli').reason,reason);
});

test('untrusted types and status values are not echoed or inferred from HTTP status',()=>{
  for(const status of ['401',NaN,Infinity,99,600,400.1,null])assert.equal(classifyError({type:'PRIVATE_TYPE',message:'PRIVATE_MESSAGE',status},'cli').httpStatus,null);
  assert.deepEqual(classifyError({type:'PRIVATE_TYPE',status:401,message:'PRIVATE_MESSAGE',response:{body:'PRIVATE_BODY'}},'http'),{type:'unknown',httpStatus:401,source:'http',reason:null});
  assert.throws(()=>classifyError(error,'PRIVATE_SOURCE'),/Invalid diagnostic source/);
  safe(classifyError({type:'PRIVATE_TYPE',message:'PRIVATE_MESSAGE',headers:{authorization:'PRIVATE_KEY'}},'cli'));
});

test('successful tasks and directly captured useful errors never start recovery',async()=>{
  let calls=0;const query=async()=>{calls++;throw new Error('PRIVATE_FAILURE');};
  const success=await recoverErrorDiagnostic({...base,failed:false,details:null,query});
  assert.deepEqual(success,{errorDetails:null,diagnosticRecovery:{status:'not_needed',checkedMessages:0}});
  const details=classifyError(error,'cli');
  const direct=await recoverErrorDiagnostic({...base,details,query});
  assert.equal(direct.errorDetails,details);assert.equal(direct.diagnosticRecovery.status,'not_needed');assert.equal(calls,0);
  const skipped=await recoverErrorDiagnostic({...base,eligible:false,query});assert.equal(skipped.diagnosticRecovery.status,'skipped');assert.equal(calls,0);
});

test('recovery replaces a whole diagnostic record and scopes all reads to the verified session',async()=>{
  const operations=[];
  const result=await recoverErrorDiagnostic({...base,query:async(operation,params,limitMs)=>{
    operations.push({operation,params,limitMs});
    assert.equal(params.sessionID,sessionID);assert.ok(limitMs>0&&limitMs<=5000);
    return queryFor([{...assistant,error}])(operation);
  }});
  assert.deepEqual(result.errorDetails,{type:'provider.transport',httpStatus:502,source:'session',reason:'connection_reset'});
  assert.deepEqual(result.diagnosticRecovery,{status:'recovered',checkedMessages:1});
  assert.deepEqual(operations.map(o=>o.operation),['session.get','session.message.list']);
  assert.deepEqual(operations[1].params,{sessionID,limit:20,order:'desc'});
  // No retry/HTTP record is used to fill this session error's missing fields.
  const incomplete=await recoverErrorDiagnostic({...base,query:queryFor([{...assistant,error:{type:'provider.invalid-output'},retry:{error}}])});
  assert.deepEqual(incomplete.errorDetails,{type:'provider.invalid-output',httpStatus:null,source:'session',reason:null});
  safe(result.errorDetails);safe(incomplete.errorDetails);
});

test('recovery rejects wrong ownership, foreign model, repeated IDs, oversized pages and cursor loops',async()=>{
  for(const owningSession of [{...session,id:'ses_other'},{...session,agent:'other'},{...session,model:{...model,variant:'high'}},{...session,location:{directory:'D:/other'}}]) {
    const result=await recoverErrorDiagnostic({...base,query:queryFor([{...assistant,error}],{owningSession})});
    assert.equal(result.diagnosticRecovery.status,'failed');assert.equal(result.errorDetails,base.details);
  }
  for(const data of [[{...assistant,sessionID:'ses_other',error}],[{...assistant,model:{...model,variant:'high'},error}],[{id:'same',type:'user'},{id:'same',type:'user'}],Array.from({length:21},(_,i)=>({id:String(i),type:'user'}))]) {
    const result=await recoverErrorDiagnostic({...base,query:queryFor(data)});assert.equal(result.diagnosticRecovery.status,'failed');
  }
  let page=0;
  const result=await recoverErrorDiagnostic({...base,query:async op=>op==='session.get'?{data:session}:{data:[{id:'m'+page++,type:'user'}],cursor:{next:'same-cursor'}}});
  assert.equal(result.diagnosticRecovery.status,'failed');assert.equal(result.diagnosticRecovery.checkedMessages,2);
});

test('no terminal evidence never borrows an older attempt error, including retry errors',async()=>{
  for(const latest of [{...assistant,time:{},retry:{error}},{...assistant,finish:'stop'},{...assistant,error:{type:'UNKNOWN_PRIVATE',message:'PRIVATE'}}]) {
    const result=await recoverErrorDiagnostic({...base,query:queryFor([latest,{...assistant,id:'msg_old',error}])});
    assert.deepEqual(result.diagnosticRecovery,{status:'unavailable',checkedMessages:1});assert.equal(result.errorDetails,base.details);
  }
  assert.equal((await recoverErrorDiagnostic({...base,query:queryFor([])})).diagnosticRecovery.status,'unavailable');
  const idle=await recoverErrorDiagnostic({...base,query:queryFor([{id:'msg_idle',type:'idle',outcome:'failed',error}])});
  assert.equal(idle.diagnosticRecovery.status,'recovered');
});

test('diagnostic reads are bounded by page count and unavailable stays a failure',async()=>{
  let pages=0;
  const result=await recoverErrorDiagnostic({...base,query:async op=>op==='session.get'?{data:session}:{data:Array.from({length:20},(_,i)=>({id:'m'+pages+'_'+i,type:'user'})),cursor:{next:'c'+pages++}}});
  assert.equal(pages,3);assert.deepEqual(result.diagnosticRecovery,{status:'unavailable',checkedMessages:60});
  assert.equal(result.errorDetails,base.details);assert.equal('ok' in result,false);
});

test('fallback failure and timeout reveal no raw errors and cannot mask the original record',async()=>{
  const failed=await recoverErrorDiagnostic({...base,query:async()=>{throw new Error('PRIVATE_TOKEN and PRIVATE_REQUEST');}});
  assert.deepEqual(failed,{errorDetails:base.details,diagnosticRecovery:{status:'failed',checkedMessages:0}});
  const timed=await recoverErrorDiagnostic({...base,timeoutMs:20,query:async()=>new Promise(()=>{})});
  assert.deepEqual(timed,{errorDetails:base.details,diagnosticRecovery:{status:'timed_out',checkedMessages:0}});
  const ownedTimeout=await recoverErrorDiagnostic({...base,query:async()=>{throw Object.assign(new Error('PRIVATE'),{diagnosticTimeout:true});}});
  assert.equal(ownedTimeout.diagnosticRecovery.status,'timed_out');
  assert.doesNotMatch(JSON.stringify([failed,timed,ownedTimeout]),/PRIVATE/);
});
