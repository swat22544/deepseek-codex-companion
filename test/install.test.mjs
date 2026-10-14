import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,resolve} from 'node:path';
import {install} from '../scripts/install.mjs';
import {resolveRuntimePaths,resolveOpenCodePaths} from '../skills/deepseek-helper/scripts/runtime-paths.mjs';

test('installer resolves Node, preserves personal marketplace and refuses accidental overwrite',async()=>{
  const root=await mkdtemp(join(tmpdir(),'deepseek-install-test-'));
  try{
    const codexHome=join(root,'codex'),dshHome=join(root,'Harness');
    await mkdir(dshHome,{recursive:true});await writeFile(join(dshHome,'DeepSeek Harness.exe'),'TEST FIXTURE - NEVER EXECUTED');
    await mkdir(join(codexHome,'plugins'),{recursive:true});
    await writeFile(join(codexHome,'plugins','personal-marker'),'preserve');
    const result=await install({codexHome,dshHome,allowNonWindows:true});
    const mcp=JSON.parse(await readFile(join(result.pluginTarget,'mcp.json'),'utf8'));
    assert.equal(mcp.mcpServers['deepseek-monitor'].command,process.execPath);
    assert.equal(mcp.mcpServers['deepseek-monitor'].env.CODEX_HOME,codexHome);
    assert.equal(JSON.parse(await readFile(join(result.skillTarget,'helper.config.json'),'utf8')).installation,dshHome);
    await access(join(result.marketplaceRoot,'plugins','deepseek-monitor','server','mcp.mjs'));
    assert.equal(await readFile(join(codexHome,'plugins','personal-marker'),'utf8'),'preserve');
    await assert.rejects(()=>install({codexHome,allowNonWindows:true}),/Already installed/);
    await writeFile(join(result.skillTarget,'local-note.txt'),'backup me');
    const update=await install({codexHome,overwrite:true,allowNonWindows:true});
    assert.equal(await readFile(join(update.backupDirectory,'deepseek-helper','local-note.txt'),'utf8'),'backup me');
    assert.equal(JSON.parse(await readFile(join(update.skillTarget,'helper.config.json'),'utf8')).installation,dshHome);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('invalid Harness path fails before installing any component',async()=>{
  const root=await mkdtemp(join(tmpdir(),'deepseek-invalid-install-'));
  try{
    const codexHome=join(root,'codex');
    await assert.rejects(()=>install({codexHome,dshHome:root,allowNonWindows:true}),/not found/);
    await assert.rejects(()=>access(codexHome));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('installer preserves both backend paths across partial updates and backs up prior local configuration',async()=>{
  const root=await mkdtemp(join(tmpdir(),'deepseek-dual-install-'));
  try{
    const codexHome=join(root,'codex'),dshHome=join(root,'Harness'),otherDshHome=join(root,'Harness new');
    const opencodeCli=join(root,'opencode-cli.exe'),otherCli=join(root,'opencode-cli-new.exe');
    for(const directory of [dshHome,otherDshHome]){await mkdir(directory);await writeFile(join(directory,'DeepSeek Harness.exe'),'TEST ONLY');}
    for(const path of [opencodeCli,otherCli])await writeFile(path,'TEST ONLY');
    const result=await install({codexHome,dshHome,opencodeCli,allowNonWindows:true});
    const configPath=join(result.skillTarget,'helper.config.json');
    assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')),{installation:dshHome,opencodeExecutable:opencodeCli});
    await writeFile(configPath,JSON.stringify({installation:dshHome,opencodeExecutable:opencodeCli,unknownField:'do not propagate'}));
    const updateHarness=await install({codexHome,dshHome:otherDshHome,overwrite:true,allowNonWindows:true});
    assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')),{installation:otherDshHome,opencodeExecutable:opencodeCli});
    assert.equal(JSON.parse(await readFile(join(updateHarness.backupDirectory,'deepseek-helper','helper.config.json'),'utf8')).installation,dshHome);
    const updateOpenCode=await install({codexHome,opencodeCli:otherCli,overwrite:true,allowNonWindows:true});
    assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')),{installation:otherDshHome,opencodeExecutable:otherCli});
    assert.equal(updateOpenCode.dshHome,otherDshHome);
    assert.equal(updateOpenCode.opencodeExecutable,otherCli);
    const updateNeither=await install({codexHome,overwrite:true,allowNonWindows:true});
    assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')),{installation:otherDshHome,opencodeExecutable:otherCli});
    assert.ok(updateNeither.backupDirectory);
  }finally{
    assert.match(relative(resolve(tmpdir()),resolve(root)),/^deepseek-dual-install-[^\\/]+$/);
    await rm(root,{recursive:true,force:true});
  }
});

test('invalid or directory OpenCode executable is rejected before installation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'deepseek-opencode-invalid-'));
  try{
    const codexHome=join(root,'codex');
    for(const opencodeCli of ['relative.exe',join(root,'missing.exe'),root]){
      await assert.rejects(()=>install({codexHome,opencodeCli,allowNonWindows:true}),/absolute|not found/);
      await assert.rejects(()=>access(codexHome));
    }
  }finally{
    assert.match(relative(resolve(tmpdir()),resolve(root)),/^deepseek-opencode-invalid-[^\\/]+$/);
    await rm(root,{recursive:true,force:true});
  }
});

test('empty or unknown-only saved helper paths fail update before touching installed files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'deepseek-empty-config-'));
  try{
    const codexHome=join(root,'codex');
    const installed=await install({codexHome,allowNonWindows:true});
    const configPath=join(installed.skillTarget,'helper.config.json');
    const pluginMarker=join(installed.pluginTarget,'mcp.json');
    await writeFile(pluginMarker,'unchanged installed marker');
    for(const config of [{},{unknownPath:'unused'}]){
      await writeFile(configPath,JSON.stringify(config));
      await assert.rejects(()=>install({codexHome,overwrite:true,allowNonWindows:true}),/helper\.config\.json must contain an absolute installation or opencodeExecutable path/);
      assert.equal(await readFile(pluginMarker,'utf8'),'unchanged installed marker');
      await assert.rejects(()=>access(join(codexHome,'backups')));
      assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')),config);
    }
  }finally{
    assert.match(relative(resolve(tmpdir()),resolve(root)),/^deepseek-empty-config-[^\\/]+$/);
    await rm(root,{recursive:true,force:true});
  }
});

test('an explicit backend path repairs empty saved config and resolves after installation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'deepseek-config-repair-'));
  try{
    const codexHome=join(root,'codex'),dshHome=join(root,'Harness'),opencodeCli=join(root,'opencode-cli.exe');
    await mkdir(dshHome);await writeFile(join(dshHome,'DeepSeek Harness.exe'),'TEST ONLY');
    await writeFile(opencodeCli,'TEST ONLY');
    const installed=await install({codexHome,allowNonWindows:true});
    const configPath=join(installed.skillTarget,'helper.config.json');
    await writeFile(configPath,'{}');
    await install({codexHome,dshHome,overwrite:true,allowNonWindows:true});
    assert.equal(resolveRuntimePaths({env:{},configPath}).installation,dshHome);
    await writeFile(configPath,JSON.stringify({unknownField:'discard'}));
    await install({codexHome,opencodeCli,overwrite:true,allowNonWindows:true});
    assert.equal(resolveOpenCodePaths({env:{},configPath}).executable,opencodeCli);
    assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')),{opencodeExecutable:opencodeCli});
  }finally{
    assert.match(relative(resolve(tmpdir()),resolve(root)),/^deepseek-config-repair-[^\\/]+$/);
    await rm(root,{recursive:true,force:true});
  }
});
