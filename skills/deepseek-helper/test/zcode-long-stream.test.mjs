import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createZCodeClient} from '../scripts/zcode-runner.mjs';
import {classifyError,classifyStreamError} from '../scripts/backend-errors.mjs';
const require=createRequire(import.meta.url);
const {MAX_STREAM_BYTES,createSseInspector,inspectResponseStream}=require('../scripts/zcode-guard.cjs');
const frame=delta=>Buffer.from('data: '+JSON.stringify({id:'synthetic-response-fixture',object:'chat.completion.chunk',created:1792310400,model:'GLM-5.3-Flash',choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
const finish=Buffer.from('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');

test('long fragmented response exceeds the old 8 MiB ceiling without exhausting the new bounded budget',()=>{
 let time=0;const output=[],chunk=frame({reasoning_content:'x'}),inspector=createSseInspector(e=>output.push(e),{now:()=>time});
 const count=60000;
 for(let n=0;n<count;n++){time=n*20;inspector.push(chunk);}inspector.push(finish);inspector.finish();
 assert.ok(chunk.length*count>8*1024*1024);assert.ok(time>10*60*1000);
 assert.deepEqual(inspector.stats(),{wireBytes:chunk.length*count+finish.length,dataEvents:count+1,activityChars:count,publicChars:0});
 assert.equal(output.filter(e=>e.event==='progress').reduce((n,e)=>n+e.charCount,0),count);
 assert.ok(output.length<1300,'metadata is coalesced by time, not one record per token');
 assert.ok(Buffer.byteLength(JSON.stringify(output))<100000);
 assert.equal(output.at(-1).reason,'stop');
 const legacy=createSseInspector(()=>{},{maxBytes:8*1024*1024});
 assert.throws(()=>{for(let n=0;n<count;n++)legacy.push(chunk);},/ZCODE_STREAM_LIMIT/);
});

test('wire budget remains finite and complete oversized lines cannot bypass the line limit',()=>{
 assert.equal(MAX_STREAM_BYTES,64*1024*1024);
 assert.throws(()=>createSseInspector(()=>{}).push(new Uint8Array(MAX_STREAM_BYTES+1)),/ZCODE_STREAM_LIMIT/);
 for(const end of ['', '\n'])assert.throws(()=>createSseInspector(()=>{}).push(Buffer.from(':'+ 'x'.repeat(1024*1024)+end)),/ZCODE_STREAM_LINE_LIMIT/);
});

test('coalescing preserves all public characters, counts tool activity, and ignores idle heartbeats',()=>{
 let time=0;const output=[],inspector=createSseInspector(e=>output.push(e),{now:()=>time});
 for(const content of ['中','文','😀'])inspector.push(frame({content,reasoning_content:'PRIVATE_SENTINEL',tool_calls:[{function:{arguments:'{}'}}]}));
 const before=output.length;time=600000;inspector.push(Buffer.from(': keepalive\n\nevent: ping\n\n'));
 assert.equal(output.length,before,'a heartbeat neither creates nor flushes progress');
 inspector.push(finish);inspector.finish();
 assert.equal(output.filter(e=>e.event==='reply_stream').map(e=>e.text).join(''),'中文😀');
 assert.equal(output.filter(e=>e.event==='progress').reduce((n,e)=>n+e.charCount,0),4+3*('PRIVATE_SENTINEL'.length+2));
 assert.equal(JSON.stringify(output).includes('PRIVATE_SENTINEL'),false);
});

test('inspected transport forwards original bytes while auditing only public text and safe counters',async()=>{
 const chunks=[frame({reasoning_content:'PRIVATE_SENTINEL',content:'公开答复'}),finish],output=[];
 const body=new ReadableStream({start(c){for(const chunk of chunks)c.enqueue(chunk);c.close();}});
 const actual=Buffer.from(await new Response(inspectResponseStream(body,e=>output.push(e))).arrayBuffer());
 assert.deepEqual(actual,Buffer.concat(chunks));
 assert.equal(JSON.stringify(output).includes('PRIVATE_SENTINEL'),false);
 assert.equal(output.at(-1).event,'stream_end');assert.equal(output.at(-1).outcome,'eof');
 assert.equal(output.at(-1).wireBytes,actual.length);
});

test('local stream limits are recorded before the consumer receives a generic wrapped failure',async()=>{
 let cancelled=false;const output=[],chunk=frame({reasoning_content:'PRIVATE_SENTINEL'});
 const upstream=new ReadableStream({pull(c){c.enqueue(chunk);},cancel(){cancelled=true;}});
 await assert.rejects(new Response(inspectResponseStream(upstream,e=>output.push(e),{maxBytes:chunk.length*2})).text(),/ZCODE_STREAM_LIMIT/);
 assert.equal(cancelled,true);
 const failure=output.find(e=>e.event==='stream_error');
 assert.equal(failure.code,'ZCODE_STREAM_LIMIT');assert.equal(failure.wireBytes,chunk.length*3);assert.equal(failure.dataEvents,2);
 assert.deepEqual(classifyStreamError(failure.code),{type:'supervisor.output-limit',httpStatus:null,source:'guard',reason:'stream_size_limit'});
 assert.equal(JSON.stringify(output).includes('PRIVATE_SENTINEL'),false);
 assert.equal(output.filter(e=>e.event==='stream_error').length,1);
});

test('invalid UTF-8, malformed data and public output overflow retain distinct safe failures',async()=>{
 const fixtures=[
  [[Uint8Array.of(0xff)],'ZCODE_STREAM_UTF8'],
  [[Buffer.from('data: invalid\n')],'ZCODE_STREAM_INVALID'],
  [[Buffer.from('data: {"choices":{}}\n')],'ZCODE_STREAM_INVALID'],
  [[frame({content:'x'.repeat(600000)}),frame({content:'x'.repeat(600000)})],'ZCODE_PUBLIC_OUTPUT_LIMIT'],
 ];
 for(const [chunks,code] of fixtures){
  const output=[],body=new ReadableStream({start(c){for(const chunk of chunks)c.enqueue(chunk);c.close();}});
  await assert.rejects(new Response(inspectResponseStream(body,e=>output.push(e))).text(),e=>e.message===code);
  assert.equal(output.at(-1).code,code);assert.notEqual(classifyStreamError(code).reason,null);
 }
});

test('upstream interruption never persists its exception text or asserts a network cause',async()=>{
 const output=[],body=new ReadableStream({pull(){throw new Error('PRIVATE_TOKEN PRIVATE_URL ECONNRESET');}});
 await assert.rejects(new Response(inspectResponseStream(body,e=>output.push(e))).text(),e=>e.message==='ZCODE_STREAM_INTERRUPTED');
 assert.deepEqual(classifyStreamError(output.at(-1).code),{type:'unknown',source:'guard',httpStatus:null,reason:'stream_interrupted'});
 assert.equal(JSON.stringify(output).includes('PRIVATE'),false);
 assert.throws(()=>classifyStreamError('PRIVATE_CODE'),/Unknown/);
});

test('consumer cancellation after the finish marker remains a cancellation outcome, not a false failure',async()=>{
 let cancelled=false;const output=[],body=new ReadableStream({pull(c){c.enqueue(finish);},cancel(){cancelled=true;}});
 const reader=inspectResponseStream(body,e=>output.push(e)).getReader();await reader.read();await reader.cancel('PRIVATE_REASON');
 assert.equal(cancelled,true);assert.equal(output.at(-1).outcome,'cancelled');
 assert.equal(output.some(e=>e.event==='stream_error'),false);assert.equal(JSON.stringify(output).includes('PRIVATE'),false);
});

test('wrapped ZCode cause fields contribute only fixed categories without fabricated HTTP status',()=>{
 const actual=classifyError({type:'unrecognized_vendor_type',message:'Execution failed',code:'PRIVATE_CODE',detail:'PRIVATE_DETAIL',underlyingErrorMessage:'PRIVATE_TOKEN ECONNRESET',underlyingErrorDetail:'PRIVATE_URL',data:{status:401}},'session');
 assert.deepEqual(actual,{type:'unknown',httpStatus:null,source:'session',reason:'connection_reset'});
 assert.equal(JSON.stringify(actual).includes('PRIVATE'),false);
});

test('cancellation during a pending upstream read records exactly one terminal outcome',async()=>{
 const output=[];let cancelled=false;
 const body=new ReadableStream({start(c){c.enqueue(finish);},cancel(){cancelled=true;}});
 const reader=inspectResponseStream(body,e=>output.push(e)).getReader();await reader.read();
 await new Promise(resolve=>setImmediate(resolve));await reader.cancel();
 assert.equal(cancelled,true);assert.deepEqual(output.filter(e=>e.event.startsWith('stream_')).map(e=>[e.event,e.outcome]),[['stream_end','cancelled']]);
});

test('long NDJSON traffic can exceed the former 32 MiB cumulative ceiling',async()=>{
 const source=`process.stdin.once('data',d=>{const m=JSON.parse(d);const line=JSON.stringify({method:'fixture/event',params:{delta:'x'.repeat(8192)}})+'\\n';for(let n=0;n<4200;n++)process.stdout.write(line);process.stdout.write(JSON.stringify({id:m.id,result:{count:4200}})+'\\n');});`;
 let count=0;const client=createZCodeClient(process.execPath,['-e',source],{onEvent(){count++;}});
 try{assert.deepEqual(await client.rpc('test',{}),{count:4200});assert.equal(count,4200);}finally{const end=await client.close();assert.equal(end.cleanup.incomplete,false);}
});

test('NDJSON limit failures remain bounded and identify the local protocol layer',async()=>{
 const source=`process.stdin.once('data',()=>process.stdout.write(JSON.stringify({method:'fixture/event',params:{delta:'PRIVATE_SENTINEL'.repeat(100)}})+'\\n'));`;
 const client=createZCodeClient(process.execPath,['-e',source],{maxBytes:1024});
 try{await assert.rejects(client.rpc('test',{}),e=>{assert.deepEqual(e.details,{type:'supervisor.output-limit',httpStatus:null,source:'cli',reason:'protocol_size_limit'});assert.equal(e.message.includes('PRIVATE'),false);return true;});}finally{const end=await client.close();assert.equal(end.cleanup.incomplete,false);}
});
