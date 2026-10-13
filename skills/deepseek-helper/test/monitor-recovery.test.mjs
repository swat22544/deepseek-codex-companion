import test from 'node:test';
import assert from 'node:assert/strict';
import {createMonitor} from '../scripts/live-monitor.mjs';

function deferred() {
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}
function fixture() {
  const files=new Map(),sleeps=[],calls={mkdir:0,write:0,rename:0};
  let callback=null,fail=null,writeGate=null,activeWrites=0,maxActiveWrites=0;
  const recordError=()=>Object.assign(new Error('PRIVATE_ERROR_PATH_OR_TOKEN'),{code:fail,path:'PRIVATE_ERROR_PATH_OR_TOKEN'});
  const options={
    directory:'monitor-fixture',
    io:{
      async mkdir(){calls.mkdir++;},
      async writeFile(path,content){
        calls.write++;activeWrites++;maxActiveWrites=Math.max(maxActiveWrites,activeWrites);
        try {if(writeGate)await writeGate.promise;files.set(path,content);}finally{activeWrites--;}
      },
      async rename(from,to){calls.rename++;if(fail)throw recordError();files.set(to,files.get(from));files.delete(from);}
    },
    async sleep(ms){sleeps.push(ms);},
    heartbeat:{
      setInterval(fn){callback=fn;return {unref(){}};},
      clearInterval(){callback=null;}
    }
  };
  return {
    options,files,sleeps,calls,
    setFailure(code){fail=code;},
    blockWrites(){writeGate=deferred();return writeGate;},
    get maxActiveWrites(){return maxActiveWrites;},
    get heartbeatActive(){return callback!==null;},
    tick(){return callback?.();},
    read(monitor){return JSON.parse(files.get(monitor.path));}
  };
}

test('a transient rename error retries atomically and persists safe recovery diagnostics',async()=>{
  const f=fixture();
  const rename=f.options.io.rename;
  let first=true;
  f.options.io.rename=async(...args)=>{
    if(first){first=false;throw Object.assign(new Error('PRIVATE_ERROR_PATH_OR_TOKEN'),{code:'EPERM'});}
    return rename(...args);
  };
  const monitor=await createMonitor({instruction:'Transient rename' },f.options);
  const record=f.read(monitor);
  assert.deepEqual(f.sleeps,[40]);
  assert.deepEqual(record.monitorWrite,{errorCount:1,failedFlushCount:0,recoveryCount:1,lastErrorCode:'EPERM',lastErrorPhase:'rename'});
  assert.equal(JSON.stringify(record).includes('PRIVATE_ERROR_PATH_OR_TOKEN'),false);
  assert.equal((await monitor.finish({ok:true,final:{text:'Finished'}})).available,true);
});

test('a sustained failure preserves the previous record, bounds retries, and reports final persistence failure',async()=>{
  const f=fixture(),monitor=await createMonitor({instruction:'Persistent failure'},f.options);
  const previous=f.files.get(monitor.path);
  f.setFailure('EACCES');
  monitor.activity('step','Never persisted');
  await f.tick();
  assert.equal(f.files.get(monitor.path),previous);
  assert.equal(f.calls.rename,5); // Initial success plus four bounded attempts.
  assert.equal(f.heartbeatActive,true);
  const result=await monitor.finish({ok:true,final:{text:'Final not persisted'}});
  assert.equal(result.available,false);
  assert.equal(result.writeDiagnostics.failedFlushCount,2);
  assert.equal(result.writeDiagnostics.errorCount,8);
  assert.equal(f.calls.rename,9);
  assert.equal(f.files.get(monitor.path),previous);
  assert.equal(f.heartbeatActive,false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_ERROR_PATH_OR_TOKEN'),false);
});

test('later heartbeats recover after exhausted retries without resetting task progress',async()=>{
  const f=fixture(),monitor=await createMonitor({instruction:'Heartbeat recovery'},f.options);
  monitor.timing({totalElapsedMs:12000,idleElapsedMs:9000,lastProgressKind:'model_start'});
  f.setFailure('EBUSY');await f.tick();
  f.setFailure(null);await f.tick();
  const recovered=f.read(monitor);
  assert.equal(recovered.monitorWrite.failedFlushCount,1);
  assert.equal(recovered.monitorWrite.recoveryCount,1);
  assert.equal(recovered.timing.idleElapsedMs,9000);
  assert.equal(recovered.done,false);
  assert.equal((await monitor.finish({ok:true})).available,true);
});

test('an incomplete temp write cannot replace the valid record and a later final write repairs it',async()=>{
  const f=fixture(),writeFile=f.options.io.writeFile;
  let failWrite=false;
  f.options.io.writeFile=async(path,content)=>{
    if(failWrite){
      f.files.set(path,'{"incomplete":');
      throw Object.assign(new Error('PRIVATE_ERROR_PATH_OR_TOKEN'),{code:'EIO'});
    }
    return writeFile(path,content);
  };
  const monitor=await createMonitor({instruction:'Partial temp write'},f.options);
  const valid=f.files.get(monitor.path);
  failWrite=true;await f.tick();
  assert.equal(f.files.get(monitor.path),valid);
  assert.equal(f.calls.rename,1);
  failWrite=false;
  const result=await monitor.finish({ok:true,final:{text:'Repaired final record'}});
  assert.equal(result.available,true);
  assert.equal(f.read(monitor).reply,'Repaired final record');
  assert.equal(f.read(monitor).monitorWrite.lastErrorPhase,'write');
  assert.equal(f.read(monitor).monitorWrite.lastErrorCode,'EIO');
  assert.equal(f.files.has(monitor.path+'.tmp'),false);
});

test('finish forces a final snapshot after earlier failures and ignores late events',async()=>{
  const f=fixture(),monitor=await createMonitor({instruction:'Finish recovery'},f.options);
  f.setFailure('EPERM');await f.tick();
  f.setFailure(null);
  const result=await monitor.finish({ok:false,error:'Total limit',timeout:{kind:'total',limitMs:10000,elapsedMs:10001},final:{text:'Final reply'}});
  monitor.harness({type:'session'});
  monitor.control({event:'reply_stream',type:'start',attemptId:'late'});
  monitor.activity('late','Must not overwrite final state');
  const final=f.read(monitor);
  assert.equal(result.available,true);
  assert.equal(final.done,true);
  assert.equal(final.status,'failed');
  assert.equal(final.reply,'Final reply');
  assert.equal(final.timeout.kind,'total');
  assert.equal(final.monitorWrite.failedFlushCount,1);
  assert.equal(final.monitorWrite.recoveryCount,1);
  assert.equal(final.events.at(-1).kind,'finish');
  assert.deepEqual(await monitor.finish({ok:true}),result);
  assert.deepEqual(f.read(monitor),final);
});

test('a slow writer coalesces pending heartbeats and never overwrites the final snapshot with old work',async()=>{
  const f=fixture(),monitor=await createMonitor({instruction:'Bounded writer'},f.options);
  const gate=f.blockWrites();
  monitor.activity('step','First active write');
  const waiting=[f.tick()];
  // Let the active writer reach its injected I/O gate.
  await Promise.resolve();
  for(let n=0;n<100;n++){
    monitor.activity('step',`Pending activity ${n}`);
    waiting.push(f.tick());
  }
  const finalPromise=monitor.finish({ok:true,final:{text:'Latest final reply'}});
  gate.resolve();
  await Promise.all(waiting);
  const result=await finalPromise,final=f.read(monitor);
  assert.equal(result.available,true);
  assert.equal(f.maxActiveWrites,1);
  assert.equal(f.calls.write,3); // Initial record, active snapshot, final latest snapshot.
  assert.equal(f.calls.rename,3);
  assert.equal(final.reply,'Latest final reply');
  assert.equal(final.status,'completed');
  assert.equal(final.done,true);
  assert.equal(final.events.at(-1).kind,'finish');
});

test('unknown file error details are discarded and mkdir failures can recover on a later flush',async()=>{
  const f=fixture();
  let failure=true;
  f.options.io.mkdir=async()=>{
    f.calls.mkdir++;
    if(failure)throw Object.assign(new Error('PRIVATE_ERROR_PATH_OR_TOKEN'),{code:'PRIVATE_ERROR_PATH_OR_TOKEN'});
  };
  const monitor=await createMonitor({instruction:'Directory recovery'},f.options);
  assert.equal(f.files.has(monitor.path),false);
  assert.equal(f.calls.mkdir,1); // Unknown errors do not receive immediate retries.
  assert.deepEqual(f.sleeps,[]);
  failure=false;
  const result=await monitor.finish({ok:true});
  const record=f.read(monitor);
  assert.equal(result.available,true);
  assert.equal(record.monitorWrite.lastErrorCode,'IO_ERROR');
  assert.equal(record.monitorWrite.lastErrorPhase,'mkdir');
  assert.equal(record.monitorWrite.failedFlushCount,1);
  assert.equal(record.monitorWrite.recoveryCount,1);
  assert.equal(JSON.stringify(record).includes('PRIVATE_ERROR_PATH_OR_TOKEN'),false);
});
