import {lstat,open} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const MAX_INPUT_BYTES=1024*1024;
export const MAX_SKILL_BYTES=32*1024;
export const MAX_OUTPUT_BYTES=256*1024;
const events=new Set(['UserPromptSubmit','SessionStart']);
const runtimePath=new URL('./runtime.json',import.meta.url);
const error=(code)=>Object.assign(new Error(code),{hookCode:code});

async function readText(path,limit){
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink())throw error('INVALID_FILE');
  if(info.size>limit)throw error('FILE_TOO_LARGE');
  const file=await open(path,'r');
  try{
    const buffer=Buffer.alloc(limit+1);
    let length=0;
    while(length<buffer.length){
      const {bytesRead}=await file.read(buffer,length,buffer.length-length,null);
      if(!bytesRead)break;
      length+=bytesRead;
    }
    if(length>limit)throw error('FILE_TOO_LARGE');
    try{return new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length));}
    catch{throw error('INVALID_UTF8');}
  }finally{await file.close();}
}

async function readEvent(stdin){
  const chunks=[];let bytes=0;
  for await(const chunk of stdin){
    const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    bytes+=buffer.length;
    if(bytes>MAX_INPUT_BYTES)throw error('INPUT_TOO_LARGE');
    chunks.push(buffer);
  }
  try{
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)).replace(/^\uFEFF/,''));
    if(!value||typeof value!=='object'||Array.isArray(value))throw error('INVALID_INPUT');
    return value;
  }catch(e){throw e.hookCode?e:error('INVALID_INPUT');}
}

async function skillPathFor({env,home}){
  let codexHome=env.CODEX_HOME;
  if(!codexHome){
    let configured;
    try{configured=JSON.parse(await readText(runtimePath,4096));}
    catch(e){if(e.code!=='ENOENT')throw error('INVALID_RUNTIME');}
    if(configured!==undefined){
      if(!configured||typeof configured!=='object'||Array.isArray(configured)||typeof configured.codexHome!=='string')throw error('INVALID_RUNTIME');
      codexHome=configured.codexHome;
    }else codexHome=join(home,'.codex');
  }
  if(typeof codexHome!=='string'||!isAbsolute(codexHome))throw error('INVALID_RUNTIME');
  return join(resolve(codexHome),'skills','deepseek-helper','SKILL.md');
}

function emit(stdout,value){
  const output=JSON.stringify(value)+'\n';
  if(Buffer.byteLength(output)>MAX_OUTPUT_BYTES)throw error('OUTPUT_TOO_LARGE');
  stdout.write(output);
}

export async function runHook({stdin=process.stdin,stdout=process.stdout,env=process.env,home=homedir()}={}){
  let event;
  try{
    // Only the event name is used. Prompt, cwd, transcript and identity fields
    // never choose files, enter output or reach a model/backend from this hook.
    event=(await readEvent(stdin)).hook_event_name;
    if(!events.has(event))return {loaded:false,skipped:true};
    const path=await skillPathFor({env,home});
    const text=(await readText(path,MAX_SKILL_BYTES)).replace(/^\uFEFF/,'');
    const frontmatter=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    const names=frontmatter?.[1].split(/\r?\n/).filter(line=>/^name:/.test(line))??[];
    if(names.length!==1||!/^name:[ \t]*(?:deepseek-helper|"deepseek-helper"|'deepseek-helper')[ \t]*$/.test(names[0])||text.includes('\0'))throw error('INVALID_SKILL');
    const context=`本次任务先应用下方已由 Hook 读取的 deepseek-helper 完整技能，不再依赖名称与描述筛选。按技能判断是否存在值得委派、材料充分且可独立核验的工作包；简单任务可以不派遣。后端分工、权限、预算、持续协作与验收均依照正文及当前用户授权和宿主指令。Hook 仅加载规则，未调用 DeepSeek，也未把用户输入交给外部服务。\n\n技能来源：${path}\n\n${text}`;
    emit(stdout,{hookSpecificOutput:{hookEventName:event,additionalContext:context}});
    return {loaded:true,event};
  }catch(e){
    const code=e.hookCode??(e.code==='ENOENT'?'SKILL_MISSING':'READ_FAILED');
    const message=`DEEPSEEK_HOOK_${code}: 协作技能未完整加载，请检查安装和 Hook 配置；不要声称已加载。`;
    const output={systemMessage:message};
    if(events.has(event))output.hookSpecificOutput={hookEventName:event,additionalContext:message+' 主代理仍按当前用户指令继续可完成的工作；外部委派前先恢复并读取完整 deepseek-helper。'};
    emit(stdout,output);
    return {loaded:false,reason:code};
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  runHook().catch(()=>{process.stderr.write('DEEPSEEK_HOOK_OUTPUT_FAILED\n');process.exitCode=1;});
}
