import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createMonitor} from '../scripts/live-monitor.mjs';

test('monitor heartbeat cannot reset progress; persisted timing and timeout are allowlisted',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'deepseek-timing-'));
  let monitor;
  try {
    monitor=await createMonitor({instruction:'Timing test',mode:'inspect'},{directory});
    const timing={taskSize:'large',sizeSource:'auto',totalSource:'auto',idleSource:'explicit',totalTimeoutMs:1800000,idleTimeoutMs:600000,totalElapsedMs:40000,idleElapsedMs:12000,totalRemainingMs:1760000,idleRemainingMs:588000,lastProgressKind:'model_output',privateText:'MUST_NOT_PERSIST',inputBytes:Infinity};
    monitor.timing(timing);
    await delay(850);
    const live=JSON.parse(await readFile(monitor.path,'utf8'));
    assert.equal(live.timing.idleElapsedMs,12000);
    assert.equal(live.timing.totalTimeoutMs,1800000);
    assert.equal(live.timing.privateText,undefined);
    assert.equal(live.timing.inputBytes,undefined);
    const result=await monitor.finish({ok:false,error:'No effective progress',timing,timeout:{kind:'idle',limitMs:600000,elapsedMs:600010,totalElapsedMs:900000,privateText:'MUST_NOT_PERSIST'}});
    assert.equal(result.available,true);
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
