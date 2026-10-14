import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createOpenCodeGuard,officialEndpoint,observeSSE,createStreamAudit,awaitToolRegistry} from '../scripts/opencode-guard.mjs';
import {createProgressClock} from '../scripts/timeout-policy.mjs';

async function fixture(t,{allowedTools=[],registryOptions={},list=async()=>allowedTools.map(id=>({id}))}={}) {
  const directory=await mkdtemp(join(tmpdir(),'opencode-guard-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const policyPath=join(directory,'policy.json'),auditPath=join(directory,'audit.jsonl');
  await writeFile(policyPath,JSON.stringify({nonce:'test-nonce',agent:'codex-helper',allowedTools,deadline:Date.now()+60000,auditPath}));
  const hooks=new Map(),toolHooks=new Map();
  const register=map=>async(name,callback)=>{map.set(name,callback);return {dispose:async()=>map.delete(name)};};
  const cleanup=await createOpenCodeGuard({policyPath,registryOptions}).setup({session:{hook:register(hooks)},mcp:{list:async()=>[]},tool:{hook:register(toolHooks),list}});
  return {hooks,toolHooks,cleanup,audit:async()=>JSON.parse('['+(await readFile(auditPath,'utf8')).trim().split('\n').join(',')+']')};
}
const identity={sessionID:'ses_test',agent:'codex-helper',model:{providerID:'deepseek',id:'deepseek-flash',variant:'max'},kind:'primary'};
const payload={model:'deepseek-flash',reasoning_effort:'max',thinking:{type:'enabled'},stream:true,messages:[{role:'user',content:'PRIVATE_PROMPT_FIXTURE'}]};
const request=(overrides={},url='https://api.deepseek.com/chat/completions')=>new Request(url,{method:'POST',headers:{'content-type':'application/json',authorization:'SECRET_HEADER_FIXTURE'},body:JSON.stringify({...payload,...overrides})});

test('prompt waits for every MCP tool before the executor may take its first snapshot',async t=>{
  const names=['codex_helper_helper_list_files','codex_helper_helper_read_file'];let calls=0,time=0;
  const f=await fixture(t,{allowedTools:names,list:async()=>names.slice(0,calls++).map(id=>({id})),registryOptions:{now:()=>time,sleep:async ms=>{time+=ms;}}});
  await f.hooks.get('prompt')({sessionID:identity.sessionID,prompt:{text:'PRIVATE_PROMPT_FIXTURE'}});
  assert.equal(calls,3);
  assert.deepEqual((await f.audit()).map(e=>e.event),['active']);
  assert.throws(()=>f.hooks.get('context')({...identity,sessionID:'ses_other',tools:{}}),/session/);
});

test('registry readiness fails closed at its startup limit and never counts polling as progress',async t=>{
  let time=0;
  const f=await fixture(t,{allowedTools:['codex_helper_helper_read_file'],list:async()=>[],registryOptions:{now:()=>time,sleep:async ms=>{time+=ms;},timeoutMs:100}});
  await assert.rejects(f.hooks.get('prompt')({sessionID:identity.sessionID}),/tool_registry_timeout/);
  assert.equal(time,100);
  assert.deepEqual((await f.audit()).map(e=>e.event),['active','violation']);
  await assert.rejects(f.hooks.get('http.request')({...identity,request:request()}),/already violated/);
});

test('registry readiness obeys task deadline and text mode needs no MCP service',async()=>{
  let time=0;
  const options={deadline:30,now:()=>time,sleep:async ms=>{time+=ms;}};
  await awaitToolRegistry({},new Set(),options);
  await assert.rejects(awaitToolRegistry({mcp:{list:async()=>[]},tool:{list:async()=>[]}},new Set(['codex_helper_helper_read_file']),options),/tool_registry_timeout/);
  assert.equal(time,30);
});

test('strict endpoint allowlist excludes lookalikes, credentials, query and other routes',()=>{
  for(const url of ['https://api.deepseek.com/chat/completions','https://api.deepseek.com/v1/chat/completions'])assert.equal(officialEndpoint(url),true);
  for(const url of ['http://api.deepseek.com/chat/completions','https://api.deepseek.com.evil.test/chat/completions','https://name@api.deepseek.com/chat/completions','https://api.deepseek.com/chat/completions?token=x','https://api.deepseek.com/other'])assert.equal(officialEndpoint(url),false);
});

test('every actual request is audited separately and excludes sensitive request content',async t=>{
  const f=await fixture(t);
  await f.hooks.get('context')({...identity,tools:{}});
  await f.hooks.get('model.request')({...identity,baseURL:'https://api.deepseek.com/v1'});
  await f.hooks.get('http.request')({...identity,request:request()});
  await f.hooks.get('http.request')({...identity,request:request()});
  const events=await f.audit();
  assert.deepEqual(events.map(e=>e.event),['active','model','model']);
  assert.deepEqual(events.filter(e=>e.event==='model').map(e=>e.requestIndex),[1,2]);
  assert.equal(events[1].wireVerified,true);
  assert.doesNotMatch(JSON.stringify(events),/PRIVATE_PROMPT|SECRET_HEADER|authorization|messages/);
});

test('wrong wire model or reasoning level fails before a verified model event',async t=>{
  for(const overrides of [{model:'other'},{reasoning_effort:'high'},{thinking:{type:'disabled'}},{stream:false},{tools:[{type:'function',function:{name:'execute'}}]}]) {
    const f=await fixture(t);
    await assert.rejects(f.hooks.get('http.request')({...identity,request:request(overrides)}),/policy violation/);
    const events=await f.audit();assert.equal(events.some(e=>e.event==='model'),false);assert.equal(events.at(-1).event,'violation');
  }
});

test('context excludes stock tools; execution checks session, agent and allowlist',async t=>{
  const name='codex_helper_helper_read_file',f=await fixture(t,{allowedTools:[name]});
  const tools={execute:{},bash:{},[name]:{}};
  f.hooks.get('context')({...identity,tools});assert.deepEqual(Object.keys(tools),[name]);
  f.toolHooks.get('execute.before')({...identity,tool:name});
  assert.throws(()=>f.toolHooks.get('execute.before')({...identity,tool:'execute'}),/policy violation/);
});

test('missing, incomplete and duplicate tool schemas fail before model dispatch is audited',async t=>{
  const allowedTools=['codex_helper_helper_read_file','codex_helper_helper_write_artifact'];
  const definition=name=>({type:'function',function:{name,parameters:{type:'object'}}});
  for(const tools of [undefined,[],[definition(allowedTools[0])],[definition(allowedTools[0]),definition(allowedTools[0])]]) {
    const f=await fixture(t,{allowedTools});
    await assert.rejects(f.hooks.get('http.request')({...identity,request:request({tools})}),/missing_tool_schema/);
    assert.equal((await f.audit()).some(event=>event.event==='model'),false);
  }
  const f=await fixture(t,{allowedTools});
  await f.hooks.get('http.request')({...identity,request:request({tools:[...allowedTools].reverse().map(definition)})});
  assert.deepEqual((await f.audit()).find(event=>event.event==='model').advertisedTools,[...allowedTools].reverse());
});

test('session switch, model mismatch and auxiliary requests cannot be mistaken for primary work',async t=>{
  for(const event of [{...identity,kind:'compaction'},{...identity,agent:'build'},{...identity,model:{...identity.model,variant:'high'}}]) {
    const f=await fixture(t);assert.throws(()=>f.hooks.get('model.request')({...event,baseURL:'https://api.deepseek.com'}),/policy violation/);
  }
  const f=await fixture(t);f.hooks.get('context')({...identity,tools:{}});
  assert.throws(()=>f.hooks.get('model.request')({...identity,sessionID:'ses_other',baseURL:'https://api.deepseek.com'}),/policy violation/);
});

test('title skips generation, compaction and generation are blocked',async t=>{
  const f=await fixture(t),title={};f.hooks.get('title')(title);assert.equal(typeof title.result,'string');
  assert.throws(()=>f.hooks.get('compaction')(),/policy violation/);
  const g=await fixture(t);assert.throws(()=>g.hooks.get('generate')(),/policy violation/);
});

test('stream observer preserves bytes and emits only counts for private reasoning',async t=>{
  const f=await fixture(t),req=request();await f.hooks.get('http.request')({...identity,request:req});
  const stream='data: '+JSON.stringify({choices:[{delta:{reasoning_content:'PRIVATE_REASONING_FIXTURE'}}]})+'\r\n\r\n'
    +'data: '+JSON.stringify({choices:[{delta:{content:'公开回复'}}]})+'\n\n'
    +'data: '+JSON.stringify({choices:[{delta:{tool_calls:[{arguments:'PRIVATE_TOOL_INPUT'}]}}]})+'\n\ndata: [DONE]\n\n';
  const bytes=new TextEncoder().encode(stream);
  const body=new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=3)c.enqueue(bytes.slice(i,i+3));c.close();}});
  const event={...identity,request:req,response:new Response(body,{headers:{'content-type':'text/event-stream'}})};
  f.hooks.get('http.response')(event);
  assert.deepEqual(new Uint8Array(await event.response.arrayBuffer()),bytes);
  const audit=await f.audit();assert.doesNotMatch(JSON.stringify(audit),/PRIVATE_REASONING|PRIVATE_TOOL_INPUT|PRIVATE_PROMPT|SECRET_HEADER/);
  assert.deepEqual(audit.filter(e=>e.event==='progress').map(e=>[e.deltaKind,e.charCount]),[['reasoning',25],['text',4]]);
  assert.deepEqual(audit.filter(e=>e.event==='reply_stream').map(e=>e.text),['公开回复']);
});

test('verified permitted tool argument streams produce counts and never disclose arguments',async t=>{
  const name='codex_helper_helper_write_artifact',f=await fixture(t,{allowedTools:[name]});
  const req=request({tools:[{type:'function',function:{name,parameters:{type:'object'}}}]});
  await f.hooks.get('http.request')({...identity,request:req});
  const fragments=['{"name":"candidate.mjs","content":"PRIVATE_TOOL_', 'ARGUMENT_FIXTURE"}'];
  const sse=tool_calls=>'data: '+JSON.stringify({choices:[{index:0,delta:{tool_calls}}]})+'\n\n';
  const stream=sse([{index:0,id:'PRIVATE_CALL_ID',type:'function',function:{name,arguments:fragments[0]}}])
    +sse([{index:0,function:{arguments:fragments[1]}}])+'data: [DONE]\n\n';
  const bytes=new TextEncoder().encode(stream);
  const body=new ReadableStream({start(c){for(let index=0;index<bytes.length;index+=3)c.enqueue(bytes.slice(index,index+3));c.close();}});
  const event={...identity,request:req,response:new Response(body,{headers:{'content-type':'text/event-stream'}})};
  f.hooks.get('http.response')(event);
  assert.deepEqual(new Uint8Array(await event.response.arrayBuffer()),bytes);
  const audit=await f.audit(),progress=audit.filter(e=>e.event==='progress');
  assert.equal(progress.reduce((count,event)=>count+event.charCount,0),fragments.join('').length);
  assert.ok(progress.every(event=>event.deltaKind==='tool_arguments'&&event.sessionId===identity.sessionID&&event.requestIndex===1));
  assert.equal(audit.some(e=>e.event==='reply_stream'),false);
  assert.doesNotMatch(JSON.stringify(audit),/PRIVATE_CALL|PRIVATE_TOOL|ARGUMENT_FIXTURE|candidate.mjs|content|arguments":/);
});

test('argument activity requires a complete permitted tool identity and valid continuations',async()=>{
  const name='codex_helper_helper_write_artifact',events=[];
  const first=(index,id='call-'+index,tool=name,arguments_='x')=>({index,id,type:'function',function:{name:tool,arguments:arguments_}});
  const continuation=(index,arguments_='y')=>({index,function:{arguments:arguments_}});
  const frames=[
    [continuation(0)], // no permitted start; this index cannot be rebound later
    [first(0)],
    [first(1,'unknown','execute')],
    [first(2,'wrong-type',name,4)],
    [first(-1),first(128)],
    [first(3,'duplicate'),first(3,'duplicate')],
    [first(4,'valid')],
    [continuation(4)],
    [first(5,'valid')], // a call ID cannot identify two indices
    [{...continuation(4),id:'other'}],
    [continuation(4)], // a changed identity poisons the index
    [first(6,'name-change')],
    [{index:6,function:{name:'execute',arguments:'PRIVATE_ARGUMENTS'}}],
    [continuation(6)],
    [first(7,'type-change')],
    [{...continuation(7),type:'other'}],
    [continuation(7)],
    [first(8,'bad-arguments')],
    [continuation(8,null)],
    [continuation(8)],
  ];
  const stream=frames.map(tool_calls=>'data: '+JSON.stringify({choices:[{index:0,delta:{tool_calls}}]})+'\n\n').join('');
  const observed=observeSSE(new Response(stream).body,(...event)=>events.push(event),{allowedTools:[name]});
  assert.equal(await new Response(observed).text(),stream);
  assert.deepEqual(events,[['tool_arguments',1],['tool_arguments',1],['tool_arguments',1],['tool_arguments',1],['tool_arguments',1]]);
});

test('tool progress cannot cross choices, completed streams, or an absent allowlist',async()=>{
  const name='codex_helper_helper_read_file';
  const start={index:0,id:'call',type:'function',function:{name,arguments:'abc'}},delta={index:0,function:{arguments:'d'}};
  const frame=(tool_calls,index=0,finish_reason)=>'data: '+JSON.stringify({choices:[{index,delta:{tool_calls},finish_reason}]})+'\n\n';
  const stream=frame([start],5)+frame([start])+frame([delta],1)+frame([delta],0,'tool_calls')
    +frame([delta])+'data: [DONE]\n\n'+frame([start]);
  const events=[],observed=observeSSE(new Response(stream).body,(...event)=>events.push(event),{allowedTools:[name]});
  assert.equal(await new Response(observed).text(),stream);
  assert.deepEqual(events,[['tool_arguments',3],['tool_arguments',1]]);
  const denied=[];await new Response(observeSSE(new Response(frame([start])).body,(...event)=>denied.push(event))).text();
  assert.deepEqual(denied,[]);
});

test('tool argument progress prevents idle expiry while preserving the fixed total deadline',async()=>{
  const name='codex_helper_helper_write_artifact',events=[];let time=0;
  const clock=createProgressClock({totalTimeoutMs:3000,idleTimeoutMs:1000},{now:()=>time});
  const audit=createStreamAudit((event,data)=>{
    events.push({event,...data});if(event==='progress')clock.markProgress('model_output');
  },{sessionId:'verified',requestIndex:1},{now:()=>time});
  const body=new ReadableStream({start(controller){
    for(let index=0;index<5;index++) {
      const call={index:0,function:{arguments:'PRIVATE_TOOL_ARGUMENT_FRAGMENT'}};
      if(index===0)Object.assign(call,{id:'call',type:'function',function:{...call.function,name}});
      controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{index:0,delta:{tool_calls:[call]}}]})+'\n\n'));
    }
    controller.close();
  }});
  await new Response(observeSSE(body,(...delta)=>{
    time+=600;audit.delta(...delta);if(time<3000)assert.equal(clock.expired(),null);
  },{allowedTools:[name],onEnd:audit.finish})).arrayBuffer();
  assert.equal(clock.expired().kind,'total');
  assert.equal(clock.snapshot().totalElapsedMs,3000);
  assert.equal(clock.snapshot().idleElapsedMs,600);
  assert.equal(clock.snapshot().lastProgressKind,'model_output');
  assert.equal(events.filter(event=>event.event==='progress').length,5);
  assert.doesNotMatch(JSON.stringify(events),/PRIVATE_TOOL|FRAGMENT/);
});

test('non-success HTTP responses audit only status and the exact verified request identity',async t=>{
  const f=await fixture(t);
  for(const status of [401,429,503]) {
    const req=request();await f.hooks.get('http.request')({...identity,request:req});
    const response=new Response('PRIVATE_PROVIDER_BODY',{status,headers:{authorization:'PRIVATE_HEADER','x-request-id':'PRIVATE_ID'}});
    const event={...identity,request:req,response};f.hooks.get('http.response')(event);
    assert.equal(event.response,response);assert.equal(await response.text(),'PRIVATE_PROVIDER_BODY');
  }
  const audit=await f.audit(),errors=audit.filter(e=>e.event==='http_error');
  assert.deepEqual(errors.map(e=>[e.sessionId,e.requestIndex,e.httpStatus]),[['ses_test',1,401],['ses_test',2,429],['ses_test',3,503]]);
  assert.doesNotMatch(JSON.stringify(audit),/PRIVATE|authorization|headers|response|body/);
});

test('oversized and malformed SSE lines are skipped without altering transport',async()=>{
  const content='data: '+ 'x'.repeat(1000)+'\n\ndata: invalid\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n';
  const events=[];const response=new Response(content);const observed=observeSSE(response.body,(...a)=>events.push(a),{maxLine:100});
  assert.equal(await new Response(observed).text(),content);assert.deepEqual(events,[['text',2,'ok']]);
});

test('tiny streaming frames have bounded audit growth without losing public text or progress counts',()=>{
  const events=[];let time=0;
  const audit=createStreamAudit((event,data)=>events.push({event,...data}),{requestIndex:1},{now:()=>time});
  for(let i=0;i<10000;i++){time=i;audit.delta('reasoning',1);audit.delta('text',1,'x');audit.delta('tool_arguments',1,'PRIVATE_TOOL_INPUT');}
  audit.finish();
  assert.ok(events.length<90);
  for(const kind of ['reasoning','text','tool_arguments'])assert.equal(events.filter(e=>e.event==='progress'&&e.deltaKind===kind).reduce((sum,e)=>sum+e.charCount,0),10000);
  assert.equal(events.filter(e=>e.event==='reply_stream').map(e=>e.text).join(''),'x'.repeat(10000));
  assert.doesNotMatch(JSON.stringify(events),/PRIVATE_TOOL_INPUT/);
});

test('invalid audit activity cannot generate progress or public reply records',()=>{
  const events=[],audit=createStreamAudit((event,data)=>events.push({event,...data}),{});
  for(const [kind,count] of [['other',1],['text',0],['text',-1],['reasoning',NaN],['tool_arguments',1.5],['tool_arguments',Infinity]])audit.delta(kind,count,'PRIVATE');
  audit.finish();assert.deepEqual(events,[]);
});
