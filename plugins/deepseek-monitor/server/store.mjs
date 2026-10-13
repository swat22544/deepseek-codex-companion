import {readdir,readFile,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
export const dataRoot=join(process.env.CODEX_HOME||join(homedir(),'.codex'),'deepseek-monitor');
const idPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export async function getRun(id,root=dataRoot){
  if(!idPattern.test(id))throw new Error('Invalid run id');
  const path=join(root,'runs',id+'.json');
  if((await stat(path)).size>5*1024*1024)throw new Error('Run exceeds size limit');
  const r=JSON.parse(await readFile(path,'utf8'));
  if(r.id!==id||r.version!==1)throw new Error('Invalid run record');
  if(!r.done&&Date.now()-Date.parse(r.updatedAt)>15000)return {...r,status:'interrupted',error:'超过 15 秒未收到更新；调用可能已中断。',done:true};
  return r;
}
export function summary(r){
  const {id,title,status,mode,taskType,startedAt,updatedAt,elapsedMs,model,policyActive,modelSelectionVerified}=r;
  return {id,title,status,mode,taskType,startedAt,updatedAt,elapsedMs,model,policyActive,modelSelectionVerified};
}
export async function listRuns(root=dataRoot){
  let names;try{names=await readdir(join(root,'runs'));}catch(e){if(e.code==='ENOENT')return [];throw e;}
  const records=await Promise.all(names.filter(n=>idPattern.test(n.slice(0,-5))&&n.endsWith('.json')).map(async n=>{try{return summary(await getRun(n.slice(0,-5),root));}catch{return null;}}));
  return records.filter(Boolean).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).slice(0,100);
}
