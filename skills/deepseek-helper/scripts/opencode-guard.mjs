import {readFileSync,appendFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';

export const OPENCODE_MODEL=Object.freeze({provider:'deepseek',model:'deepseek-flash',reasoningEffort:'max'});
const tools=new Set(['helper_list_files','helper_read_file','helper_search_text','helper_write_artifact'].map(name=>'codex_helper_'+name));
const identity=value=>typeof value==='string'&&value.length>0&&value.length<=256;

export function officialEndpoint(value,{base=false}={}) {
  try {
    const url=new URL(value);
    return url.protocol==='https:'&&url.hostname==='api.deepseek.com'&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash
      &&(base?['/','/v1','/v1/'].includes(url.pathname):['/chat/completions','/v1/chat/completions'].includes(url.pathname));
  } catch {return false;}
}

// Observe only allowlisted SSE fields. The original bytes are always forwarded;
// provider reasoning, tool input, messages and headers never enter the audit.
export function observeSSE(body,onDelta,{maxLine=262144,onEnd=()=>{}}={}) {
  const decoder=new TextDecoder();let pending='',discard=false;
  const consume=line=>{
    if(!line.startsWith('data:'))return;
    let frame;try{frame=JSON.parse(line.slice(5).trim());}catch{return;}
    if(!Array.isArray(frame?.choices))return;
    for(const choice of frame.choices.slice(0,4)) {
      const delta=choice?.delta;if(!delta||typeof delta!=='object')continue;
      for(const [key,kind] of [['content','text'],['reasoning_content','reasoning']]) {
        if(typeof delta[key]==='string'&&delta[key].length)onDelta(kind,delta[key].length,kind==='text'?delta[key]:undefined);
      }
    }
  };
  const inspect=text=>{
    // Bound incomplete or maliciously huge SSE lines without retaining them.
    for(const piece of text.split(/(?<=\n)/)) {
      const ended=piece.endsWith('\n');
      if(!discard) {
        if(pending.length+piece.length>maxLine){pending='';discard=true;}
        else pending+=piece;
      }
      if(ended){if(!discard)consume(pending.trimEnd());pending='';discard=false;}
    }
  };
  return body.pipeThrough(new TransformStream({
    transform(chunk,controller){inspect(decoder.decode(chunk,{stream:true}));controller.enqueue(chunk);},
    flush(){inspect(decoder.decode());if(pending&&!discard)consume(pending);pending='';onEnd();},
  }));
}

export function createStreamAudit(emit,identity,{now=Date.now,intervalMs=500}={}) {
  const counts={text:0,reasoning:0},last={text:-Infinity,reasoning:-Infinity};let publicText='';
  const flush=kind=>{
    if(!counts[kind])return;
    emit('progress',{...identity,deltaKind:kind,charCount:counts[kind]});counts[kind]=0;last[kind]=now();
    if(kind==='text'&&publicText){emit('reply_stream',{...identity,type:'text_delta',text:publicText});publicText='';}
  };
  return {
    delta(kind,count,text){
      counts[kind]+=count;if(kind==='text')publicText+=text;
      // Chunk-level reasoning can produce many tiny frames. Keep at most two
      // normal progress records/second/kind and bounded public-text batching.
      if(now()-last[kind]>=intervalMs||publicText.length>=4096)flush(kind);
    },
    finish(){flush('reasoning');flush('text');},
  };
}

// OpenCode's first MCP catalog read can precede async server discovery. Wait
// before prompt admission, while a later context snapshot can still see tools.
// Waiting in the context hook itself is too late: new definitions are discarded
// unless they were present in the executor's original permission snapshot.
export async function awaitToolRegistry(ctx,allowed,{deadline,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),timeoutMs=10000}={}) {
  if(!allowed.size)return;
  const end=Math.min(deadline,now()+timeoutMs);
  await ctx.mcp.list();
  while(now()<end) {
    const registered=new Set((await ctx.tool.list()).map(tool=>tool.id));
    if([...allowed].every(name=>registered.has(name)))return;
    await sleep(Math.min(50,Math.max(0,end-now())));
  }
  throw new Error('tool_registry_timeout');
}

export function createOpenCodeGuard({policyPath=process.env.CODEX_OPENCODE_POLICY,auditPath,registryOptions={}}={}) {
  return {id:'codex-deepseek-guard',async setup(ctx) {
    if(!policyPath||!isAbsolute(policyPath))throw new Error('OpenCode guard policy path is missing.');
    const policy=JSON.parse(readFileSync(policyPath,'utf8'));
    const output=auditPath??policy.auditPath;
    if(!output||!isAbsolute(output)||!identity(policy.nonce)||!identity(policy.agent)
      ||!Array.isArray(policy.allowedTools)||policy.allowedTools.some(name=>!tools.has(name))
      ||new Set(policy.allowedTools).size!==policy.allowedTools.length
      ||!Number.isSafeInteger(policy.deadline)||policy.deadline<=Date.now())throw new Error('Invalid OpenCode guard policy.');
    let seq=0,requestIndex=0,sessionId=policy.sessionID??null,violated=false;
    const allowed=new Set(policy.allowedTools),requests=new WeakMap(),registrations=[];
    const emit=(event,fields={})=>appendFileSync(output,JSON.stringify({nonce:policy.nonce,event,seq:++seq,...fields})+'\n',{encoding:'utf8'});
    const reject=(code,fields={})=>{violated=true;emit('violation',{code,...fields});throw new Error('OpenCode supervisor policy violation: '+code);};
    const scope=(event,{kind=true}={})=>{
      if(violated)throw new Error('OpenCode supervisor policy already violated.');
      if(Date.now()>policy.deadline)reject('deadline');
      if(!identity(event.sessionID)||event.agent!==policy.agent)reject('identity');
      if(sessionId===null)sessionId=event.sessionID;
      if(event.sessionID!==sessionId)reject('session');
      if(event.model?.providerID!=='deepseek'||event.model?.id!=='deepseek-flash'||event.model?.variant!=='max')reject('model');
      if(kind&&event.kind!=='primary')reject('request_kind');
    };
    const hook=async(name,callback)=>registrations.push(await ctx.session.hook(name,callback));
    await hook('prompt',async event=>{
      if(violated)throw new Error('OpenCode supervisor policy already violated.');
      if(Date.now()>policy.deadline)reject('deadline');
      if(!identity(event.sessionID))reject('identity');
      if(sessionId===null)sessionId=event.sessionID;
      if(event.sessionID!==sessionId)reject('session');
      try {await awaitToolRegistry(ctx,allowed,{...registryOptions,deadline:policy.deadline});}
      catch {reject('tool_registry_timeout');}
    });
    await hook('context',event=>{
      scope(event,{kind:false});
      // Remove all stock tools, including code-mode execute. Runtime guard below
      // independently rejects tools introduced or renamed after this hook.
      for(const name of Object.keys(event.tools??{}))if(!allowed.has(name))delete event.tools[name];
    });
    await hook('title',event=>{event.result='Codex delegated DeepSeek task';});
    await hook('compaction',()=>reject('compaction'));
    await hook('generate',()=>reject('generate'));
    await hook('experimental.ws.handshake',()=>reject('websocket'));
    await hook('model.request',event=>{scope(event);if(!officialEndpoint(event.baseURL,{base:true}))reject('endpoint');});
    await hook('http.request',async event=>{
      scope(event);
      if(event.request?.method!=='POST'||!officialEndpoint(event.request?.url))reject('http_endpoint');
      let payload;
      try {
        const text=await event.request.clone().text();
        if(text.length>4*1024*1024)reject('request_size');
        payload=JSON.parse(text);
      } catch {reject('request_body');}
      if(payload?.model!=='deepseek-flash'||payload?.reasoning_effort!=='max'||payload?.thinking?.type!=='enabled'||payload?.stream!==true)reject('wire_model');
      if(payload.tools!==undefined&&(!Array.isArray(payload.tools)||payload.tools.some(t=>t?.type!=='function'||!allowed.has(t.function?.name))))reject('wire_tools');
      const advertisedTools=(payload.tools??[]).map(tool=>tool.function.name);
      if(advertisedTools.length!==allowed.size||new Set(advertisedTools).size!==advertisedTools.length)reject('missing_tool_schema',{
        presentAllowedTools:[...new Set(advertisedTools.filter(name=>allowed.has(name)))],
        missingTools:[...allowed].filter(name=>!advertisedTools.includes(name)),
      });
      const index=++requestIndex;requests.set(event.request,index);
      emit('model',{...OPENCODE_MODEL,sessionId,requestIndex:index,agent:policy.agent,kind:'primary',endpoint:'https://api.deepseek.com',wireVerified:true,advertisedTools});
    });
    await hook('http.response',event=>{
      scope(event);const index=requests.get(event.request);
      if(!index)reject('unmatched_response');
      if(!event.response?.ok){
        const status=event.response?.status;
        if(Number.isInteger(status)&&status>=100&&status<=599)emit('http_error',{sessionId,requestIndex:index,httpStatus:status});
        return;
      }
      if(!event.response.body)return;
      if(!event.response.headers.get('content-type')?.toLowerCase().includes('text/event-stream'))reject('response_format');
      const audit=createStreamAudit(emit,{sessionId,requestIndex:index});
      const body=observeSSE(event.response.body,audit.delta,{onEnd:audit.finish});
      event.response=new Response(body,{status:event.response.status,statusText:event.response.statusText,headers:event.response.headers});
    });
    registrations.push(await ctx.tool.hook('execute.before',event=>{
      if(violated||Date.now()>policy.deadline)reject('tool_deadline');
      if(event.sessionID!==sessionId||event.agent!==policy.agent||!allowed.has(event.tool))reject('tool');
    }));
    emit('active',{version:1,agent:policy.agent,allowedTools:[...allowed]});
    return async()=>{for(const registration of registrations.reverse())await registration.dispose();};
  }};
}

export default createOpenCodeGuard();
