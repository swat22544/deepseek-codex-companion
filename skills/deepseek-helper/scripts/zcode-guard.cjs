'use strict';
// This preload validates the bytes about to leave ZCode, before the HTTP call.
// Only public answer deltas and fixed metadata enter the supervisor audit.
const fs = require('node:fs');
const ENDPOINT = 'https://api.z.ai/api/paas/v4/chat/completions';
const MODEL = 'GLM-5.3-Flash';
const REASONING_EFFORT = 'high';
const MAX_BODY = 4 * 1024 * 1024;
// SSE framing can dwarf the useful text during long reasoning turns. This is
// a cumulative traffic budget, not retained memory; individual lines and public
// text stay bounded separately, and the supervisor still enforces its deadlines.
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_LINE_CHARS = 1024 * 1024;
const STREAM_CODES = new Set(['ZCODE_STREAM_LIMIT','ZCODE_STREAM_LINE_LIMIT','ZCODE_PUBLIC_OUTPUT_LIMIT','ZCODE_STREAM_INVALID','ZCODE_STREAM_UTF8','ZCODE_STREAM_INTERRUPTED','ZCODE_STREAM_FAILURE']);

function validateWireRequest(url, init, policy) {
  const target = new URL(typeof url === 'string' || url instanceof URL ? url : url.url);
  if (target.href !== ENDPOINT || target.username || target.password) throw new Error('ZCODE_ENDPOINT_MISMATCH');
  if ((init?.method ?? 'GET').toUpperCase() !== 'POST') throw new Error('ZCODE_METHOD_MISMATCH');
  const raw = init?.body;
  if (!(typeof raw === 'string' || Buffer.isBuffer(raw) || raw instanceof Uint8Array) || Buffer.byteLength(raw) > MAX_BODY) throw new Error('ZCODE_BODY_INVALID');
  let body;
  try { body = JSON.parse(Buffer.from(raw).toString('utf8')); } catch { throw new Error('ZCODE_BODY_INVALID'); }
  if (body.model !== MODEL || body.reasoning_effort !== REASONING_EFFORT || body.thinking?.type !== 'enabled'
      || body.enable_thinking !== true || body.reasoning?.effort !== REASONING_EFFORT || body.stream !== true) throw new Error('ZCODE_MODEL_MISMATCH');
  if (typeof policy.sessionId !== 'string' || !policy.sessionId.startsWith('sess_')) throw new Error('ZCODE_SESSION_NOT_READY');
  if (!Array.isArray(body.messages) || !body.messages.length) throw new Error('ZCODE_MESSAGES_INVALID');
  const names = (body.tools ?? []).map(tool => {
    if (tool?.type !== 'function' || typeof tool.function?.name !== 'string') throw new Error('ZCODE_TOOL_MISMATCH');
    return tool.function.name;
  });
  if (new Set(names).size !== names.length || names.some(name => !policy.allowedTools.includes(name))
      || names.length !== policy.allowedTools.length) throw new Error('ZCODE_TOOL_MISMATCH');
  return {model:MODEL, reasoningEffort:REASONING_EFFORT, tools:names};
}

function createSseInspector(emit, {maxBytes=MAX_STREAM_BYTES,now=()=>performance.now()}={}) {
  let buffer='', bytes=0, publicChars=0, dataEvents=0, activityChars=0;
  let pendingChars=0, pendingText='', lastProgress=-Infinity, lastPublic=-Infinity;
  const decoder=new TextDecoder('utf-8',{fatal:true});
  function flushPublic(){if(pendingText){emit({event:'reply_stream',type:'text_delta',text:pendingText});pendingText='';lastPublic=now();}}
  function flushProgress(){if(pendingChars){emit({event:'progress',charCount:pendingChars});pendingChars=0;lastProgress=now();}}
  function flush(){flushPublic();flushProgress();}
  function decode(chunk,options){try{return decoder.decode(chunk,options);}catch{throw new Error('ZCODE_STREAM_UTF8');}}
  function line(text) {
    if(text.length>MAX_LINE_CHARS)throw new Error('ZCODE_STREAM_LINE_LIMIT');
    if (!text.startsWith('data:')) return;
    const raw=text.slice(5).trim();
    if (!raw || raw==='[DONE]') return;
    let data;
    try { data=JSON.parse(raw); } catch { throw new Error('ZCODE_STREAM_INVALID'); }
    if(!data||typeof data!=='object'||!Array.isArray(data.choices??[]))throw new Error('ZCODE_STREAM_INVALID');
    dataEvents++;
    for (const choice of data.choices ?? []) {
      if(!choice||typeof choice!=='object')throw new Error('ZCODE_STREAM_INVALID');
      const delta=choice.delta ?? {};
      if(typeof delta!=='object'||!Array.isArray(delta.tool_calls??[]))throw new Error('ZCODE_STREAM_INVALID');
      if (typeof delta.content==='string' && delta.content) {
        publicChars+=delta.content.length;
        if (publicChars>1024*1024) throw new Error('ZCODE_PUBLIC_OUTPUT_LIMIT');
        pendingText+=delta.content;
        if(pendingText.length>=4096||now()-lastPublic>=250)flushPublic();
      }
      // Private reasoning is counted, never retained in an audit event.
      const chars=[delta.content,delta.reasoning_content,delta.reasoning].filter(x=>typeof x==='string').reduce((sum,x)=>sum+x.length,0);
      const toolChars=(delta.tool_calls??[]).reduce((sum,x)=>sum+(typeof x?.function?.arguments==='string'?x.function.arguments.length:0),0);
      activityChars+=chars+toolChars;pendingChars+=chars+toolChars;
      // Coalesce metadata, never private text. Heartbeats do not flush progress.
      if(chars+toolChars>0&&now()-lastProgress>=1000)flushProgress();
      if (choice.finish_reason){flush();emit({event:'finish',reason:['stop','tool_calls','length','content_filter'].includes(choice.finish_reason)?choice.finish_reason:'other'});}
    }
  }
  return {
    push(chunk) {
      bytes+=chunk.byteLength;
      if(bytes>maxBytes)throw new Error('ZCODE_STREAM_LIMIT');
      buffer+=decode(chunk,{stream:true});
      let index;
      while((index=buffer.indexOf('\n'))>=0){line(buffer.slice(0,index).replace(/\r$/,''));buffer=buffer.slice(index+1);}
      if(buffer.length>MAX_LINE_CHARS)throw new Error('ZCODE_STREAM_LINE_LIMIT');
    },
    finish(){buffer+=decode();if(buffer.trim())line(buffer);buffer='';flush();},
    flush,
    stats:()=>({wireBytes:bytes,dataEvents,activityChars,publicChars}),
  };
}

// Observe both inspector exceptions and upstream read failures before the CLI
// can wrap them. Persist only fixed codes/counters; never the original exception.
function inspectResponseStream(body,emit,options){
  const inspector=createSseInspector(emit,options),reader=body.getReader();
  let ended=false;
  return new ReadableStream({
    async pull(controller){
      let reading=true;
      try{
        const {value,done}=await reader.read();reading=false;if(ended)return;
        if(done){inspector.finish();emit({event:'stream_end',outcome:'eof',...inspector.stats()});ended=true;reader.releaseLock();controller.close();return;}
        inspector.push(value);controller.enqueue(value);
      }catch(error){
        if(ended)return;ended=true;
        const code=reading?'ZCODE_STREAM_INTERRUPTED':STREAM_CODES.has(error?.message)?error.message:'ZCODE_STREAM_FAILURE';
        try{inspector.flush();emit({event:'stream_error',code,...inspector.stats()});}
        finally{controller.error(new Error(code));try{await reader.cancel();}catch{}finally{reader.releaseLock();}}
      }
    },
    async cancel(reason){
      if(ended)return;ended=true;
      // Consumers may cancel after receiving a valid finish marker. Record the
      // outcome without treating that alone as a provider or supervisor failure.
      try{inspector.flush();emit({event:'stream_end',outcome:'cancelled',...inspector.stats()});}
      finally{try{await reader.cancel(reason);}finally{reader.releaseLock();}}
    },
  });
}

function installGuard(policyPath) {
  const policy=JSON.parse(fs.readFileSync(policyPath,'utf8'));
  if (!policy || typeof policy.nonce!=='string' || !Array.isArray(policy.allowedTools) || typeof policy.auditPath!=='string') throw new Error('ZCODE_POLICY_INVALID');
  let seq=0, requestIndex=0;
  const emit=record=>fs.appendFileSync(policy.auditPath,JSON.stringify({nonce:policy.nonce,seq:++seq,...record})+'\n',{encoding:'utf8',mode:0o600});
  emit({event:'active',allowedTools:policy.allowedTools,provider:'zai-standard-api'});
  const original=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{
    let active;
    try{
      active=JSON.parse(fs.readFileSync(policyPath,'utf8'));
      if(active.nonce!==policy.nonce || JSON.stringify(active.allowedTools)!==JSON.stringify(policy.allowedTools))throw new Error('ZCODE_POLICY_CHANGED');
      const evidence=validateWireRequest(input,init,active);
      if(++requestIndex>active.maxModelRequests || Date.now()>active.deadline)throw new Error('ZCODE_REQUEST_BUDGET');
      emit({event:'model',provider:'zai-standard-api',...evidence,sessionId:active.sessionId,requestIndex});
    }catch(error){
      // Background telemetry and catalog fetches are refused without disclosing
      // their URLs. A request to the model endpoint that violates policy is fatal.
      let modelRequest=false;
      try{const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);modelRequest=u.pathname.includes('/chat/completions')||u.pathname.endsWith('/messages');}catch{}
      if(modelRequest)emit({event:'violation',code:/^ZCODE_[A-Z_]+$/.test(error.message)?error.message:'ZCODE_POLICY_VIOLATION'});
      throw new Error('ZCode controlled network request refused.');
    }
    const index=requestIndex;
    // Do not allow fetch's internal redirect handling to resend private task
    // data to a URL that never passed this wrapper's endpoint validation.
    const response=await original(input,{...init,redirect:'error'});
    if(!response.ok)emit({event:'http_error',sessionId:active.sessionId,requestIndex:index,httpStatus:response.status});
    if(!response.ok||!response.body)return response;
    if(!response.headers.get('content-type')?.includes('text/event-stream')){emit({event:'violation',code:'ZCODE_STREAM_TYPE'});throw new Error('ZCode expected a streamed response.');}
    const body=inspectResponseStream(response.body,record=>emit({...record,sessionId:active.sessionId,requestIndex:index}));
    return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  };
  // The verified transport uses fetch. Refuse proxy/custom-CA paths that would
  // bypass that inspection through node:http rather than silently weaken it.
  for(const name of ['node:http','node:https']){
    const transport=require(name);
    transport.request=()=>{emit({event:'violation',code:'ZCODE_UNINSPECTED_TRANSPORT'});throw new Error('ZCode uninspected HTTP transport refused.');};
    transport.get=transport.request;
  }
}

module.exports={ENDPOINT,MODEL,MAX_STREAM_BYTES,validateWireRequest,createSseInspector,inspectResponseStream,installGuard};
if(process.env.CODEX_ZCODE_POLICY)installGuard(process.env.CODEX_ZCODE_POLICY);
