import {readFile,open,mkdir,unlink,stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dataRoot} from './store.mjs';
async function existing(){
  try {
    const s=JSON.parse(await readFile(join(dataRoot,'server.json'),'utf8'));
    if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(s.url)||!/^[a-f0-9]{64}$/.test(s.token))return null;
    const r=await fetch(s.url+'/api/health',{headers:{Authorization:'Bearer '+s.token},signal:AbortSignal.timeout(1000)}),health=await r.json();
    return r.ok&&health.service==='deepseek-monitor'?s.url+'/#token='+s.token:null;
  }catch{return null;}
}
export async function launch(){
  const running=await existing();if(running)return {url:running,reused:true};
  await mkdir(dataRoot,{recursive:true});const lockPath=join(dataRoot,'start.lock');let lock;
  try{lock=await open(lockPath,'wx');}catch(error){
    if(error.code!=='EEXIST')throw error;
    if(Date.now()-(await stat(lockPath)).mtimeMs>20000){await unlink(lockPath);return launch();}
    for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,200));const url=await existing();if(url)return {url,reused:true};}
    throw new Error('Monitor startup is still pending');
  }
  try {
    const child=spawn(process.execPath,[join(dirname(fileURLToPath(import.meta.url)),'http.mjs')],{windowsHide:true,detached:true,stdio:'ignore'});child.unref();
    let spawnError;child.once('error',e=>spawnError=e);
    for(let i=0;i<40;i++){if(spawnError)throw spawnError;await new Promise(r=>setTimeout(r,200));const url=await existing();if(url)return {url,reused:false};}
    throw new Error('Monitor failed to start');
  }finally{await lock.close();await unlink(lockPath).catch(()=>{});}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))launch().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
