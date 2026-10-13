import {mkdir,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {resolveCodexHome} from './runtime-paths.mjs';

// Only public answer text and allowlisted activity metadata are persisted.
export async function createMonitor(request, {directory}={}) {
  const dir=directory??join(resolveCodexHome(),'deepseek-monitor','runs');
  const id=randomUUID(),start=Date.now(),path=join(dir,id+'.json');
  const title=String(request?.title??request?.instruction??'DeepSeek task').split(/[\n。]/,1)[0].replace(/\s+/g,' ').slice(0,100);
  const state={version:1,id,title,taskType:request?.taskType,mode:request?.mode??'text',status:'preparing',startedAt:new Date(start).toISOString(),updatedAt:new Date(start).toISOString(),elapsedMs:0,model:{model:'deepseek-flash',reasoningEffort:'max'},policyActive:false,modelSelectionVerified:false,reply:'',draft:'',events:[],artifacts:[],error:null,done:false};
  let disabled=false,dirty=true,seq=0,attempt=null,blocks=new Map(),chain=Promise.resolve(),timer,finalSeen=false;
  const cap=1024*1024;
  function activity(kind,label,fields={}) {state.events.push({seq:++seq,at:new Date().toISOString(),kind,label,...fields});if(state.events.length>400)state.events.shift();dirty=true;}
  function flush() {
    if(disabled||!dirty)return chain;dirty=false;state.updatedAt=new Date().toISOString();state.elapsedMs=Date.now()-start;
    const content=JSON.stringify(state),temp=path+'.tmp';
    chain=chain.then(async()=>{await writeFile(temp,content);await rename(temp,path);}).catch(()=>{disabled=true;clearInterval(timer);});return chain;
  }
  try {await mkdir(dir,{recursive:true});}catch{disabled=true;}
  activity('start','任务已分派');await flush();
  timer=setInterval(()=>{dirty=true;void flush();},750);timer.unref();
  return {
    id,path,
    activity,
    harness(event){
      if(event.type==='session'){state.status='running';activity('session','DeepSeek 已启动');}
      if(event.type==='status'&&event.phase==='step_start')activity('step','开始处理步骤',{step:event.step});
      if(event.type==='tool_call')activity('tool','调用工具',{tool:event.tool,status:'running'});
      if(event.type==='tool_result')activity('tool-result','工具返回',{status:event.status});
      // stdout committed text is intentionally ignored: the two pipes can arrive in either order.
      if(event.type==='final'&&typeof event.text==='string'){finalSeen=true;state.reply=event.text.slice(0,cap);state.draft='';dirty=true;}
    },
    control(data){
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
    async finish(result){
      clearInterval(timer);state.done=true;state.status=result.ok?'completed':'failed';state.error=result.error??null;
      state.policyActive=!!result.policyActive;state.modelSelectionVerified=!!result.modelSelectionVerified;
      if(typeof result.final?.text==='string')state.reply=result.final.text.slice(0,cap);
      state.draft='';state.artifacts=(result.artifacts??[]).map(({name,bytes,sha256})=>({name,bytes,sha256}));
      activity('finish',result.ok?'回复完成，待主代理复核':'调用未完成');dirty=true;await flush();
      return {runId:id,path,available:!disabled};
    }
  };
}
