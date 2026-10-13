import {readdir,readFile,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
export const dataRoot=join(process.env.CODEX_HOME||join(homedir(),'.codex'),'deepseek-monitor');
const idPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const safeBackend=value=>value==='opencode'?'opencode':'harness';
export async function getRun(id,root=dataRoot){
  if(!idPattern.test(id))throw new Error('Invalid run id');
  const path=join(root,'runs',id+'.json');
  if((await stat(path)).size>5*1024*1024)throw new Error('Run exceeds size limit');
  const r=JSON.parse(await readFile(path,'utf8'));
  if(r.id!==id||r.version!==1)throw new Error('Invalid run record');
  // Legacy records came from Harness; do not expose arbitrary backend metadata.
  r.backend=safeBackend(r.backend);
  if(!r.done&&Date.now()-Date.parse(r.updatedAt)>15000)return {...r,status:'interrupted',observationStale:true,error:'超过 15 秒未收到监看记录更新；这不等于模型失败。请由主代理检查本次结果文件和进程状态。'};
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
export function summary(r){
  const {id,title,status,mode,taskType,startedAt,updatedAt,elapsedMs,model,policyActive,modelSelectionVerified}=r;
  const result={id,title,backend:safeBackend(r.backend),status,mode,taskType,startedAt,updatedAt,elapsedMs,model,policyActive,modelSelectionVerified};
  const timing=safeTiming(r.timing),timeout=safeTimeout(r.timeout);
  if(timing!==undefined)result.timing=timing;
  if(timeout!==undefined)result.timeout=timeout;
  if(r.observationStale===true)result.observationStale=true;
  return result;
}
export async function listRuns(root=dataRoot){
  let names;try{names=await readdir(join(root,'runs'));}catch(e){if(e.code==='ENOENT')return [];throw e;}
  const records=await Promise.all(names.filter(n=>idPattern.test(n.slice(0,-5))&&n.endsWith('.json')).map(async n=>{try{return summary(await getRun(n.slice(0,-5),root));}catch{return null;}}));
  return records.filter(Boolean).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).slice(0,100);
}
