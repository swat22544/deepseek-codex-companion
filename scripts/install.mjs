import {cp,mkdir,readFile,writeFile,access,stat,lstat,rm,readdir,unlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve,dirname,isAbsolute,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {validateConfiguredPaths} from '../skills/deepseek-helper/scripts/runtime-paths.mjs';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const json=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
const exists=async path=>{try{await access(path);return true;}catch{return false;}};
const ownedComponentPaths=new Set(['plugins/deepseek-monitor','skills/deepseek-helper','deepseek-companion-marketplace/plugins/deepseek-monitor']);

async function checkedOwnedComponent(codexHome,component){
  if(!ownedComponentPaths.has(component))throw new Error('Refusing an unknown installation component path.');
  const root=resolve(codexHome),target=resolve(root,...component.split('/'));
  if(!isAbsolute(root)||relative(root,target).replaceAll('\\','/')!==component)throw new Error('Installation component escaped its selected CODEX_HOME.');
  // Do not replace through a junction/symlink at the owned path or any of its
  // parents below the explicitly selected root.
  let current=root;
  for(const part of ['',...component.split('/')]){
    if(part)current=join(current,part);
    let entry;try{entry=await lstat(current);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    if(entry.isSymbolicLink()||!entry.isDirectory())throw new Error('Installation component path must use real directories: '+current);
  }
  return target;
}

async function refreshOwnedComponent(codexHome,component){
  const target=await checkedOwnedComponent(codexHome,component);
  // A running host may hold this directory as cwd on Windows. Keep the checked
  // component root itself and refresh only its enumerated direct children.
  await mkdir(target,{recursive:true});
  for(const name of await readdir(target)){
    const child=resolve(target,name);
    if(dirname(child)!==target||relative(target,child)!==name)throw new Error('Installation child escaped its owned component.');
    const entry=await lstat(child);
    if(entry.isSymbolicLink())await unlink(child);
    else await rm(child,{recursive:true,force:true});
  }
}

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

export async function install({codexHome=process.env.CODEX_HOME||join(homedir(),'.codex'),dshHome,zcodeHome,overwrite=false,allowNonWindows=false}={}){
  if(process.platform!=='win32'&&!allowNonWindows)throw new Error('The current DeepSeek Harness adapter supports Windows only.');
  codexHome=resolve(codexHome);
  if(!isAbsolute(codexHome))throw new Error('CODEX_HOME must be absolute');
  if(dshHome){dshHome=resolve(dshHome);if(!await exists(join(dshHome,'DeepSeek Harness.exe')))throw new Error('DeepSeek Harness.exe was not found in --dsh-home.');}
  const pluginTarget=await checkedOwnedComponent(codexHome,'plugins/deepseek-monitor'),skillTarget=await checkedOwnedComponent(codexHome,'skills/deepseek-helper');
  const installedMarketplace=join(codexHome,'deepseek-companion-marketplace');
  const marketplacePlugin=await checkedOwnedComponent(codexHome,'deepseek-companion-marketplace/plugins/deepseek-monitor');
  const hookConfigPath=join(pluginTarget,'hooks','hooks.json'),hookRuntimePath=join(pluginTarget,'hooks','runtime.json');
  const targets=[pluginTarget,skillTarget];
  for(const target of targets)if(await exists(target)&&!overwrite)throw new Error('Already installed: '+target+'. Use --overwrite to back up and replace this component.');
  const localConfigPath=join(skillTarget,'helper.config.json'),localConfig={};
  const hadLocalConfig=await exists(localConfigPath);
  if(hadLocalConfig){
    const previous=await json(localConfigPath);
    if(!previous||typeof previous!=='object'||Array.isArray(previous))throw new Error('Installed helper.config.json must contain an object.');
    // Preserve only current application locations. Unknown saved fields do not
    // select files or account data and are not propagated to the new config.
    for(const key of ['installation','zcodeInstallation'])if(Object.hasOwn(previous,key)){
      if((key==='installation'&&dshHome)||(key==='zcodeInstallation'&&zcodeHome!==undefined))continue;
      if(typeof previous[key]!=='string'||!isAbsolute(previous[key]))throw new Error('Installed helper.config.json must contain absolute application paths.');
      localConfig[key]=previous[key];
    }
  }
  if(dshHome)localConfig.installation=dshHome;
  if(zcodeHome!==undefined){
    if(typeof zcodeHome!=='string'||!isAbsolute(zcodeHome))throw new Error('--zcode-home must be an absolute installation path.');
    localConfig.zcodeInstallation=resolve(zcodeHome);
  }
  // A previous empty/unknown-only object otherwise survives a successful
  // update unchanged, only to fail on the next delegation. Reject before any
  // backup/copy; explicitly supplied backend paths can repair that shape.
  if(hadLocalConfig||Object.keys(localConfig).length)validateConfiguredPaths(localConfig);
  if(localConfig.zcodeInstallation){
    for(const parts of [['ZCode.exe'],['resources','glm','zcode.cjs']]){
      const entryStat=await stat(join(localConfig.zcodeInstallation,...parts)).catch(()=>null);
      if(!entryStat?.isFile())throw new Error(parts.join('/')+' was not found as a file in --zcode-home or the installed ZCode path.');
    }
  }
  // Validate shipped configuration before backing up or replacing components.
  const pluginManifest=await json(join(repository,'plugins','deepseek-monitor','plugin.json'));
  if(pluginManifest?.name!=='deepseek-monitor'||typeof pluginManifest.version!=='string'||!pluginManifest.version)throw new Error('Invalid shipped plugin manifest.');
  const mcpConfigs=new Map();
  for(const name of ['mcp.json','.mcp.json']){
    const config=await json(join(repository,'plugins','deepseek-monitor',name));
    if(!config?.mcpServers?.['deepseek-monitor']||typeof config.mcpServers['deepseek-monitor']!=='object'||Array.isArray(config.mcpServers['deepseek-monitor']))throw new Error('Invalid shipped MCP configuration.');
    mcpConfigs.set(name,config);
  }
  const taskHookConfig=configureTaskHookCommands(await json(join(repository,'plugins','deepseek-monitor','hooks','hooks.json')));
  let backupDirectory=null;
  if(overwrite&&await Promise.all(targets.map(exists)).then(values=>values.some(Boolean))){
    backupDirectory=join(codexHome,'backups','deepseek-companion-'+Date.now());await mkdir(backupDirectory,{recursive:true});
    for(const target of targets)if(await exists(target))await cp(target,join(backupDirectory,target===pluginTarget?'deepseek-monitor':'deepseek-helper'),{recursive:true});
  }
  // The backup retains any prior local additions. Refresh owned component
  // directories so source deletions cannot leave retired adapters executable.
  if(overwrite)for(const component of ['plugins/deepseek-monitor','skills/deepseek-helper']){
    await refreshOwnedComponent(codexHome,component);
  }
  await mkdir(dirname(pluginTarget),{recursive:true});await mkdir(dirname(skillTarget),{recursive:true});
  await cp(join(repository,'plugins','deepseek-monitor'),pluginTarget,{recursive:true,force:true});
  await cp(join(repository,'skills','deepseek-helper'),skillTarget,{recursive:true,force:true});
  for(const name of ['mcp.json','.mcp.json']){
    const path=join(pluginTarget,name),config=mcpConfigs.get(name);
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
  await mkdir(join(installedMarketplace,'.agents','plugins'),{recursive:true});
  // Keep sources inside the marketplace root without cross-directory traversal.
  await refreshOwnedComponent(codexHome,'deepseek-companion-marketplace/plugins/deepseek-monitor');
  await mkdir(dirname(marketplacePlugin),{recursive:true});await cp(pluginTarget,marketplacePlugin,{recursive:true,force:true});
  const manifest={name:'deepseek-codex-companion',interface:{displayName:'DeepSeek Codex Companion'},plugins:[{name:'deepseek-monitor',source:{source:'local',path:'./plugins/deepseek-monitor'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Productivity'}]};
  await writeFile(join(installedMarketplace,'.agents','plugins','marketplace.json'),JSON.stringify(manifest,null,2)+'\n');
  return {pluginTarget,skillTarget,marketplaceRoot:installedMarketplace,backupDirectory,hookConfigPath,hookRuntimePath,hooksIncluded:true,hookTrustRequired:true,dshHome:localConfig.installation??null,zcodeInstallation:localConfig.zcodeInstallation??null,nextCommands:[`codex plugin marketplace add "${installedMarketplace}" --json`,'codex plugin add deepseek-monitor@deepseek-codex-companion --json']};
}

export async function main(){
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--help'){console.log('node scripts/install.mjs [--dsh-home "D:/DeepSeek Harness"] [--zcode-home "D:/Zcode"] [--codex-home PATH] [--overwrite]\nCopies the Skill and plugin with task preflight hooks, resolves Node, preserves Harness/ZCode paths, and creates a local marketplace.\nAfter registering the plugin, review its hooks in Codex /hooks; native hook trust is still required.\nIt does not edit global hooks, AGENTS.md, configuration or trust, log in, call a model, or remove application data.');return;}
    if(args[i]==='--overwrite')options.overwrite=true;
    else if(['--dsh-home','--codex-home','--zcode-home'].includes(args[i])){if(!args[i+1]||args[i+1].startsWith('--'))throw new Error('Missing path argument');const key={'--dsh-home':'dshHome','--codex-home':'codexHome','--zcode-home':'zcodeHome'}[args[i]];options[key]=args[++i];}
    else throw new Error('Unknown argument: '+args[i]);
  }
  console.log(JSON.stringify(await install(options),null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
