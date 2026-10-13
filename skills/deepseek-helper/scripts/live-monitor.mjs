import {mkdir,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {resolveCodexHome} from './runtime-paths.mjs';

function safeTiming(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const out={};
  for(const key of ['totalTimeoutMs','idleTimeoutMs','inputBytes','fileCount','snapshotBytes','totalElapsedMs','idleElapsedMs','totalRemainingMs','idleRemainingMs'])
    if(typeof value[key]==='number'&&Number.isFinite(value[key])&&value[key]>=0)out[key]=value[key];
  if(['small','medium','large'].includes(value.taskSize))out.taskSize=value.taskSize;
  for(const key of ['sizeSource','totalSource','idleSource'])if(['auto','explicit'].includes(value[key]))out[key]=value[key];
  if(value.lastProgressKind===null||['start','model_start','model_output','tool_start','tool_completed','final'].includes(value.lastProgressKind))out.lastProgressKind=value.lastProgressKind;
  return Object.keys(out).length?out:null;
}
function safeTimeout(value) {
  if(!value||typeof value!=='object'||!['total','idle'].includes(value.kind))return null;
  const out={kind:value.kind};
  for(const key of ['limitMs','elapsedMs','totalElapsedMs','idleElapsedMs'])
    if(typeof value[key]==='number'&&Number.isFinite(value[key])&&value[key]>=0)out[key]=value[key];
  return out;
}

// Only public answer text and allowlisted activity metadata are persisted.
export async function createMonitor(request, {directory,io={},sleep=delay,heartbeat={setInterval,clearInterval}}={}) {
  const dir=directory??join(resolveCodexHome(),'deepseek-monitor','runs');
  const id=randomUUID(),start=Date.now(),path=join(dir,id+'.json');
  const title=String(request?.title??request?.instruction??'DeepSeek task').split(/[\n。]/,1)[0].replace(/\s+/g,' ').slice(0,100);
  const state={version:1,id,title,taskType:request?.taskType,mode:request?.mode??'text',status:'preparing',startedAt:new Date(start).toISOString(),updatedAt:new Date(start).toISOString(),elapsedMs:0,model:{model:'deepseek-flash',reasoningEffort:'max'},policyActive:false,modelSelectionVerified:false,reply:'',draft:'',events:[],artifacts:[],error:null,timing:null,timeout:null,done:false};
  const fileIO={mkdir,writeFile,rename,...io};
  const retryDelays=[40,120,300];
  const transientCodes=new Set(['EACCES','EPERM','EBUSY','EMFILE','ENFILE','EINTR','ETXTBSY','ENOENT']);
  const safeCodes=new Set([...transientCodes,'ENOSPC','EIO','EROFS','EEXIST','ENOTDIR']);
  const writeDiagnostics={errorCount:0,failedFlushCount:0,recoveryCount:0,lastErrorCode:null,lastErrorPhase:null};
  let dirty=true,seq=0,attempt=null,blocks=new Map(),timer,finalSeen=false,finished=false,finishPromise;
  let pending=null,writerPromise=null,requestedVersion=0,persistedVersion=0,outage=false;
  const cap=1024*1024;
  function activity(kind,label,fields={}) {if(finished)return;state.events.push({seq:++seq,at:new Date().toISOString(),kind,label,...fields});if(state.events.length>400)state.events.shift();dirty=true;}
  function timing(value) {
    if(finished)return;
    const next=safeTiming(value);if(!next)return;
    const first=state.timing===null;state.timing=next;dirty=true;
    if(first)activity('budget','任务时间预算已分配');
  }
  async function writeSnapshot(snapshot) {
    // Only the rename replaces the last valid record. A failed write or rename
    // leaves that record intact, and the next attempt overwrites the temp file.
    for(let retry=0;;retry++) {
      let phase='mkdir';
      const persistedDiagnostics={...writeDiagnostics,recoveryCount:writeDiagnostics.recoveryCount+(outage?1:0)};
      try {
        await fileIO.mkdir(dir,{recursive:true});
        phase='write';
        await fileIO.writeFile(path+'.tmp',JSON.stringify({...snapshot.state,monitorWrite:persistedDiagnostics}));
        phase='rename';
        await fileIO.rename(path+'.tmp',path);
        writeDiagnostics.recoveryCount=persistedDiagnostics.recoveryCount;outage=false;
        return true;
      } catch(error) {
        // Do not retain error.message, error.path, or other arbitrary properties.
        const code=safeCodes.has(error?.code)?error.code:'IO_ERROR';
        writeDiagnostics.errorCount++;writeDiagnostics.lastErrorCode=code;writeDiagnostics.lastErrorPhase=phase;outage=true;
        if(!transientCodes.has(code)||retry>=retryDelays.length) {
          writeDiagnostics.failedFlushCount++;return false;
        }
        await sleep(retryDelays[retry]);
      }
    }
  }
  function flush() {
    if(!dirty)return writerPromise??Promise.resolve();
    dirty=false;state.updatedAt=new Date().toISOString();state.elapsedMs=Date.now()-start;
    // One active immutable snapshot and at most one pending latest snapshot:
    // slow storage must not grow an unbounded promise queue of old records.
    pending={version:++requestedVersion,state:structuredClone(state)};
    if(!writerPromise)writerPromise=(async()=>{
      try {
        while(pending) {
          const snapshot=pending;pending=null;
          if(await writeSnapshot(snapshot))persistedVersion=snapshot.version;
          else dirty=true; // A later heartbeat may recover; never disable monitoring.
        }
      } finally {writerPromise=null;}
    })();
    return writerPromise;
  }
  activity('start','任务已分派');await flush();
  timer=heartbeat.setInterval(()=>{if(finished)return;dirty=true;return flush();},750);timer.unref?.();
  return {
    id,path,
    activity,timing,
    harness(event){
      if(finished)return;
      if(event.type==='session'){state.status='running';activity('session','DeepSeek 已启动');}
      if(event.type==='status'&&event.phase==='step_start')activity('step','开始处理步骤',{step:event.step});
      if(event.type==='tool_call')activity('tool','调用工具',{tool:event.tool,status:'running'});
      if(event.type==='tool_result')activity('tool-result','工具返回',{status:event.status});
      // stdout committed text is intentionally ignored: the two pipes can arrive in either order.
      if(event.type==='final'&&typeof event.text==='string'){finalSeen=true;state.reply=event.text.slice(0,cap);state.draft='';dirty=true;}
    },
    control(data){
      if(finished)return;
      if(data.event==='active'){state.policyActive=true;activity('policy','调用权限已确认');}
      if(data.event==='model'){state.modelSelectionVerified=true;activity('model','Flash / Max 已确认');}
      if(data.event==='reply_stream'&&!finalSeen){
        if(data.type==='start'){attempt=data.attemptId;blocks=new Map();state.draft='';activity('response','正在生成回复');}
        if(data.type==='text_delta'&&data.attemptId===attempt&&typeof data.text==='string'){
          const index=Number.isInteger(data.blockIndex)?data.blockIndex:0;blocks.set(index,((blocks.get(index)??'')+data.text).slice(0,cap));
          state.draft=[...blocks].sort((a,b)=>a[0]-b[0]).map(x=>x[1]).join('\n').slice(0,cap);dirty=true;
        }
        if(data.type==='end'&&data.attemptId===attempt){
          if(data.outcome?.kind==='committed'&&data.outcome?.eventType==='assistant/message')state.reply=(state.reply+(state.reply&&state.draft?'\n\n':'')+state.draft).slice(0,cap);
          else activity('retry','本次草稿未提交，等待后续回复');
          state.draft='';attempt=null;blocks.clear();dirty=true;
        }
      }
    },
    finish(result){
      if(finishPromise)return finishPromise;
      heartbeat.clearInterval(timer);state.done=true;state.status=result.ok?'completed':'failed';state.error=result.error??null;
      timing(result.timing);state.timeout=safeTimeout(result.timeout);
      state.policyActive=!!result.policyActive;state.modelSelectionVerified=!!result.modelSelectionVerified;
      if(typeof result.final?.text==='string')state.reply=result.final.text.slice(0,cap);
      state.draft='';state.artifacts=(result.artifacts??[]).map(({name,bytes,sha256})=>({name,bytes,sha256}));
      activity('finish',result.ok?'回复完成，待主代理复核':state.timeout?.kind==='total'?'已达到总任务时限':state.timeout?.kind==='idle'?'已达到无进展时限':'调用未完成');finished=true;dirty=true;
      finishPromise=(async()=>{
        await flush();
        return {runId:id,path,available:persistedVersion===requestedVersion,writeDiagnostics:{...writeDiagnostics}};
      })();
      return finishPromise;
    }
  };
}
