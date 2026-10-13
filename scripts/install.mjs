import {cp,mkdir,readFile,writeFile,access,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const json=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
const exists=async path=>{try{await access(path);return true;}catch{return false;}};

export async function install({codexHome=process.env.CODEX_HOME||join(homedir(),'.codex'),dshHome,opencodeCli,overwrite=false,allowNonWindows=false}={}){
  if(process.platform!=='win32'&&!allowNonWindows)throw new Error('The current DeepSeek Harness adapter supports Windows only.');
  codexHome=resolve(codexHome);
  if(!isAbsolute(codexHome))throw new Error('CODEX_HOME must be absolute');
  if(dshHome){dshHome=resolve(dshHome);if(!await exists(join(dshHome,'DeepSeek Harness.exe')))throw new Error('DeepSeek Harness.exe was not found in --dsh-home.');}
  const pluginTarget=join(codexHome,'plugins','deepseek-monitor'),skillTarget=join(codexHome,'skills','deepseek-helper');
  const targets=[pluginTarget,skillTarget];
  for(const target of targets)if(await exists(target)&&!overwrite)throw new Error('Already installed: '+target+'. Use --overwrite to back up and replace this component.');
  const localConfigPath=join(skillTarget,'helper.config.json'),localConfig={};
  if(await exists(localConfigPath)){
    const previous=await json(localConfigPath);
    if(!previous||typeof previous!=='object'||Array.isArray(previous))throw new Error('Installed helper.config.json must contain an object.');
    for(const key of ['installation','opencodeExecutable'])if(Object.hasOwn(previous,key)){
      if((key==='installation'&&dshHome)||(key==='opencodeExecutable'&&opencodeCli))continue;
      if(typeof previous[key]!=='string'||!isAbsolute(previous[key]))throw new Error('Installed helper.config.json must contain absolute application paths.');
      localConfig[key]=previous[key];
    }
  }
  if(dshHome)localConfig.installation=dshHome;
  if(opencodeCli!==undefined){
    if(typeof opencodeCli!=='string'||!isAbsolute(opencodeCli))throw new Error('--opencode-cli must be an absolute executable path.');
    localConfig.opencodeExecutable=resolve(opencodeCli);
  }
  if(localConfig.opencodeExecutable){
    const executableStat=await stat(localConfig.opencodeExecutable).catch(()=>null);
    if(!executableStat?.isFile())throw new Error('OpenCode CLI executable was not found at --opencode-cli or the installed application path.');
  }
  let backupDirectory=null;
  if(overwrite&&await Promise.all(targets.map(exists)).then(values=>values.some(Boolean))){
    backupDirectory=join(codexHome,'backups','deepseek-companion-'+Date.now());await mkdir(backupDirectory,{recursive:true});
    for(const target of targets)if(await exists(target))await cp(target,join(backupDirectory,target===pluginTarget?'deepseek-monitor':'deepseek-helper'),{recursive:true});
  }
  await mkdir(dirname(pluginTarget),{recursive:true});await mkdir(dirname(skillTarget),{recursive:true});
  await cp(join(repository,'plugins','deepseek-monitor'),pluginTarget,{recursive:true,force:true});
  await cp(join(repository,'skills','deepseek-helper'),skillTarget,{recursive:true,force:true});
  for(const name of ['mcp.json','.mcp.json']){
    const path=join(pluginTarget,name),config=await json(path);
    config.mcpServers['deepseek-monitor'].command=process.execPath;
    config.mcpServers['deepseek-monitor'].env={...config.mcpServers['deepseek-monitor'].env,CODEX_HOME:codexHome};
    await writeFile(path,JSON.stringify(config,null,2)+'\n');
  }
  // Persist only known application paths, preserving either backend when the
  // caller updates just the other. Credentials and unknown fields are not copied.
  if(Object.keys(localConfig).length)await writeFile(localConfigPath,JSON.stringify(localConfig,null,2)+'\n');
  const installedMarketplace=join(codexHome,'deepseek-companion-marketplace');
  await mkdir(join(installedMarketplace,'.agents','plugins'),{recursive:true});
  // Keep sources inside the marketplace root without cross-directory traversal.
  const marketplacePlugin=join(installedMarketplace,'plugins','deepseek-monitor');
  await mkdir(dirname(marketplacePlugin),{recursive:true});await cp(pluginTarget,marketplacePlugin,{recursive:true,force:true});
  const manifest={name:'deepseek-codex-companion',interface:{displayName:'DeepSeek Codex Companion'},plugins:[{name:'deepseek-monitor',source:{source:'local',path:'./plugins/deepseek-monitor'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Productivity'}]};
  await writeFile(join(installedMarketplace,'.agents','plugins','marketplace.json'),JSON.stringify(manifest,null,2)+'\n');
  return {pluginTarget,skillTarget,marketplaceRoot:installedMarketplace,backupDirectory,dshHome:localConfig.installation??null,opencodeExecutable:localConfig.opencodeExecutable??null,nextCommands:[`codex plugin marketplace add "${installedMarketplace}" --json`,'codex plugin add deepseek-monitor@deepseek-codex-companion --json']};
}

export async function main(){
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--help'){console.log('node scripts/install.mjs [--dsh-home "D:/DeepSeek Harness"] [--opencode-cli ABSOLUTE_EXE] [--codex-home PATH] [--overwrite]\nCopies the Skill and plugin, resolves Node, preserves application paths, and creates a local marketplace.\nIt does not edit global AGENTS.md, log in, or call a model.');return;}
    if(args[i]==='--overwrite')options.overwrite=true;
    else if(['--dsh-home','--codex-home','--opencode-cli'].includes(args[i])){if(!args[i+1]||args[i+1].startsWith('--'))throw new Error('Missing path argument');const key={'--dsh-home':'dshHome','--codex-home':'codexHome','--opencode-cli':'opencodeCli'}[args[i]];options[key]=args[++i];}
    else throw new Error('Unknown argument: '+args[i]);
  }
  console.log(JSON.stringify(await install(options),null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
