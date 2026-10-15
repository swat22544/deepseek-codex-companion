import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMonitor} from '../scripts/live-monitor.mjs';

test('monitor heartbeat cannot reset progress; persisted timing and timeout are allowlisted',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'deepseek-timing-'));
  let monitor,heartbeatTick;
  try {
    monitor=await createMonitor({instruction:'Timing test',mode:'inspect'},{directory,heartbeat:{
      setInterval(callback,ms){assert.equal(ms,750);heartbeatTick=callback;return {unref(){}};},
      clearInterval(){heartbeatTick=null;}
    }});
    const timing={taskSize:'large',sizeSource:'auto',totalSource:'auto',idleSource:'explicit',totalTimeoutMs:1800000,idleTimeoutMs:600000,totalElapsedMs:40000,idleElapsedMs:12000,totalRemainingMs:1760000,idleRemainingMs:588000,lastProgressKind:'model_output',privateText:'MUST_NOT_PERSIST',inputBytes:Infinity};
    monitor.timing(timing);
    // A scheduled heartbeat starts an asynchronous filesystem flush. Await that
    // flush explicitly instead of assuming it finishes 100 ms after its timer.
    // Keep real disk I/O so this still checks the persisted timing projection.
    await heartbeatTick();
    await heartbeatTick();
    await heartbeatTick();
    const live=JSON.parse(await readFile(monitor.path,'utf8'));
    assert.equal(live.timing.idleElapsedMs,12000);
    assert.equal(live.timing.totalTimeoutMs,1800000);
    assert.equal(live.timing.privateText,undefined);
    assert.equal(live.timing.inputBytes,undefined);
    const result=await monitor.finish({ok:false,error:'No effective progress',timing,timeout:{kind:'idle',limitMs:600000,elapsedMs:600010,totalElapsedMs:900000,privateText:'MUST_NOT_PERSIST'}});
    assert.equal(result.available,true);
    assert.equal(heartbeatTick,null);
    const final=JSON.parse(await readFile(monitor.path,'utf8'));
    assert.equal(final.timeout.kind,'idle');
    assert.equal(final.timeout.privateText,undefined);
    assert.equal(final.events.filter(e=>e.kind==='budget').length,1);
    assert.equal(final.events.at(-1).label,'已达到无进展时限');
    assert.equal(JSON.stringify(final).includes('MUST_NOT_PERSIST'),false);
  } finally {
    if(monitor)await monitor.finish({ok:false});
    await rm(directory,{recursive:true,force:true});
  }
});
