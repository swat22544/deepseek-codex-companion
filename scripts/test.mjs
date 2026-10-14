import {readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const testDirectories=['test','skills/deepseek-helper/test','plugins/deepseek-monitor/test'];

// Node's default recursive discovery also visits ignored candidate artifacts.
// Only the committed test locations may supply executable test files.
export async function findTestFiles(root=repository){
  const files=[];
  for(const directory of testDirectories){
    const path=join(root,directory);
    const entries=await readdir(path,{withFileTypes:true});
    for(const entry of entries)if(entry.isFile()&&entry.name.endsWith('.test.mjs'))files.push(join(path,entry.name));
  }
  return files.sort();
}

export async function runTests({root=repository}={}){
  const files=await findTestFiles(root);
  if(!files.length)throw new Error('No repository tests found');
  return new Promise((resolveExit,reject)=>{
    const child=spawn(process.execPath,['--test',...files],{cwd:root,stdio:'inherit',windowsHide:true});
    child.once('error',reject);
    child.once('exit',(code)=>resolveExit(code??1));
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  runTests().then(code=>{process.exitCode=code;}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
