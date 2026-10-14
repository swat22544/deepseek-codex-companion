import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamProgressTracker } from '../scripts/progress-tracker.mjs';
import { projectStreamProgress } from '../scripts/reply-stream.mjs';
import { createProgressClock } from '../scripts/timeout-policy.mjs';
import { evaluateDeadline } from '../scripts/supervised-runner.mjs';

const start = (extra={}) => ({type:'start',sessionId:'s',attemptId:'s:1',revision:1,turn:1,step:1,...extra});
const delta = (extra={}) => ({type:'output_delta',sessionId:'s',attemptId:'s:1',revision:2,index:0,blockIndex:0,time:100,deltaKind:'text',charCount:1,...extra});
const end = (extra={}) => ({type:'end',sessionId:'s',attemptId:'s:1',revision:3,index:1,outcome:{kind:'abandoned'},...extra});
function tracker() {const accepted=[];const value=createStreamProgressTracker(kind=>accepted.push(kind));value.setSession('s');value.setTurn(1);return {value,accepted};}

test('only fresh output in the confirmed current session and attempt counts', () => {
  const {value,accepted}=tracker();
  value.accept(start());
  assert.equal(accepted.length,0);
  assert.equal(value.accept(delta()),true);
  for(const event of [delta(),delta({revision:4}),delta({revision:1,index:1}),delta({revision:4,index:1,sessionId:'other'}),delta({revision:4,index:1,attemptId:'stale'}),delta({revision:4,index:1,charCount:0}),delta({revision:4,index:1,deltaKind:'unknown'})])assert.equal(value.accept(event),false);
  assert.equal(accepted.length,1);
  assert.equal(value.accept(delta({revision:5,index:2,deltaKind:'reasoning'})),true);
  assert.equal(accepted.length,2);
});

test('end markers, abandoned attempts, retries and delayed old frames do not fake progress', () => {
  const {value,accepted}=tracker();
  value.accept(start()); value.accept(delta()); value.accept(end());
  assert.equal(value.accept(delta({revision:4,index:2})),false);
  value.accept(start({revision:4})); // an old attempt cannot restart
  assert.equal(value.accept(delta({revision:5,index:3})),false);
  value.accept(start({revision:6,attemptId:'s:2'}));
  assert.equal(value.accept(delta({revision:7,index:0,attemptId:'s:2'})),true);
  assert.equal(value.accept(delta({revision:8,index:4})),false);
  value.accept(end({revision:9,attemptId:'s:2'}));
  assert.deepEqual(accepted,['model_output','model_output']);
});

test('cross-pipe ordering is buffered until both actual session and turn are known', () => {
  const accepted=[];const value=createStreamProgressTracker(kind=>accepted.push(kind));
  value.accept(start({sessionId:'other',attemptId:'other:1'}));
  value.accept(delta({sessionId:'other',attemptId:'other:1'}));
  value.accept(start());value.accept(delta());
  assert.equal(accepted.length,0);
  value.setSession('s');assert.equal(accepted.length,0);
  value.setTurn(1);assert.deepEqual(accepted,['model_output']);
  assert.equal(value.setSession('other'),false);
  assert.equal(value.setTurn(2),false);
});

test('thousands of pre-confirmation deltas cannot evict attempt ends or strand retries', () => {
  const accepted=[],value=createStreamProgressTracker(kind=>accepted.push(kind));
  value.accept(start());
  for(let index=0;index<5000;index++)value.accept(delta({index,revision:index+2,time:index}));
  value.accept(end({revision:5002,index:5000}));
  value.accept(start({attemptId:'s:2',revision:5003}));
  value.accept(delta({attemptId:'s:2',revision:5004}));
  value.setSession('s');value.setTurn(1);
  assert.deepEqual(accepted,['model_output']); // compacted activity becomes known once
  assert.equal(value.accept(delta({attemptId:'s:2',revision:5005,index:1})),true);
  assert.equal(value.accept(delta({revision:5006,index:5001})),false);
  value.accept(end({attemptId:'s:2',revision:5007,index:2}));
  value.accept(start({attemptId:'s:3',revision:5008}));
  assert.equal(value.accept(delta({attemptId:'s:3',revision:5009})),true);
  assert.deepEqual(accepted,['model_output','model_output','model_output']);
});

test('pending compaction validates every frame without making malformed or repeated frames progress', () => {
  const accepted=[],value=createStreamProgressTracker(kind=>accepted.push(kind));
  for(let index=0;index<1000;index++)value.accept(delta({attemptId:'no-start',revision:index+1,index}));
  value.accept(start());
  for(const event of [delta({charCount:0}),delta({index:-1}),delta({blockIndex:-1}),delta({time:NaN}),
    delta({deltaKind:'tool_arguments'}),delta({sessionId:'other'}),delta({attemptId:'other'}),delta({revision:1}),
    end({outcome:{kind:'committed',eventType:'other',seq:0}}),end({outcome:{kind:'committed',eventType:'assistant/message',seq:-1}})]) {
    for(let index=0;index<300;index++)assert.equal(value.accept(event),false);
  }
  value.setTurn(1);value.setSession('s');
  assert.deepEqual(accepted,[]);
  assert.equal(value.accept(delta()),true); // malformed frames changed no lifecycle state
  assert.equal(value.accept(delta()),false);
  value.setSession('s');value.setTurn(1);
  assert.deepEqual(accepted,['model_output']); // idempotent confirmation cannot replay activity
});

test('pending session and turn candidates remain independent and retain only metadata', () => {
  const accepted=[],value=createStreamProgressTracker(kind=>accepted.push(kind));
  value.accept(start({sessionId:'other'}));value.accept(delta({sessionId:'other'}));
  value.accept(start({attemptId:'wrong-turn',turn:2}));value.accept(delta({attemptId:'wrong-turn'}));
  value.accept(start());
  const privateField={get text(){throw Error('private text read');},get arguments(){throw Error('arguments read');}};
  const malformed=delta({charCount:0});Object.defineProperties(malformed,Object.getOwnPropertyDescriptors(privateField));value.accept(malformed);
  value.setSession('s');value.setTurn(1);
  assert.deepEqual(accepted,[]);
  const output=delta();Object.defineProperties(output,Object.getOwnPropertyDescriptors(privateField));
  assert.equal(value.accept(output),true);
  assert.equal(value.accept(delta({sessionId:'other',revision:10,index:1})),false);
  assert.equal(value.accept(delta({attemptId:'wrong-turn',revision:10,index:1})),false);
  assert.deepEqual(accepted,['model_output']);
});

test('pending identity budget rejects new starts but always processes existing attempt ends', () => {
  const accepted=[],value=createStreamProgressTracker(kind=>accepted.push(kind));let revision=0;
  for(let attempt=0;attempt<256;attempt++) {
    const attemptId='attempt-'+attempt;
    value.accept(start({attemptId,revision:++revision}));
    value.accept(delta({attemptId,revision:++revision}));
    value.accept(end({attemptId,revision:++revision}));
  }
  value.accept(start({attemptId:'over-budget',revision:++revision}));
  value.accept(delta({attemptId:'over-budget',revision:++revision}));
  value.setSession('s');value.setTurn(1);
  assert.deepEqual(accepted,['model_output']);
  value.accept(start({attemptId:'attempt-0',revision:++revision}));
  assert.equal(value.accept(delta({attemptId:'attempt-0',revision:++revision})),false);
  value.accept(start({attemptId:'new-live-attempt',revision:++revision}));
  assert.equal(value.accept(delta({attemptId:'new-live-attempt',revision:++revision})),true);
});

test('authoritative identity frees pending capacity occupied by unrelated candidates', () => {
  for(const firstIdentity of ['session','turn']) {
    const accepted=[],value=createStreamProgressTracker(kind=>accepted.push(kind));
    for(let index=0;index<256;index++)value.accept(start({sessionId:firstIdentity==='session'?'other-'+index:'s',turn:firstIdentity==='turn'?index+2:1,attemptId:'unrelated-'+index}));
    if(firstIdentity==='session')value.setSession('s');else value.setTurn(1);
    value.accept(start());value.accept(delta());
    if(firstIdentity==='session')value.setTurn(1);else value.setSession('s');
    assert.deepEqual(accepted,['model_output']);
  }
});

test('output resets only idle, with an immutable total budget', () => {
  let now=0;const clock=createProgressClock({totalTimeoutMs:5000,idleTimeoutMs:2000},{now:()=>now});
  const value=createStreamProgressTracker(kind=>clock.markProgress(kind));value.setSession('s');value.setTurn(1);value.accept(start());
  now=1900;value.accept(delta());
  now=3000;assert.equal(clock.expired(),null);assert.equal(clock.snapshot().idleElapsedMs,1100);
  value.accept(delta({index:1,revision:3}));
  now=4800;value.accept(delta({index:2,revision:4}));
  now=5000;assert.equal(clock.expired().kind,'total');
  assert.equal(clock.snapshot().idleElapsedMs,200);
});

test('progress projection never exports reasoning text or reads unsupported chunk payloads', () => {
  const frame={type:'chunk',attemptId:'s:1',revision:2,index:1,time:3,chunk:{type:'reasoning-delta',index:0,text:'private-content-do-not-retain'}};
  const projected=projectStreamProgress('s',frame);
  assert.deepEqual(projected,[{type:'output_delta',sessionId:'s',attemptId:'s:1',revision:2,index:1,blockIndex:0,time:3,deltaKind:'reasoning',charCount:29}]);
  assert.ok(!JSON.stringify(projected).includes('private-content'));
  for(const type of ['tool-call-delta','block-start','block-end','usage','finish','unknown']) {
    const chunk={type,get text(){throw Error('payload read');},get argumentsDelta(){throw Error('arguments read');},get block(){throw Error('block read');}};
    assert.deepEqual(projectStreamProgress('s',{...frame,chunk}),[]);
  }
  assert.deepEqual(projectStreamProgress('s',{...frame,chunk:{type:'reasoning-delta',index:0,text:''}}),[]);
  assert.deepEqual(projectStreamProgress('s',{...frame,chunk:{type:'text-delta',index:0,text:''}}),[]);
});

test('close settlement catches total expiry after final output even before the next watchdog tick', () => {
  let now=0;
  const clock=createProgressClock({totalTimeoutMs:1200,idleTimeoutMs:1000},{now:()=>now});
  now=900;clock.markProgress('final');
  now=1000;assert.deepEqual(evaluateDeadline(clock),{failure:null,timeout:null}); // last watchdog tick
  now=1201;const closed=evaluateDeadline(clock); // close arrives before the next 1250 ms tick
  assert.equal(closed.timeout.kind,'total');assert.equal(closed.timeout.elapsedMs,1201);
  assert.equal(closed.timeout.idleElapsedMs,301);assert.match(closed.failure,/总任务时限/);
});

test('close settlement catches idle expiry after final output without attributing a connection failure', () => {
  let now=0;
  const clock=createProgressClock({totalTimeoutMs:5000,idleTimeoutMs:1000},{now:()=>now});
  now=200;clock.markProgress('final');
  now=1000;assert.deepEqual(evaluateDeadline(clock),{failure:null,timeout:null});
  now=1201;const closed=evaluateDeadline(clock);
  assert.equal(closed.timeout.kind,'idle');assert.equal(closed.timeout.elapsedMs,1001);
  assert.equal(closed.timeout.totalElapsedMs,1201);assert.match(closed.failure,/不等同于确认连接失败/);
});
