import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {findTestFiles} from '../scripts/test.mjs';

test('repository test entry runs only formal tests and never candidate artifacts',async()=>{
  const root=await mkdtemp(join(tmpdir(),'companion-test-discovery-'));
  try{
    const directories=['test','skills/deepseek-helper/test','plugins/deepseek-monitor/test'];
    for(const directory of directories){
      const path=join(root,directory);await mkdir(path,{recursive:true});
      await writeFile(join(path,'formal.test.mjs'),"import test from 'node:test'; test('formal fixture',()=>{});\n");
    }
    const work=join(root,'work','deepseek-runs','task-fixture','artifacts'),marker=join(root,'candidate-executed');
    await mkdir(work,{recursive:true});
    await writeFile(join(work,'candidate.test.mjs'),`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'should never execute'); throw new Error('unreviewed candidate');`);
    await writeFile(join(root,'test','ignored.fixture'),'not an executable test');
    const files=await findTestFiles(root);
    assert.equal(files.length,3);
    assert.ok(files.every(path=>!path.includes(join('work','deepseek-runs'))));
    const module=new URL('../scripts/test.mjs',import.meta.url).href;
    const code=`import {runTests} from ${JSON.stringify(module)}; process.exitCode=await runTests({root:${JSON.stringify(root)}});`;
    const env={...process.env};delete env.NODE_TEST_CONTEXT;
    const child=spawnSync(process.execPath,['--input-type=module','-e',code],{env,encoding:'utf8',windowsHide:true,timeout:5000});
    assert.equal(child.error,undefined,child.error?.message);
    assert.equal(child.status,0,child.stderr);
    assert.match(child.stdout,/tests 3/);
    await assert.rejects(()=>access(marker),{code:'ENOENT'});
  }finally{
    assert.match(relative(resolve(tmpdir()),resolve(root)),/^companion-test-discovery-[^\\/]+$/);
    await rm(root,{recursive:true,force:true});
  }
});
