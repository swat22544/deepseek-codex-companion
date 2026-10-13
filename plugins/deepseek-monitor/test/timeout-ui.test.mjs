import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the actual panel render functions with a minimal DOM. Network polling
// is disabled; the browser smoke test covers layout and real transport separately.
const html=await readFile(new URL('../ui/panel.html',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
function panel(){
 const nodes=new Map();
 const make=()=>({textContent:'',hidden:false,dataset:{},title:'',children:[],classList:{toggle(){}},setAttribute(){},addEventListener(){},append(...nodes){this.children.push(...nodes)},replaceChildren(...nodes){this.children=nodes},querySelectorAll(){return []},focus(){}});
 const node=id=>{if(!nodes.has(id))nodes.set(id,make());return nodes.get(id)};
 const context={Date,Intl,URLSearchParams,console,location:{hash:'',protocol:'file:',hostname:''},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},requestAnimationFrame:fn=>fn(),document:{hidden:true,getElementById:node,querySelector:node,createElement:make,createElementNS:make,createDocumentFragment:make,addEventListener(){}},window:{addEventListener(){},parent:{postMessage(){}}}};
 const instrumented=script.replace('renderList(); requestRefresh();','globalThis.testPanel = {state, renderDetail, renderList, updateElapsed, updateConnection, statusLabel, runError};');
 vm.runInNewContext(instrumented,context);
 return {...context.testPanel,node};
}
function render(run){const p=panel();Object.assign(p.state,{run,selectedId:'r',connected:true,fetchedAt:Date.now(),follow:false});p.renderDetail();return p}
const base=()=>({id:'r',title:'Task',status:'running',elapsedMs:60000,updatedAt:new Date().toISOString(),events:[],artifacts:[]});

test('active task displays separate budgets and measured idle duration',()=>{
 const p=render({...base(),timing:{taskSize:'large',sizeSource:'auto',totalSource:'auto',totalTimeoutMs:1200000,idleTimeoutMs:420000,totalElapsedMs:120000,idleElapsedMs:30000,lastProgressKind:'model_output'}});
 assert.equal(p.node('task-timing').hidden,false);assert.match(p.node('task-budgets').textContent,/总预算 20 分钟.*无进展阈值 7 分钟.*大任务/);
 assert.match(p.node('task-progress').textContent,/已运行 02:00.*距上次有效进展 00:30.*总预算剩余约/);
 assert.match(p.node('task-timing').title,/模型输出活动.*心跳不会重置/);
 p.state.fetchedAt=Date.now();p.state.run.updatedAt=new Date().toISOString();p.state.run.timing.idleElapsedMs=90000;p.updateElapsed();
 assert.match(p.node('task-progress').textContent,/距上次有效进展 01:30/);
});
test('legacy records retain elapsed time without showing invented budgets',()=>{
 const p=render(base());assert.equal(p.node('task-timing').hidden,true);assert.equal(p.node('task-budgets').textContent,'');assert.equal(p.node('task-elapsed').textContent,'01:00');
});
test('invalid timing values remain hidden and never render NaN or objects',()=>{
 const p=render({...base(),timing:{totalTimeoutMs:Infinity,idleTimeoutMs:-1,totalElapsedMs:'oops',idleElapsedMs:{},taskSize:'<script>'}});
 assert.equal(p.node('task-timing').hidden,true);assert.equal(p.node('task-elapsed').textContent,'01:00');
 assert.ok(!p.node('task-progress').textContent.includes('NaN'));
 const malformed=render({...base(),timing:{totalTimeoutMs:1200000,idleTimeoutMs:420000,taskSize:'__proto__',lastProgressKind:'constructor'}});
 assert.ok(!malformed.node('task-budgets').textContent.includes('[object'));
 assert.ok(!malformed.node('task-timing').title.includes('function'));
});
test('total timeout and idle timeout present distinct causes and avoid diagnosing a network fault',()=>{
 for(const [kind,label] of [['total','总时限已到'],['idle','无进展超时']]){
  const p=render({...base(),status:'failed',timeout:{kind,limitMs:420000,elapsedMs:420001},error:'Task timed out.'});
  assert.equal(p.node('task-status').textContent,label);assert.equal(p.node('run-error').hidden,false);
  assert.match(p.node('run-error').textContent,kind==='total'?/达到总任务时限（7 分钟）/:/长时间未收到有效进展（7 分钟）.*不能据此确认网络故障或模型卡死/);
 }
});
test('completed and interrupted records do not advance time; stale observation is not model failure',()=>{
 for(const status of ['completed','interrupted']){
  const p=render({...base(),status,updatedAt:'2020-01-01T00:00:00Z',timing:{totalTimeoutMs:1200000,idleTimeoutMs:420000,totalElapsedMs:120000,idleElapsedMs:30000}});
  assert.equal(p.node('task-elapsed').textContent,'02:00');assert.match(p.node('task-progress').textContent,/距上次有效进展 00:30/);assert.ok(!p.node('task-progress').textContent.includes('剩余'));
  if(status==='interrupted'){assert.equal(p.node('task-status').textContent,'监看记录中断');assert.match(p.node('run-error').textContent,/这不等于模型失败/);}
 }
});
test('active extrapolation uses record time, stays bounded, and never independently marks timeout',()=>{
 const p=render({...base(),updatedAt:'2020-01-01T00:00:00Z',timing:{totalTimeoutMs:60000,idleTimeoutMs:20000,totalElapsedMs:60000,idleElapsedMs:18000}});
 assert.equal(p.node('task-elapsed').textContent,'01:15');assert.match(p.node('task-progress').textContent,/距上次有效进展 00:33.*剩余约 00:00/);
 assert.equal(p.node('task-status').textContent,'进行中');assert.equal(p.node('run-error').hidden,true);
});
test('connection labels refer to monitoring, not model progress',()=>{
 const p=panel();p.updateConnection(true);assert.equal(p.node('connection-label').textContent,'监看已连接');
 p.updateConnection(false,'offline');assert.equal(p.node('connection-label').textContent,'监看连接中断');assert.match(p.node('empty-description').textContent,/不能代表模型运行状态/);
});

test('backend detail uses explicit fixed labels and legacy Harness fallback',()=>{
 for(const backend of [undefined,'harness','opencode','PRIVATE <script>',{credential:'PRIVATE'},['opencode']]){
  const p=render({...base(),backend,model:{model:'deepseek-flash',reasoningEffort:'max'}});
  assert.equal(p.node('task-backend').textContent,backend==='opencode'?'OpenCode':'Harness');
  assert.equal(p.node('task-model').textContent,'DeepSeek-V41-Flash · Max');
 }
});

test('backend list source distinguishes same-title tasks and can be searched',()=>{
 const p=panel();
 p.state.runs=[{...base(),id:'h'}, {...base(),id:'o',backend:'opencode'}];
 p.renderList();
 const buttons=()=>p.node('run-list').children[0].children.map(item=>item.children[0]);
 assert.equal(buttons().length,2);
 assert.match(buttons()[0].title,/Harness/);assert.match(buttons()[1].title,/OpenCode/);
 assert.equal(buttons()[0].children[1].children[1].children[0].textContent,'Harness · 进行中');
 assert.equal(buttons()[1].children[1].children[1].children[0].textContent,'OpenCode · 进行中');
 p.state.query='opencode';p.renderList();
 assert.equal(buttons().length,1);assert.equal(buttons()[0].dataset.runId,'o');
 p.state.query='';p.state.runs[1].backend='harness';p.renderList();
 assert.match(buttons()[1].title,/Harness/);
});
