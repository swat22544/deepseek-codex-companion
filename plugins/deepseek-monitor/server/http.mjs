import {createServer} from 'node:http';
import {readFile,mkdir,writeFile,rename,unlink} from 'node:fs/promises';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve} from 'node:path';
import {dataRoot,listRuns,getRun} from './store.mjs';
import {readServiceConfig} from './service-config.mjs';

export async function startServer({root=dataRoot,port}={}){
  const config=await readServiceConfig(root);
  const listenPort=port??config?.port??0;
  const token=config?.token??randomBytes(32).toString('hex'),html=await readFile(join(dirname(fileURLToPath(import.meta.url)),'../ui/panel.html'),'utf8');
  await mkdir(root,{recursive:true});
  let origin;
  const server=createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    // Node does not consume rejected promises from async request listeners.
    // Keep parsing, authorization and asynchronous reads inside one boundary.
    void (async()=>{
    if(req.headers.host!==origin.slice(7)||req.headers.origin&&req.headers.origin!==origin)return send(403,{error:'Origin rejected'});
    if(req.method!=='GET')return send(405,{error:'Read-only monitor'});
    let path;
    try{path=new URL(req.url,origin).pathname;}
    catch{return send(400,{error:'Invalid request target'});}
    if(path==='/'){
      res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(html);
    }
    const actual=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+token);
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return send(401,{error:'Monitor token required'});
      if(path==='/api/health')return send(200,{ok:true,service:'deepseek-monitor',version:'1.4.1',pid:process.pid});
      if(path==='/api/runs')return send(200,{runs:await listRuns(root)});
      const match=path.match(/^\/api\/runs\/([a-f0-9-]+)$/);
      if(match){
        try{return send(200,{run:await getRun(match[1],root)});}
        catch{return send(404,{error:'Run unavailable'});}
      }
      send(404,{error:'Not found'});
    })().catch(()=>{
      // Never disclose filesystem paths, saved records or capabilities.
      if(!res.headersSent)send(500,{error:'Monitor unavailable'});else res.destroy();
    });
  });
  const tempPath=join(root,'server.json.'+process.pid+'.'+randomBytes(8).toString('hex')+'.tmp');
  try{
    await new Promise((resolveListen,reject)=>{
      const onError=error=>{server.off('listening',onListening);reject(error);};
      const onListening=()=>{server.off('error',onError);resolveListen();};
      server.once('error',onError);server.once('listening',onListening);
      server.listen(listenPort,'127.0.0.1');
    });
    origin='http://127.0.0.1:'+server.address().port;
    await writeFile(tempPath,JSON.stringify({url:origin,token,pid:process.pid}),{mode:0o600,flag:'wx'});
    await rename(tempPath,join(root,'server.json'));
    return {server,url:origin+'/#token='+token,token};
  }catch(error){
    // This function owns this listener; failed startup must not leave it alive.
    if(server.listening){const closed=new Promise(resolveClose=>server.close(resolveClose));server.closeAllConnections();await closed;}
    await unlink(tempPath).catch(()=>{});
    throw error;
  }
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))startServer({root:process.argv[2]?resolve(process.argv[2]):dataRoot}).catch(()=>{console.error('Monitor failed to start');process.exitCode=1;});
