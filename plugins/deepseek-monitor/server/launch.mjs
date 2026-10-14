import {readFile,open,mkdir,unlink,stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dataRoot} from './store.mjs';
async function existing(root){
  try {
    const s=JSON.parse(await readFile(join(root,'server.json'),'utf8'));
    if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(s.url)||!/^[a-f0-9]{64}$/.test(s.token)||!Number.isSafeInteger(s.pid)||s.pid<1)return null;
    const r=await fetch(s.url+'/api/health',{headers:{Authorization:'Bearer '+s.token},signal:AbortSignal.timeout(1000)}),health=await r.json();
    return r.ok&&health.service==='deepseek-monitor'&&health.pid===s.pid?{url:s.url+'/#token='+s.token,pid:s.pid}:null;
  }catch{return null;}
}
const pause=ms=>new Promise(resolvePause=>setTimeout(resolvePause,ms));
async function stopOwnedChild(child,exited){
  if(child.exitCode!==null||child.signalCode!==null||!child.pid)return;
  child.kill();
  if(await Promise.race([exited.then(()=>true),pause(1000).then(()=>false)]))return;
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  await Promise.race([exited,pause(1000)]);
}
export async function launch({root=dataRoot,startupTimeoutMs=8000}={}){
  if(!Number.isInteger(startupTimeoutMs)||startupTimeoutMs<1||startupTimeoutMs>15000)throw new Error('Invalid monitor startup timeout');
  root=resolve(root);
  const running=await existing(root);if(running)return {url:running.url,reused:true};
  try{await mkdir(root,{recursive:true});}catch(error){throw new Error('Unable to prepare monitor data directory',{cause:error});}
  const lockPath=join(root,'start.lock');let lock;
  try{lock=await open(lockPath,'wx');}catch(error){
    if(error.code!=='EEXIST')throw new Error('Unable to prepare monitor startup lock',{cause:error});
    let age;
    try{age=Date.now()-(await stat(lockPath)).mtimeMs;}catch(statError){
      if(statError.code==='ENOENT')return launch({root,startupTimeoutMs});
      throw new Error('Unable to inspect monitor startup lock',{cause:statError});
    }
    if(age>20000){await unlink(lockPath);return launch({root,startupTimeoutMs});}
    const deadline=Date.now()+startupTimeoutMs;
    while(Date.now()<deadline){await pause(Math.min(200,Math.max(1,deadline-Date.now())));const found=await existing(root);if(found)return {url:found.url,reused:true};}
    throw new Error('Monitor startup is still pending');
  }
  let child,exited,ready=false;
  try {
    // A service may have been published between the initial probe and our lock.
    const found=await existing(root);if(found)return {url:found.url,reused:true};
    child=spawn(process.execPath,[join(dirname(fileURLToPath(import.meta.url)),'http.mjs'),root],{windowsHide:true,detached:true,stdio:'ignore'});
    let spawnError,didExit=false;
    exited=new Promise(resolveExit=>{
      child.once('error',error=>{spawnError=error;didExit=true;resolveExit();});
      child.once('exit',()=>{didExit=true;resolveExit();});
    });
    const deadline=Date.now()+startupTimeoutMs;
    while(Date.now()<deadline){
      if(spawnError)throw new Error('Monitor process could not be started',{cause:spawnError});
      if(didExit)throw new Error('Monitor process exited before becoming ready');
      await Promise.race([pause(Math.min(200,Math.max(1,deadline-Date.now()))),exited]);
      const service=await existing(root);
      if(service){ready=service.pid===child.pid;if(ready)child.unref();return {url:service.url,reused:!ready};}
    }
    throw new Error('Monitor failed to start');
  }finally{
    // Only terminate our ChildProcess, never a PID from shared metadata.
    if(child&&!ready)await stopOwnedChild(child,exited);
    await lock.close();await unlink(lockPath).catch(()=>{});
  }
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))launch({root:process.argv[2]?resolve(process.argv[2]):dataRoot}).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
