import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,link,copyFile,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve,relative,sep,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execute=promisify(execFile);
const delegatePath=fileURLToPath(new URL('../scripts/delegate.mjs',import.meta.url));
const fixturePath=fileURLToPath(new URL('./fixtures/timeout-harness.cjs.fixture',import.meta.url));

test('runner distinguishes total and idle budgets without weakening fixed model checks',{skip:process.platform!=='win32'},async t=>{
  const base=await mkdtemp(join(tmpdir(),'deepseek-runner-timeout-test-'));
  t.after(async()=>{
    // Only remove the freshly allocated, resolved test directory.
    const child=relative(resolve(tmpdir()),resolve(base));
    assert.ok(child.startsWith('deepseek-runner-timeout-test-')&&!child.includes(sep)&&!child.includes('..'));
    await rm(base,{recursive:true,force:true});
  });
  const installation=join(base,'harness');
  const entry=join(installation,'resources','app.asar','dsh','node_modules','@deepseek-ai','dsh-desktop-host','lib','cli.js');
  await mkdir(dirname(entry),{recursive:true});
  const executable=join(installation,'DeepSeek Harness.exe');
  try{await link(process.execPath,executable);}catch{await copyFile(process.execPath,executable);}
  await copyFile(fixturePath,entry);
  const env={...process.env,DEEPSEEK_HARNESS_HOME:installation,DSH_HOME:join(base,'dsh'),CODEX_HOME:join(base,'codex')};
  async function invoke(scenario,budgets){
    const request=join(base,scenario+'.request.json'),result=join(base,scenario+'.result.json');
    await writeFile(request,JSON.stringify({taskType:'analyze',instruction:'Fixture test.',input:'',...budgets}));
    const started=Date.now();let exitCode=0;
    try{await execute(process.execPath,[delegatePath,request,result],{env:{...env,HELPER_TEST_SCENARIO:scenario},cwd:base,windowsHide:true,timeout:15000,maxBuffer:1024*1024});}
    catch(error){exitCode=error.code;assert.notEqual(error.killed,true,'runner must terminate its own fake child');}
    return {result:JSON.parse(await readFile(result,'utf8')),exitCode,started};
  }
  await t.test('continuous real progress never extends total budget',async()=>{
    const {result,exitCode}=await invoke('total',{totalTimeoutMs:1600,idleTimeoutMs:1000});
    assert.equal(exitCode,1);assert.equal(result.timeout.kind,'total');assert.equal(result.timeout.limitMs,1600);
    assert.equal(result.timeout.lastProgressKind,'model_output');assert.match(result.error,/总任务时限/);
    assert.equal(result.cleanup.incomplete,false);assert.ok(result.timeout.idleElapsedMs<1000);
  });
  await t.test('empty delta and monitor heartbeat do not reset idle budget',async()=>{
    const {result,exitCode}=await invoke('idle',{totalTimeoutMs:4000,idleTimeoutMs:1000});
    assert.equal(exitCode,1);assert.equal(result.timeout.kind,'idle');assert.equal(result.timeout.limitMs,1000);
    assert.match(result.error,/未收到可确认/);assert.equal(result.timeout.lastProgressKind,'model_start');
    assert.equal(result.cleanup.incomplete,false);
  });
  await t.test('model mismatch fails before accepting output progress',async()=>{
    const {result,exitCode}=await invoke('wrong-model',{totalTimeoutMs:4000,idleTimeoutMs:1000});
    assert.equal(exitCode,1);assert.equal(result.modelSelectionVerified,false);
    assert.match(result.error,/Unexpected model selection/);assert.equal(result.timeout,null);
    assert.equal(result.timing.lastProgressKind,null);assert.equal(result.cleanup.incomplete,false);
  });
  await t.test('a large task can be assigned more than ten minutes with matching tool deadline',async()=>{
    const {result,exitCode,started}=await invoke('success',{taskSize:'large'});
    assert.equal(exitCode,0);assert.equal(result.ok,true);assert.equal(result.timeout,null);
    assert.equal(result.timing.totalTimeoutMs,2700000);assert.equal(result.timing.idleTimeoutMs,600000);
    const {deadline}=JSON.parse(result.final.text);
    assert.ok(deadline>=started+2700000);assert.ok(deadline<started+2705000);
  });
});
