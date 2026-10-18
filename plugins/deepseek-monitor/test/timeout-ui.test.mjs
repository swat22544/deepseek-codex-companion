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
 for(const backend of [undefined,'harness','zcode']){
  const p=render({...base(),backend,model:{model:backend==='zcode'?'GLM-5.3-Flash':'deepseek-flash',reasoningEffort:'max'}});
  assert.equal(p.node('task-backend').textContent,backend==='zcode'?'GLM · ZCode':'DeepSeek · Harness');
  assert.equal(p.node('task-model').textContent,backend==='zcode'?'GLM-5.3-Flash · Max':'DeepSeek-V41-Flash · Max');
 }
});

test('model detail never displays arbitrary or cross-backend model and effort strings',()=>{
 for(const backend of ['harness','zcode'])for(const model of [undefined,{}, {model:'PRIVATE_MODEL',reasoningEffort:'PRIVATE_EFFORT'},{model:backend==='zcode'?'deepseek-flash':'GLM-5.3-Flash',reasoningEffort:'max'},{model:backend==='zcode'?'GLM-5.3-Flash':'deepseek-flash',reasoningEffort:'high'}]){
  const p=render({...base(),backend,model});
  assert.equal(p.node('task-model').textContent,'等待模型信息 · —');
  assert.equal(p.node('verification').textContent,'等待调用核验');
 }
});

test('backend list source distinguishes same-title tasks and can be searched',()=>{
 const p=panel();
 p.state.runs=[{...base(),id:'h'}, {...base(),id:'z',backend:'zcode'}, {...base(),id:'invalid',backend:'retired-backend'}];
 p.renderList();
 const buttons=()=>p.node('run-list').children[0].children.map(item=>item.children[0]);
 assert.equal(buttons().length,2);
 assert.match(buttons()[0].title,/Harness/);assert.match(buttons()[1].title,/ZCode/);
 assert.equal(buttons()[0].children[1].children[1].children[0].textContent,'DeepSeek');
 assert.equal(buttons()[1].children[1].children[1].children[0].textContent,'GLM');
 assert.equal(buttons()[0].children[1].children[1].children[1].textContent,'进行中');
 assert.equal(buttons()[1].children[1].children[1].children[1].textContent,'进行中');
 p.state.query='zcode';p.renderList();
 assert.equal(buttons().length,1);assert.equal(buttons()[0].dataset.runId,'z');
 p.state.query='';p.state.runs[1].backend='harness';p.renderList();
 assert.match(buttons()[1].title,/Harness/);
});

test('failure card renders allowlisted Chinese reason, type, HTTP, source and recovery',()=>{
 const p=render({...base(),status:'failed',error:'PRIVATE_RAW_PROVIDER_ERROR',errorDetails:{type:'provider.invalid-request',httpStatus:400,source:'session',reason:'missing_reasoning_content',message:'PRIVATE',headers:{Authorization:'PRIVATE'},body:'PRIVATE',url:'PRIVATE'},diagnosticRecovery:{status:'recovered',checkedMessages:3,path:'PRIVATE'}});
 const card=p.node('run-error');
 assert.equal(card.hidden,false);
 assert.match(card.textContent,/模型服务拒绝了请求参数：请求缺少必需的推理内容字段/);
 assert.match(card.textContent,/类型 provider\.invalid-request · HTTP 400 · 来源 会话记录/);
 assert.match(card.textContent,/诊断：已恢复错误详情 · 已检查 3 条消息/);
 assert.equal(card.textContent.includes('PRIVATE'),false);
});

test('unknown structured errors cannot inject strings, objects or prototype properties into UI',()=>{
 for(const type of ['PRIVATE_UNKNOWN','constructor','__proto__',{toString:'PRIVATE'},['provider.auth']]){
  const p=render({...base(),status:'failed',error:{message:'PRIVATE'},errorDetails:{type,httpStatus:'PRIVATE',source:'cli',reason:{toString:'PRIVATE'},body:'PRIVATE'},diagnosticRecovery:{status:'constructor',checkedMessages:0,message:'PRIVATE'}});
  const value=p.node('run-error').textContent;
  assert.match(value,/具体错误类型未确认/);assert.match(value,/类型 unknown.*来源 CLI/);
  for(const marker of ['PRIVATE','[object','function','诊断：','HTTP '])assert.equal(value.includes(marker),false);
 }
 const malformed=render({...base(),status:'failed',error:{message:'PRIVATE'},errorDetails:{type:'provider.auth',source:{toString:'PRIVATE'}}});
 assert.equal(malformed.node('run-error').textContent,'调用未完成，未提供可显示的错误详情。');
});

test('HTTP codes and recovery labels display validated values without inventing omitted details',()=>{
 const statuses={not_needed:'无需恢复',skipped:'未执行恢复',recovered:'已恢复错误详情',unavailable:'错误详情不可用',failed:'恢复失败',timed_out:'恢复超时'};
 for(const [status,label]of Object.entries(statuses)){
  const p=render({...base(),status:'failed',errorDetails:{type:'provider.auth',httpStatus:401,source:'http',reason:'invalid_api_key'},diagnosticRecovery:{status,checkedMessages:0}});
  assert.match(p.node('run-error').textContent,/模型服务认证失败：API 密钥无效/);
  assert.match(p.node('run-error').textContent,/HTTP 401 · 来源 HTTP 响应/);
  assert.ok(p.node('run-error').textContent.includes(`诊断：${label} · 已检查 0 条消息`));
 }
 for(const httpStatus of [null,99,600,400.2,'401',{}]){
  const p=render({...base(),status:'failed',errorDetails:{type:'unknown',source:'cli',httpStatus},diagnosticRecovery:{status:'recovered',checkedMessages:'3'}});
  assert.equal(p.node('run-error').textContent.includes('HTTP '),false);
  assert.equal(p.node('run-error').textContent.includes('诊断：'),false);
 }
});

test('legacy generic failures remain readable and completed/interrupted states are preserved',()=>{
 const message='Backend reported a runtime/provider error.';
 const legacy=render({...base(),status:'failed',error:message});
 assert.equal(legacy.node('run-error').textContent,message);
 const completed=render({...base(),status:'completed',diagnosticRecovery:{status:'not_needed',checkedMessages:0}});
 assert.equal(completed.node('run-error').hidden,true);assert.equal(completed.node('task-status').textContent,'待主代理复核');
 const interrupted=render({...base(),status:'interrupted',errorDetails:{type:'provider.auth',source:'cli',httpStatus:401}});
 assert.match(interrupted.node('run-error').textContent,/监看记录已中断.*不等于模型失败/);
 assert.equal(interrupted.node('run-error').textContent.includes('认证失败'),false);
});

test('diagnostic recovery timeout does not turn a provider error into a task timeout',()=>{
 const p=render({...base(),status:'failed',errorDetails:{type:'provider.transport',source:'session',httpStatus:null,reason:'connection_reset'},diagnosticRecovery:{status:'timed_out',checkedMessages:2}});
 assert.equal(p.node('task-status').textContent,'失败');
 assert.match(p.node('run-error').textContent,/通信失败：连接被重置/);
 assert.match(p.node('run-error').textContent,/诊断：恢复超时/);
 assert.equal(p.node('run-error').textContent.includes('总任务时限'),false);
});

test('error evidence preserves independent sources and omits the repeated primary diagnosis',()=>{
 const cli={type:'provider.transport',httpStatus:null,source:'cli',reason:'connection_reset'};
 const http={type:'unknown',httpStatus:502,source:'http',reason:null};
 const session={type:'provider.invalid-request',httpStatus:400,source:'session',reason:'missing_reasoning_content'};
 const p=render({...base(),status:'failed',errorDetails:cli,errorEvidence:[cli,http,session]});
 const value=p.node('run-error').textContent;
 assert.equal(value.match(/类型 provider\.transport/g).length,1);
 assert.match(value,/类型 provider\.transport · 来源 CLI\n补充证据（HTTP 响应）/);
 assert.match(value,/类型 unknown · HTTP 502 · 来源 HTTP 响应\n补充证据（会话记录）/);
 assert.match(value,/类型 provider\.invalid-request · HTTP 400 · 来源 会话记录/);
 assert.equal(value.includes('类型 provider.transport · HTTP'),false);
});

test('error evidence ignores malicious fields, malformed containers and extra records',()=>{
 const p=render({...base(),status:'failed',errorDetails:{type:'provider.transport',source:'cli'},errorEvidence:[null,{source:'PRIVATE'},{source:{toString:'PRIVATE'}},{source:'http',type:{toString:'PRIVATE'},httpStatus:503,reason:'PRIVATE',message:'PRIVATE',body:'PRIVATE'},{source:'session',type:'constructor',httpStatus:'401',reason:{toString:'PRIVATE'}},{source:'cli',type:'provider.quota',httpStatus:402},{source:'http',type:'provider.auth',httpStatus:401}]});
 const value=p.node('run-error').textContent;
 assert.equal(value.includes('PRIVATE'),false);assert.equal(value.includes('constructor'),false);
 assert.equal(value.includes('HTTP 401'),false);assert.equal(value.includes('provider.auth'),false);
 assert.match(value,/类型 unknown · HTTP 503 · 来源 HTTP 响应/);
 assert.equal(value.match(/补充证据/g).length,3);
 for(const errorEvidence of [null,{},'PRIVATE'])assert.equal(render({...base(),status:'failed',errorEvidence}).node('run-error').textContent,'调用未完成，未提供可显示的错误详情。');
});
