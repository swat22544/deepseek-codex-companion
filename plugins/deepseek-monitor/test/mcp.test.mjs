import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('stdio discovery, read-only tool call and MCP App resource',async()=>{
 const codexHome=await mkdtemp(join(tmpdir(),'deepseek-monitor-mcp-'));
 const child=spawn(process.execPath,[fileURLToPath(new URL('../server/mcp.mjs',import.meta.url))],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,CODEX_HOME:codexHome}});
 const pending=new Map();let seq=0,errors='';child.stderr.on('data',b=>errors+=b);
 const reader=createInterface({input:child.stdout});reader.on('line',line=>{const m=JSON.parse(line);const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);p.resolve(m);}});
 function rpc(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('MCP timeout '+errors)),4000);pending.set(id,{resolve,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
 try{
  const init=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}});assert.equal(init.result.serverInfo.name,'deepseek-monitor');
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const list=await rpc('tools/list');assert.equal(list.result.tools.length,3);assert.ok(list.result.tools.every(t=>t.annotations.readOnlyHint));
  child.stdin.write('null\n');
  const alive=await rpc('ping');assert.deepEqual(alive.result,{});
  const unknown=await rpc('resources/read',{uri:'ui://missing'});assert.equal(unknown.error.code,-32002);
  const result=await rpc('tools/call',{name:'monitor_list',arguments:{}});assert.ok(Array.isArray(result.result.structuredContent.runs));
  const resource=await rpc('resources/read',{uri:'ui://deepseek-monitor/panel.html'});assert.equal(resource.result.contents[0].mimeType,'text/html;profile=mcp-app');assert.match(resource.result.contents[0].text,/DeepSeek/);
  const bad=await rpc('tools/call',{name:'monitor_get',arguments:{runId:'../credentials'}});assert.equal(bad.result.isError,true);
 }finally{reader.close();child.stdin.end();child.kill();for(const p of pending.values())clearTimeout(p.timer);}
});
