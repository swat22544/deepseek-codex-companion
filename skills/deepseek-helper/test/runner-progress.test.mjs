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
