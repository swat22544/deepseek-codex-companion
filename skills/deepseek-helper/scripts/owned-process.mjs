import {spawn} from 'node:child_process';
import {open} from 'node:fs/promises';
import {evaluateDeadline} from './supervised-runner.mjs';

// Only this invocation's private CLI process tree may be terminated.
export function runOwned(executable,args,{cwd,env,clock,onLine,check=()=>{},maxBytes=4*1024*1024,limitMs=30000}={}) {
  return new Promise((done,reject)=>{
    let buffer='',output='',count=0,closed=false,settled=false,error=null,killing=false,killed=false,killDone=false,exitCode=null,cleanupTimer;
    const start=Date.now();
    const child=spawn(executable,args,{cwd,env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    function settle(incomplete=false){
      if(settled)return;settled=true;clearInterval(timer);clearTimeout(cleanupTimer);process.off('SIGINT',cancel);process.off('SIGTERM',cancel);
      if(!error)try{check();if(clock){const expired=evaluateDeadline(clock);if(expired.failure)throw Object.assign(new Error(expired.failure),{timeout:expired.timeout});}}catch(e){error=e;}
      const cleanup={requested:killing,treeKillConfirmed:killed,incomplete};
      if(error||exitCode!==0||incomplete){const e=error??new Error('Backend process did not exit successfully.');e.cleanup=cleanup;e.exitCode=exitCode;reject(e);}
      else done({exitCode,output,cleanup});
    }
    function maybe(){if(closed&&(!killing||killDone))settle(killing&&!killed);}
    function fail(e){
      error??=e;if(killing||closed){if(closed)maybe();return;}killing=true;
      const killer=process.platform==='win32'?spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}):null;
      if(killer){killer.on('error',()=>{killDone=true;maybe();});killer.on('close',code=>{killed=code===0;killDone=true;maybe();});}
      else{try{killed=child.kill('SIGKILL');}catch{}killDone=true;}
      cleanupTimer=setTimeout(()=>{killer?.kill();child.stdout.destroy();child.stderr.destroy();child.unref();settle(true);},7000);
    }
    function cancel(){fail(new Error('Task cancelled by supervisor.'));}
    const timer=setInterval(()=>{try{check();if(clock){const d=evaluateDeadline(clock);if(d.failure)throw Object.assign(new Error(d.failure),{timeout:d.timeout});}if(Date.now()-start>limitMs)throw new Error('Backend control operation timed out.');}catch(e){fail(e);}},100);
    process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
      if(error)return;count+=Buffer.byteLength(chunk);if(count>maxBytes){fail(new Error('Backend output limit exceeded.'));return;}
      if(!onLine){output+=chunk;return;}
      buffer+=chunk;let pos;while((pos=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,pos);buffer=buffer.slice(pos+1);if(line.trim())try{onLine(line);}catch(e){fail(e);return;}}
    });
    // Errors can contain provider credentials or private request data. Discard.
    child.stderr.on('data',()=>{});
    child.on('error',e=>{error=new Error('Unable to start Backend CLI: '+e.code);closed=true;exitCode=null;maybe();});
    child.on('close',code=>{closed=true;exitCode=code;if(buffer.trim()&&!error)try{onLine(buffer);}catch(e){error=e;}maybe();});
  });
}

export function createAuditReader(path,accept) {
  let offset=0,buffer='',pending=null,finished=false,finishPromise=null,failure=null;
  // Audit writers may append between polls, including inside a UTF-8 codepoint.
  // Fatal streaming decode preserves split characters and rejects corrupt bytes.
  const decoder=new TextDecoder('utf-8',{fatal:true});
  async function read(){
    let file;try{file=await open(path,'r');}catch(e){if(e.code==='ENOENT')return;throw e;}
    try{
      const {size}=await file.stat();if(size<offset||size>8*1024*1024)throw new Error('Backend audit size violation.');
      while(offset<size){
        const bytes=Buffer.alloc(size-offset);const {bytesRead}=await file.read(bytes,0,bytes.length,offset);
        if(!bytesRead)throw new Error('Backend audit ended before its recorded size.');
        offset+=bytesRead;
        try{buffer+=decoder.decode(bytes.subarray(0,bytesRead),{stream:true});}
        catch{throw new Error('Invalid UTF-8 in Backend audit.');}
        let pos;
        while((pos=buffer.indexOf('\n'))>=0){
          const line=buffer.slice(0,pos);buffer=buffer.slice(pos+1);
          if(line.length>1024*1024)throw new Error('Backend audit line limit exceeded.');
          if(line.trim()){
            let record;try{record=JSON.parse(line);}catch{throw new Error('Malformed Backend audit record.');}
            accept(record);
          }
        }
        if(buffer.length>1024*1024)throw new Error('Backend audit line limit exceeded.');
      }
    }finally{await file.close();}
  }
  const reader=()=>{
    if(failure)return Promise.reject(failure);
    if(finished)return Promise.resolve();
    return pending??(pending=read().catch(error=>{failure=error;throw error;}).finally(()=>{pending=null;}));
  };
  // Call after audit writers stop. The last record must have its newline and
  // complete UTF-8 bytes; an incomplete final record is not valid evidence.
  reader.finish=()=>finishPromise??(finishPromise=(async()=>{
    // An in-flight poll may have stat'ed before the writer's last append.
    // Join it first, then perform a fresh EOF read after writers have stopped.
    if(pending)await pending;
    await reader();
    try{buffer+=decoder.decode();}catch{throw new Error('Invalid UTF-8 at end of Backend audit.');}
    if(buffer.length)throw new Error('Unterminated Backend audit record.');
    finished=true;
  })().catch(error=>{failure=error;throw error;}));
  return reader;
}
