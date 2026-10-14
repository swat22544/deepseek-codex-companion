import {lstat,open,mkdir,mkdtemp,writeFile,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {join,resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {makeTaskHookCommands} from './install.mjs';

const MAX_CONFIGURATION_BYTES=1024*1024;
const taskEvents=['UserPromptSubmit','SessionStart'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

function validateConfiguration(value){
  if(!object(value)||!Object.hasOwn(value,'hooks')||!object(value.hooks))throw new Error('Hook configuration must be an object containing a hooks object.');
  for(const groups of Object.values(value.hooks)){
    if(!Array.isArray(groups))throw new Error('Hook events must contain arrays of groups.');
    for(const group of groups){
      if(!object(group)||!Array.isArray(group.hooks))throw new Error('Hook groups must contain arrays of handlers.');
      for(const handler of group.hooks)if(!object(handler))throw new Error('Hook handlers must be objects.');
    }
  }
  return value;
}

async function readConfiguration(path,{optional=false}={}){
  let info;
  try{info=await lstat(path);}
  catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}
  if(!info.isFile()||info.isSymbolicLink())throw new Error('Hook configuration must be a regular file, not a symlink.');
  if(info.size>MAX_CONFIGURATION_BYTES)throw new Error('Hook configuration exceeds the 1 MiB limit.');
  const file=await open(path,'r');
  let contents;
  try{
    const opened=await file.stat();
    if(!opened.isFile()||opened.dev!==info.dev||opened.ino!==info.ino)throw new Error('Hook configuration changed while opening.');
    const buffer=Buffer.alloc(MAX_CONFIGURATION_BYTES+1);
    let length=0;
    while(length<buffer.length){
      const {bytesRead}=await file.read(buffer,length,buffer.length-length,null);
      if(!bytesRead)break;
      length+=bytesRead;
    }
    if(length>MAX_CONFIGURATION_BYTES)throw new Error('Hook configuration exceeds the 1 MiB limit.');
    contents=buffer.subarray(0,length);
  }finally{await file.close();}
  let value;
  try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(contents).replace(/^\uFEFF/,''));}
  catch{throw new Error('Hook configuration must contain valid UTF-8 JSON.');}
  return {value:validateConfiguration(value),contents,mode:info.mode};
}

function ownsPosixCommand(command,scriptPath){
  if(typeof command!=='string')return false;
  const match=/^('(?:[^']|'"'"')*') ('(?:[^']|'"'"')*')$/.exec(command);
  if(!match)return false;
  const node=match[1].slice(1,-1).replaceAll("'\"'\"'","'");
  const script=match[2].slice(1,-1).replaceAll("'\"'\"'","'");
  return isAbsolute(node)&&script===scriptPath&&makeTaskHookCommands(node,scriptPath).command===command;
}

function ownsWindowsCommand(command,scriptPath){
  if(typeof command!=='string')return false;
  const match=/^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command);
  if(!match)return false;
  const bytes=Buffer.from(match[1],'base64');
  if(bytes.length%2||bytes.toString('base64')!==match[1])return false;
  const script=bytes.toString('utf16le');
  const call=/; & ('(?:[^']|'')*') ('(?:[^']|'')*'); exit \$LASTEXITCODE$/.exec(script);
  if(!call)return false;
  const node=call[1].slice(1,-1).replaceAll("''","'");
  const target=call[2].slice(1,-1).replaceAll("''","'");
  return isAbsolute(node)&&target===scriptPath&&makeTaskHookCommands(node,scriptPath).commandWindows===command;
}

function ownsHandler(handler,scriptPath){
  if(handler.type!=='command')return false;
  const generic=Object.hasOwn(handler,'command');
  const windows=Object.hasOwn(handler,'commandWindows');
  // A mixed handler is owned only when every supplied execution path targets
  // this script; identifying text or a path merely mentioned is insufficient.
  return (generic||windows)&&(!generic||ownsPosixCommand(handler.command,scriptPath))&&(!windows||ownsWindowsCommand(handler.commandWindows,scriptPath));
}

function mergeTaskHooks(value,template,commands,scriptPath,remove){
  const result=structuredClone(value);
  for(const event of taskEvents){
    if(Object.hasOwn(result.hooks,event)){
      result.hooks[event]=result.hooks[event].flatMap(group=>{
        const handlers=group.hooks.filter(handler=>!ownsHandler(handler,scriptPath));
        if(handlers.length===group.hooks.length)return [group];
        return handlers.length?[{...group,hooks:handlers}]:[];
      });
    }
    if(!remove){
      const groups=template.hooks[event];
      if(!Array.isArray(groups)||groups.length!==1)throw new Error('Installed task hook template must provide one group for each task event.');
      const handlers=groups[0].hooks.filter(handler=>handler.type==='command').map(handler=>({...handler,...commands}));
      if(!handlers.length)throw new Error('Installed task hook template must contain command handlers.');
      (result.hooks[event]??=[]).push({...groups[0],hooks:handlers});
    }
  }
  return result;
}

async function publishConfiguration(path,contents,previous,codexHome){
  let backupDirectory=null;
  if(previous){
    const backupRoot=join(codexHome,'backups');
    const existing=await lstat(backupRoot).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(existing&&(!existing.isDirectory()||existing.isSymbolicLink()))throw new Error('Hook backup root must be a directory, not a symlink.');
    await mkdir(backupRoot,{recursive:true});
    backupDirectory=await mkdtemp(join(backupRoot,'deepseek-task-hook-'));
    await writeFile(join(backupDirectory,'hooks.json'),previous.contents,{flag:'wx',mode:previous.mode&0o777});
  }
  const temporary=join(codexHome,'.hooks.deepseek-'+randomUUID()+'.tmp');
  let file;
  try{
    file=await open(temporary,'wx',previous?previous.mode&0o777:0o600);
    await file.writeFile(contents);
    await file.sync();
    await file.close();file=null;
    const current=await readConfiguration(path,{optional:true});
    if(previous?!current||!current.contents.equals(previous.contents):current!==null)throw new Error('Global hooks changed during registration; retry after reviewing the current file.');
    await rename(temporary,path);
    return backupDirectory;
  }finally{
    if(file)await file.close().catch(()=>{});
    await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
}

export async function registerTaskHooks({codexHome=process.env.CODEX_HOME||join(homedir(),'.codex'),nodeExecutable=process.execPath,remove=false}={}){
  if(typeof codexHome!=='string'||!codexHome)throw new Error('CODEX_HOME must be a nonempty path.');
  if(typeof remove!=='boolean')throw new Error('remove must be a boolean.');
  codexHome=resolve(codexHome);
  const hookConfigPath=join(codexHome,'hooks.json');
  const scriptPath=join(codexHome,'plugins','deepseek-monitor','hooks','task-preflight.mjs');
  const commands=makeTaskHookCommands(nodeExecutable,scriptPath);
  const previous=await readConfiguration(hookConfigPath,{optional:true});
  let template=null;
  if(!remove){
    template=(await readConfiguration(join(codexHome,'plugins','deepseek-monitor','hooks','hooks.json'))).value;
    const script=await lstat(scriptPath);
    if(!script.isFile()||script.isSymbolicLink())throw new Error('Installed task hook script must be a regular file, not a symlink.');
  }
  const value=previous?.value??{hooks:{}};
  const updated=mergeTaskHooks(value,template,commands,scriptPath,remove);
  const changed=JSON.stringify(value)!==JSON.stringify(updated);
  let backupDirectory=null;
  if(changed){
    const contents=Buffer.from(JSON.stringify(updated,null,2)+'\n');
    if(contents.length>MAX_CONFIGURATION_BYTES)throw new Error('Updated hook configuration exceeds the 1 MiB limit.');
    backupDirectory=await publishConfiguration(hookConfigPath,contents,previous,codexHome);
  }
  return {codexHome,hookConfigPath,scriptPath,registered:!remove,changed,backupDirectory,hookTrustRequired:!remove};
}

export async function main(){
  const args=process.argv.slice(2),options={};
  for(let index=0;index<args.length;index++){
    if(args[index]==='--help'){
      console.log('node scripts/register-task-hooks.mjs [--codex-home PATH] [--remove]\nExplicitly register or remove only DeepSeek task preflight handlers in CODEX_HOME/hooks.json; preserve other hooks and back up changes.\nReview the registered hooks in Codex /hooks. Native hook trust is still required; this command does not edit trust, AGENTS.md or config.toml, or call a model.');
      return;
    }
    if(args[index]==='--remove')options.remove=true;
    else if(args[index]==='--codex-home'){
      if(!args[index+1]||args[index+1].startsWith('--'))throw new Error('Missing CODEX_HOME path.');
      options.codexHome=args[++index];
    }else throw new Error('Unknown argument: '+args[index]);
  }
  console.log(JSON.stringify(await registerTaskHooks(options),null,2));
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
