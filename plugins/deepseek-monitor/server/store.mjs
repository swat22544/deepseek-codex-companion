import {readdir,readFile,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
export const dataRoot=join(process.env.CODEX_HOME||join(homedir(),'.codex'),'deepseek-monitor');
const idPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const safeBackend=value=>value==='opencode'?'opencode':'harness';
const validTimestamp=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
export async function getRun(id,root=dataRoot){
  if(!idPattern.test(id))throw new Error('Invalid run id');
  const path=join(root,'runs',id+'.json');
  if((await stat(path)).size>5*1024*1024)throw new Error('Run exceeds size limit');
  const r=JSON.parse(await readFile(path,'utf8'));
  if(!r||typeof r!=='object'||Array.isArray(r)||r.id!==id||r.version!==1)throw new Error('Invalid run record');
  // Legacy records may omit a timestamp. Corrupt starts cannot reach sorting;
  // corrupt heartbeats must never make unfinished records indefinitely live.
  if(r.startedAt===undefined&&validTimestamp(r.updatedAt))r.startedAt=r.updatedAt;
  if(!validTimestamp(r.startedAt))throw new Error('Invalid run record timestamp');
  r.startedAt=new Date(r.startedAt).toISOString();
  const validUpdate=validTimestamp(r.updatedAt);
  r.updatedAt=validUpdate?new Date(r.updatedAt).toISOString():(r.done?r.startedAt:null);
  // Legacy records came from Harness; do not expose arbitrary backend metadata.
  r.backend=safeBackend(r.backend);
  if(Object.hasOwn(r,'error')&&typeof r.error!=='string')r.error=null;
  if(Object.hasOwn(r,'errorDetails'))r.errorDetails=safeErrorDetails(r.errorDetails);
  if(Object.hasOwn(r,'errorEvidence'))r.errorEvidence=safeErrorEvidence(r.errorEvidence);
  if(Object.hasOwn(r,'diagnosticRecovery'))r.diagnosticRecovery=safeDiagnosticRecovery(r.diagnosticRecovery);
  if(!r.done&&(!validUpdate||Date.now()-Date.parse(r.updatedAt)>15000))return {...r,status:'interrupted',observationStale:true,error:validUpdate?'超过 15 秒未收到监看记录更新；这不等于模型失败。请由主代理检查本次结果文件和进程状态。':'监看记录更新时间无效；这不等于模型失败。请由主代理检查本次结果文件和进程状态。'};
  return r;
}
// List/MCP summaries must not forward arbitrary nested data from run files.
function safeTiming(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const out={};
  for(const key of ['totalTimeoutMs','idleTimeoutMs','inputBytes','fileCount','snapshotBytes','totalElapsedMs','idleElapsedMs','totalRemainingMs','idleRemainingMs']){
    if(typeof value[key]==='number'&&Number.isFinite(value[key])&&value[key]>=0)out[key]=value[key];
  }
  if(['small','medium','large'].includes(value.taskSize))out.taskSize=value.taskSize;
  for(const key of ['sizeSource','totalSource','idleSource'])if(['auto','explicit'].includes(value[key]))out[key]=value[key];
  if(value.lastProgressKind===null||['start','model_start','model_output','tool_start','tool_completed','final'].includes(value.lastProgressKind))out.lastProgressKind=value.lastProgressKind;
  return Object.keys(out).length?out:undefined;
}
function safeTimeout(value){
  if(value===null)return null;
  if(!value||typeof value!=='object'||!['total','idle'].includes(value.kind))return undefined;
  const out={kind:value.kind};
  for(const key of ['limitMs','elapsedMs','totalElapsedMs','idleElapsedMs']){
    if(typeof value[key]==='number'&&Number.isFinite(value[key])&&value[key]>=0)out[key]=value[key];
  }
  return out;
}
const errorTypes=new Set(['unknown','aborted','permission.rejected','tool.execution','provider.rate-limit','provider.auth','provider.quota','provider.content-filter','provider.transport','provider.internal','provider.invalid-output','provider.invalid-request','provider.unsupported-operation','provider.no-route','provider.unknown','provider.timeout']);
const errorReasons=new Set(['connection_reset','connection_refused','dns_failure','tls_failure','stream_interrupted','request_timeout','rate_limited','quota_exceeded','context_length_exceeded','missing_reasoning_content','invalid_tool_call','invalid_api_key','permission_denied','cancelled','provider_unavailable']);
const recoveryStatuses=new Set(['not_needed','skipped','recovered','unavailable','failed','timed_out']);
function safeErrorDetails(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||!['cli','http','session'].includes(value.source))return null;
  return {type:errorTypes.has(value.type)?value.type:'unknown',httpStatus:Number.isInteger(value.httpStatus)&&value.httpStatus>=100&&value.httpStatus<=599?value.httpStatus:null,source:value.source,reason:errorReasons.has(value.reason)?value.reason:null};
}
function safeErrorEvidence(value){
  if(!Array.isArray(value))return [];
  const out=[];for(const item of value){const detail=safeErrorDetails(item);if(detail)out.push(detail);if(out.length===3)break;}return out;
}
function safeDiagnosticRecovery(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||!recoveryStatuses.has(value.status)||!Number.isSafeInteger(value.checkedMessages)||value.checkedMessages<0)return null;
  return {status:value.status,checkedMessages:value.checkedMessages};
}
export function summary(r){
  const {id,title,status,mode,taskType,startedAt,updatedAt,elapsedMs,model,policyActive,modelSelectionVerified}=r;
  const result={id,title,backend:safeBackend(r.backend),status,mode,taskType,startedAt,updatedAt,elapsedMs,model,policyActive,modelSelectionVerified};
  const timing=safeTiming(r.timing),timeout=safeTimeout(r.timeout);
  if(timing!==undefined)result.timing=timing;
  if(timeout!==undefined)result.timeout=timeout;
  if(Object.hasOwn(r,'errorDetails'))result.errorDetails=safeErrorDetails(r.errorDetails);
  if(Object.hasOwn(r,'errorEvidence'))result.errorEvidence=safeErrorEvidence(r.errorEvidence);
  if(Object.hasOwn(r,'diagnosticRecovery'))result.diagnosticRecovery=safeDiagnosticRecovery(r.diagnosticRecovery);
  if(r.observationStale===true)result.observationStale=true;
  return result;
}
export async function listRuns(root=dataRoot){
  let names;try{names=await readdir(join(root,'runs'));}catch(e){if(e.code==='ENOENT')return [];throw e;}
  const records=await Promise.all(names.filter(n=>idPattern.test(n.slice(0,-5))&&n.endsWith('.json')).map(async n=>{try{return summary(await getRun(n.slice(0,-5),root));}catch{return null;}}));
  return records.filter(Boolean).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).slice(0,100);
}
