import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {dataRoot,listRuns,getRun} from './store.mjs';
import {readServiceConfig} from './service-config.mjs';

export async function startServer({root=dataRoot,port}={}){
  const config=await readServiceConfig(root);
  const listenPort=port??config?.port??0;
  const token=config?.token??randomBytes(32).toString('hex'),html=await readFile(join(dirname(fileURLToPath(import.meta.url)),'../ui/panel.html'),'utf8');
  let origin;
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    if(req.headers.host!==origin.slice(7)||req.headers.origin&&req.headers.origin!==origin)return send(403,{error:'Origin rejected'});
    if(req.method!=='GET')return send(405,{error:'Read-only monitor'});
    const path=new URL(req.url,origin).pathname;
    if(path==='/'){
      res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(html);
    }
    const actual=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+token);
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return send(401,{error:'Monitor token required'});
    try {
      if(path==='/api/health')return send(200,{ok:true,service:'deepseek-monitor',version:'1.0.4',pid:process.pid});
      if(path==='/api/runs')return send(200,{runs:await listRuns(root)});
      const match=path.match(/^\/api\/runs\/([a-f0-9-]+)$/);if(match)return send(200,{run:await getRun(match[1],root)});
      send(404,{error:'Not found'});
    }catch{send(404,{error:'Run unavailable'});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(listenPort,'127.0.0.1',resolve);});
  origin='http://127.0.0.1:'+server.address().port;
  await mkdir(root,{recursive:true});await writeFile(join(root,'server.json'),JSON.stringify({url:origin,token,pid:process.pid}));
  return {server,url:origin+'/#token='+token,token};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])startServer().catch(error=>{console.error(error.message);process.exitCode=1;});
