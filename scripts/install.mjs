import {cp,mkdir,readFile,writeFile,access,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {validateConfiguredPaths} from '../skills/deepseek-helper/scripts/runtime-paths.mjs';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const json=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
const exists=async path=>{try{await access(path);return true;}catch{return false;}};

export function makeTaskHookCommands(nodeExecutable=process.execPath,scriptPath){
  if(typeof nodeExecutable!=='string'||!isAbsolute(nodeExecutable))throw new Error('Task hook Node executable must be an absolute path.');
  if(scriptPath!==undefined&&(typeof scriptPath!=='string'||!isAbsolute(scriptPath)))throw new Error('Task hook script must be an absolute path.');
  const posixNode="'"+nodeExecutable.replaceAll("'","'\"'\"'")+"'";
  const powershellNode="'"+nodeExecutable.replaceAll("'","''")+"'";
  const posixScript=scriptPath===undefined?'"${PLUGIN_ROOT}/hooks/task-preflight.mjs"':"'"+scriptPath.replaceAll("'","'\"'\"'")+"'";
  const powershellScript=scriptPath===undefined?"(Join-Path $env:PLUGIN_ROOT 'hooks/task-preflight.mjs')":"'"+scriptPath.replaceAll("'","''")+"'";
  const windowsScript=[
    "$ProgressPreference='SilentlyContinue'",
    '[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding=[Console]::OutputEncoding',
    `& ${powershellNode} ${powershellScript}`,
    'exit $LASTEXITCODE'
  ].join('; ');
  return {
    command:`${posixNode} ${posixScript}`,
    commandWindows:'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand '+Buffer.from(windowsScript,'utf16le').toString('base64')
  };
}

function configureTaskHookCommands(config){
  if(!config?.hooks||typeof config.hooks!=='object'||Array.isArray(config.hooks))throw new Error('Task hook configuration must contain hook events.');
  const commands=makeTaskHookCommands();
  let updated=0;
  for(const groups of Object.values(config.hooks)){
    if(!Array.isArray(groups))throw new Error('Task hook events must contain hook groups.');
    for(const group of groups){
      if(!Array.isArray(group?.hooks))throw new Error('Task hook groups must contain hooks.');
      for(const hook of group.hooks)if(hook?.type==='command'){
        Object.assign(hook,commands);updated++;
      }
    }
  }
  if(!updated)throw new Error('Task hook configuration must contain command hooks.');
  return config;
}

export async function install({codexHome=process.env.CODEX_HOME||join(homedir(),'.codex'),dshHome,opencodeCli,overwrite=false,allowNonWindows=false}={}){
  if(process.platform!=='win32'&&!allowNonWindows)throw new Error('The current DeepSeek Harness adapter supports Windows only.');
  codexHome=resolve(codexHome);
  if(!isAbsolute(codexHome))throw new Error('CODEX_HOME must be absolute');
  if(dshHome){dshHome=resolve(dshHome);if(!await exists(join(dshHome,'DeepSeek Harness.exe')))throw new Error('DeepSeek Harness.exe was not found in --dsh-home.');}
  const pluginTarget=join(codexHome,'plugins','deepseek-monitor'),skillTarget=join(codexHome,'skills','deepseek-helper');
  const hookConfigPath=join(pluginTarget,'hooks','hooks.json'),hookRuntimePath=join(pluginTarget,'hooks','runtime.json');
  const targets=[pluginTarget,skillTarget];
  for(const target of targets)if(await exists(target)&&!overwrite)throw new Error('Already installed: '+target+'. Use --overwrite to back up and replace this component.');
  const localConfigPath=join(skillTarget,'helper.config.json'),localConfig={};
  const hadLocalConfig=await exists(localConfigPath);
  if(hadLocalConfig){
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
  // A previous empty/unknown-only object otherwise survives a successful
  // update unchanged, only to fail on the next delegation. Reject before any
  // backup/copy; explicitly supplied backend paths can repair that shape.
  if(hadLocalConfig||Object.keys(localConfig).length)validateConfiguredPaths(localConfig);
  if(localConfig.opencodeExecutable){
    const executableStat=await stat(localConfig.opencodeExecutable).catch(()=>null);
    if(!executableStat?.isFile())throw new Error('OpenCode CLI executable was not found at --opencode-cli or the installed application path.');
  }
  // Validate the shipped hooks before backing up or replacing an installation.
  const taskHookConfig=configureTaskHookCommands(await json(join(repository,'plugins','deepseek-monitor','hooks','hooks.json')));
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
  // The plugin owns its hook files. Keep application-wide hook configuration
  // and trust decisions untouched; the runtime only needs the selected root.
  await mkdir(dirname(hookRuntimePath),{recursive:true});
  await writeFile(hookConfigPath,JSON.stringify(taskHookConfig,null,2)+'\n');
  await writeFile(hookRuntimePath,JSON.stringify({codexHome},null,2)+'\n');
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
  return {pluginTarget,skillTarget,marketplaceRoot:installedMarketplace,backupDirectory,hookConfigPath,hookRuntimePath,hooksIncluded:true,hookTrustRequired:true,dshHome:localConfig.installation??null,opencodeExecutable:localConfig.opencodeExecutable??null,nextCommands:[`codex plugin marketplace add "${installedMarketplace}" --json`,'codex plugin add deepseek-monitor@deepseek-codex-companion --json']};
}

export async function main(){
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--help'){console.log('node scripts/install.mjs [--dsh-home "D:/DeepSeek Harness"] [--opencode-cli ABSOLUTE_EXE] [--codex-home PATH] [--overwrite]\nCopies the Skill and plugin with task preflight hooks, resolves Node, preserves application paths, and creates a local marketplace.\nAfter registering the plugin, review its hooks in Codex /hooks; native hook trust is still required.\nIt does not edit global hooks, AGENTS.md, configuration or trust, log in, or call a model.');return;}
    if(args[i]==='--overwrite')options.overwrite=true;
    else if(['--dsh-home','--codex-home','--opencode-cli'].includes(args[i])){if(!args[i+1]||args[i+1].startsWith('--'))throw new Error('Missing path argument');const key={'--dsh-home':'dshHome','--codex-home':'codexHome','--opencode-cli':'opencodeCli'}[args[i]];options[key]=args[++i];}
    else throw new Error('Unknown argument: '+args[i]);
  }
  console.log(JSON.stringify(await install(options),null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
