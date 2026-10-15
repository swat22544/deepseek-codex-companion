import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm,rmdir,access,symlink,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {install,makeTaskHookCommands} from '../scripts/install.mjs';
import {resolveRuntimePaths,resolveZCodePaths} from '../skills/deepseek-helper/scripts/runtime-paths.mjs';

const sourceHookPath=fileURLToPath(new URL('../plugins/deepseek-monitor/hooks/hooks.json',import.meta.url));
const makeZCode=async root=>{
  await mkdir(join(root,'resources','glm'),{recursive:true});
  await writeFile(join(root,'ZCode.exe'),'TEST FIXTURE - NEVER EXECUTED');
  await writeFile(join(root,'resources','glm','zcode.cjs'),'TEST FIXTURE - NEVER EXECUTED');
};
const withoutCommands=value=>{
  if(Array.isArray(value))return value.map(withoutCommands);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['command','commandWindows'].includes(key)).map(([key,item])=>[key,withoutCommands(item)]));
  return value;
};

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
    const zcodeHome=join(root,'ZCode 用户'),otherZcodeHome=join(root,'ZCode new');
    for(const directory of [dshHome,otherDshHome]){await mkdir(directory);await writeFile(join(directory,'DeepSeek Harness.exe'),'TEST ONLY');}
    for(const path of [zcodeHome,otherZcodeHome])await makeZCode(path);
    const result=await install({codexHome,dshHome,zcodeHome,allowNonWindows:true});
    const configPath=join(result.skillTarget,'helper.config.json');
    assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')),{installation:dshHome,zcodeInstallation:zcodeHome});
    await writeFile(configPath,JSON.stringify({installation:dshHome,zcodeInstallation:zcodeHome,unknownField:'do not propagate'}));
    const updateHarness=await install({codexHome,dshHome:otherDshHome,overwrite:true,allowNonWindows:true});
    assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')),{installation:otherDshHome,zcodeInstallation:zcodeHome});
    assert.equal(JSON.parse(await readFile(join(updateHarness.backupDirectory,'deepseek-helper','helper.config.json'),'utf8')).installation,dshHome);
    const updateZCode=await install({codexHome,zcodeHome:otherZcodeHome,overwrite:true,allowNonWindows:true});
    assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')),{installation:otherDshHome,zcodeInstallation:otherZcodeHome});
    assert.equal(updateZCode.dshHome,otherDshHome);
    assert.equal(updateZCode.zcodeInstallation,otherZcodeHome);
    const updateNeither=await install({codexHome,overwrite:true,allowNonWindows:true});
    assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')),{installation:otherDshHome,zcodeInstallation:otherZcodeHome});
    assert.ok(updateNeither.backupDirectory);
  }finally{
    assert.match(relative(resolve(tmpdir()),resolve(root)),/^deepseek-dual-install-[^\\/]+$/);
    await rm(root,{recursive:true,force:true});
  }
});

test('invalid ZCode root or non-file CLI components are rejected before installation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'deepseek-zcode-invalid-'));
  try{
    const codexHome=join(root,'codex');
    for(const zcodeHome of ['relative',join(root,'missing'),root]){
      await assert.rejects(()=>install({codexHome,zcodeHome,allowNonWindows:true}),/absolute|not found/);
      await assert.rejects(()=>access(codexHome));
    }
    const zcodeHome=join(root,'ZCode');
    await mkdir(join(zcodeHome,'ZCode.exe'),{recursive:true});
    await assert.rejects(()=>install({codexHome,zcodeHome,allowNonWindows:true}),/ZCode\.exe.*file/);
    await rmdir(join(zcodeHome,'ZCode.exe'));await writeFile(join(zcodeHome,'ZCode.exe'),'TEST ONLY');
    await mkdir(join(zcodeHome,'resources','glm','zcode.cjs'),{recursive:true});
    await assert.rejects(()=>install({codexHome,zcodeHome,allowNonWindows:true}),/zcode\.cjs.*file/);
    await assert.rejects(()=>access(codexHome));
  }finally{
    assert.match(relative(resolve(tmpdir()),resolve(root)),/^deepseek-zcode-invalid-[^\\/]+$/);
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
      await assert.rejects(()=>install({codexHome,overwrite:true,allowNonWindows:true}),/helper\.config\.json must contain an absolute installation/);
      assert.equal(await readFile(pluginMarker,'utf8'),'unchanged installed marker');
      await assert.rejects(()=>access(join(codexHome,'backups')));
      assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')),config);
    }
  }finally{
    assert.match(relative(resolve(tmpdir()),resolve(root)),/^deepseek-empty-config-[^\\/]+$/);
    await rm(root,{recursive:true,force:true});
  }
});

test('ZCode migration discards unknown saved fields while preserving Harness, backup and unrelated application data',async()=>{
  const root=await mkdtemp(join(tmpdir(),'deepseek-zcode-migration-'));
  try{
    const codexHome=join(root,'codex'),dshHome=join(root,'Harness'),zcodeHome=join(root,'ZCode');
    const oldApp=join(root,'UnrelatedApp'),oldExecutable=join(oldApp,'app.exe');
    await mkdir(dshHome);await writeFile(join(dshHome,'DeepSeek Harness.exe'),'TEST ONLY');
    await makeZCode(zcodeHome);await mkdir(oldApp);await writeFile(oldExecutable,'PRESERVE APPLICATION');
    await writeFile(join(oldApp,'account-data'),'PRESERVE ACCOUNT DATA');
    const installed=await install({codexHome,dshHome,allowNonWindows:true});
    const configPath=join(installed.skillTarget,'helper.config.json');
    const previous={installation:dshHome,unrelatedExecutable:oldExecutable,unknownField:'discard'};
    await writeFile(configPath,JSON.stringify(previous));
    const migrated=await install({codexHome,zcodeHome,overwrite:true,allowNonWindows:true});
    assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')),{installation:dshHome,zcodeInstallation:zcodeHome});
    assert.deepEqual(JSON.parse(await readFile(join(migrated.backupDirectory,'deepseek-helper','helper.config.json'),'utf8')),previous);
    assert.equal(await readFile(oldExecutable,'utf8'),'PRESERVE APPLICATION');
    assert.equal(await readFile(join(oldApp,'account-data'),'utf8'),'PRESERVE ACCOUNT DATA');
    assert.equal(Object.hasOwn(migrated,'unrelatedExecutable'),false);
  }finally{
    assert.match(relative(resolve(tmpdir()),resolve(root)),/^deepseek-zcode-migration-[^\\/]+$/);
    await rm(root,{recursive:true,force:true});
  }
});

test('failed ZCode migration leaves installed files and saved paths untouched',async()=>{
  const root=await mkdtemp(join(tmpdir(),'deepseek-zcode-failed-migration-'));
  try{
    const codexHome=join(root,'codex');
    const installed=await install({codexHome,allowNonWindows:true});
    const configPath=join(installed.skillTarget,'helper.config.json');
    const saved=JSON.stringify({unknownExecutable:join(root,'prior-app.exe')});
    await writeFile(configPath,saved);
    const marker=join(installed.pluginTarget,'mcp.json');await writeFile(marker,'PRESERVE INSTALLED PLUGIN');
    for(const options of [{zcodeHome:root},{}]){
      await assert.rejects(()=>install({codexHome,...options,overwrite:true,allowNonWindows:true}),/not found|helper\.config\.json/);
      assert.equal(await readFile(configPath,'utf8'),saved);
      assert.equal(await readFile(marker,'utf8'),'PRESERVE INSTALLED PLUGIN');
      await assert.rejects(()=>access(join(codexHome,'backups')));
    }
  }finally{
    assert.match(relative(resolve(tmpdir()),resolve(root)),/^deepseek-zcode-failed-migration-[^\\/]+$/);
    await rm(root,{recursive:true,force:true});
  }
});

test('an explicit backend path repairs empty saved config and resolves after installation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'deepseek-config-repair-'));
  try{
    const codexHome=join(root,'codex'),dshHome=join(root,'Harness'),zcodeHome=join(root,'ZCode');
    await mkdir(dshHome);await writeFile(join(dshHome,'DeepSeek Harness.exe'),'TEST ONLY');
    await makeZCode(zcodeHome);
    const installed=await install({codexHome,allowNonWindows:true});
    const configPath=join(installed.skillTarget,'helper.config.json');
    await writeFile(configPath,'{}');
    await install({codexHome,dshHome,overwrite:true,allowNonWindows:true});
    assert.equal(resolveRuntimePaths({env:{},configPath}).installation,dshHome);
    await writeFile(configPath,JSON.stringify({unknownField:'discard'}));
    await install({codexHome,zcodeHome,overwrite:true,allowNonWindows:true});
    assert.equal(resolveZCodePaths({env:{},configPath}).installation,zcodeHome);
    assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')),{zcodeInstallation:zcodeHome});
  }finally{
    assert.match(relative(resolve(tmpdir()),resolve(root)),/^deepseek-config-repair-[^\\/]+$/);
    await rm(root,{recursive:true,force:true});
  }
});

test('installer includes plugin task hooks for a custom root and leaves global hooks and trust untouched',async()=>{
  const root=await mkdtemp(join(tmpdir(),'deepseek-hook-install-'));
  try{
    const codexHome=join(root,'Codex 自定义 root');
    const preserved=new Map([
      [join(codexHome,'hooks.json'),'{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"external-hook"}]}]}}\n'],
      [join(codexHome,'AGENTS.md'),'# Personal instructions\nPreserve this file.\n'],
      [join(codexHome,'config.toml'),'# Personal configuration and trust settings\nmodel = "personal-model"\n'],
      [join(codexHome,'plugins','other-plugin','hooks','hooks.json'),'{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"other-plugin-hook"}]}]}}\n']
    ]);
    for(const [path,contents] of preserved){await mkdir(dirname(path),{recursive:true});await writeFile(path,contents);}
    const installed=await install({codexHome,allowNonWindows:true});
    assert.equal(installed.hooksIncluded,true);
    assert.equal(installed.hookTrustRequired,true);
    assert.equal(installed.hookConfigPath,join(installed.pluginTarget,'hooks','hooks.json'));
    assert.equal(installed.hookRuntimePath,join(installed.pluginTarget,'hooks','runtime.json'));
    assert.deepEqual(JSON.parse(await readFile(installed.hookRuntimePath,'utf8')),{codexHome});
    const sourceHooks=JSON.parse(await readFile(sourceHookPath,'utf8'));
    const installedHooks=JSON.parse(await readFile(installed.hookConfigPath,'utf8'));
    assert.deepEqual(withoutCommands(installedHooks),withoutCommands(sourceHooks));
    assert.deepEqual(Object.keys(installedHooks.hooks).sort(),['SessionStart','UserPromptSubmit']);
    for(const groups of Object.values(installedHooks.hooks))for(const group of groups)for(const hook of group.hooks){
      assert.equal(hook.type,'command');
      assert.equal(hook.command,"'"+process.execPath.replaceAll("'","'\"'\"'")+"' \"${PLUGIN_ROOT}/hooks/task-preflight.mjs\"");
      assert.match(hook.commandWindows,/^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
      const script=Buffer.from(hook.commandWindows.split(' ').at(-1),'base64').toString('utf16le');
      assert.ok(script.includes('[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)'));
      assert.ok(script.includes('[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)'));
      assert.ok(script.includes('$OutputEncoding=[Console]::OutputEncoding'));
      assert.ok(script.includes("& '"+process.execPath.replaceAll("'","''")+"' (Join-Path $env:PLUGIN_ROOT 'hooks/task-preflight.mjs')"));
      assert.ok(script.endsWith('exit $LASTEXITCODE'));
    }
    await access(join(installed.pluginTarget,'hooks','task-preflight.mjs'));
    const marketplaceHook=join(installed.marketplaceRoot,'plugins','deepseek-monitor','hooks');
    assert.equal(await readFile(join(marketplaceHook,'hooks.json'),'utf8'),await readFile(installed.hookConfigPath,'utf8'));
    assert.deepEqual(JSON.parse(await readFile(join(marketplaceHook,'runtime.json'),'utf8')),{codexHome});
    await access(join(marketplaceHook,'task-preflight.mjs'));
    for(const [path,contents] of preserved)assert.equal(await readFile(path,'utf8'),contents);
  }finally{
    assert.match(relative(resolve(tmpdir()),resolve(root)),/^deepseek-hook-install-[^\\/]+$/);
    await rm(root,{recursive:true,force:true});
  }
});

test('task hook commands quote Node paths while allowing only plugin-root expansion',()=>{
  const nodePath=join(tmpdir(),"Node it's 中文",'node.exe');
  const commands=makeTaskHookCommands(nodePath);
  assert.ok(commands.command.includes("Node it'\"'\"'s 中文"));
  assert.ok(commands.command.endsWith(' "${PLUGIN_ROOT}/hooks/task-preflight.mjs"'));
  const script=Buffer.from(commands.commandWindows.split(' ').at(-1),'base64').toString('utf16le');
  assert.ok(script.includes("Node it''s 中文"));
  assert.ok(script.includes("(Join-Path $env:PLUGIN_ROOT 'hooks/task-preflight.mjs')"));
  assert.ok(script.endsWith('exit $LASTEXITCODE'));
  assert.throws(()=>makeTaskHookCommands('relative-node'),/absolute path/);
});

test('hook update backs up prior owned files and refreshes additional plugin files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'deepseek-hook-update-'));
  try{
    const codexHome=join(root,'codex');
    const installed=await install({codexHome,allowNonWindows:true});
    const priorHook='{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"prior-install-hook"}]}]}}\n';
    const priorRuntime='{"codexHome":"prior-runtime-root"}\n';
    await writeFile(installed.hookConfigPath,priorHook);
    await writeFile(installed.hookRuntimePath,priorRuntime);
    await writeFile(join(installed.pluginTarget,'hooks','local-note.txt'),'keep this local note');
    const updated=await install({codexHome,overwrite:true,allowNonWindows:true});
    const backupHooks=join(updated.backupDirectory,'deepseek-monitor','hooks');
    assert.equal(await readFile(join(backupHooks,'hooks.json'),'utf8'),priorHook);
    assert.equal(await readFile(join(backupHooks,'runtime.json'),'utf8'),priorRuntime);
    assert.equal(await readFile(join(backupHooks,'local-note.txt'),'utf8'),'keep this local note');
    await assert.rejects(()=>access(join(updated.pluginTarget,'hooks','local-note.txt')));
    await assert.rejects(()=>access(join(updated.marketplaceRoot,'plugins','deepseek-monitor','hooks','local-note.txt')));
    assert.notEqual(await readFile(updated.hookConfigPath,'utf8'),priorHook);
    assert.deepEqual(JSON.parse(await readFile(updated.hookRuntimePath,'utf8')),{codexHome});
  }finally{
    assert.match(relative(resolve(tmpdir()),resolve(root)),/^deepseek-hook-update-[^\\/]+$/);
    await rm(root,{recursive:true,force:true});
  }
});

test('overwrite removes retired adapters from owned components and marketplace while retaining config, backup and global data',async()=>{
  const root=await mkdtemp(join(tmpdir(),'deepseek-refresh-install-'));
  try{
    const codexHome=join(root,'codex'),dshHome=join(root,'Harness'),zcodeHome=join(root,'ZCode');
    await mkdir(dshHome);await writeFile(join(dshHome,'DeepSeek Harness.exe'),'TEST ONLY');await makeZCode(zcodeHome);
    const installed=await install({codexHome,dshHome,zcodeHome,allowNonWindows:true});
    const retiredSkill=join(installed.skillTarget,'scripts','retired-adapter.mjs');
    const retiredPlugin=join(installed.pluginTarget,'server','retired-adapter.mjs');
    const retiredMarketplace=join(installed.marketplaceRoot,'plugins','deepseek-monitor','server','retired-adapter.mjs');
    const componentRoots=[installed.pluginTarget,installed.skillTarget,join(installed.marketplaceRoot,'plugins','deepseek-monitor')];
    const rootIdentities=await Promise.all(componentRoots.map(async path=>{const info=await stat(path);return {ino:info.ino,dev:info.dev};}));
    for(const path of [retiredSkill,retiredPlugin,retiredMarketplace])await writeFile(path,'RETIRED FIXTURE - NEVER EXECUTED');
    const globalHook=join(codexHome,'hooks.json'),userData=join(codexHome,'deepseek-monitor','user-record.json');
    await writeFile(globalHook,'PRESERVE GLOBAL HOOK');await mkdir(dirname(userData),{recursive:true});await writeFile(userData,'PRESERVE USER DATA');
    const updated=await install({codexHome,overwrite:true,allowNonWindows:true});
    for(const [index,path] of componentRoots.entries()){
      const info=await stat(path);assert.equal(info.isDirectory(),true);
      assert.deepEqual({ino:info.ino,dev:info.dev},rootIdentities[index],'The component root remains the same directory after refresh');
    }
    for(const path of [retiredSkill,retiredPlugin,retiredMarketplace])await assert.rejects(()=>access(path));
    for(const path of [join(updated.backupDirectory,'deepseek-helper','scripts','retired-adapter.mjs'),join(updated.backupDirectory,'deepseek-monitor','server','retired-adapter.mjs')])assert.equal(await readFile(path,'utf8'),'RETIRED FIXTURE - NEVER EXECUTED');
    assert.deepEqual(JSON.parse(await readFile(join(updated.skillTarget,'helper.config.json'),'utf8')),{installation:dshHome,zcodeInstallation:zcodeHome});
    assert.equal(await readFile(globalHook,'utf8'),'PRESERVE GLOBAL HOOK');assert.equal(await readFile(userData,'utf8'),'PRESERVE USER DATA');
    await access(join(updated.skillTarget,'scripts','delegate.mjs'));await access(join(updated.pluginTarget,'hooks','task-preflight.mjs'));
  }finally{
    assert.match(relative(resolve(tmpdir()),resolve(root)),/^deepseek-refresh-install-[^\\/]+$/);
    await rm(root,{recursive:true,force:true});
  }
});

test('installer refuses replacement through a redirected component parent before touching external files',async t=>{
  const root=await mkdtemp(join(tmpdir(),'deepseek-redirected-install-'));
  try{
    const codexHome=join(root,'codex'),outside=join(root,'outside');
    await mkdir(codexHome);await mkdir(outside);await writeFile(join(outside,'preserved.txt'),'PRESERVE OUTSIDE');
    try{await symlink(outside,join(codexHome,'plugins'),process.platform==='win32'?'junction':'dir');}
    catch(error){if(['EPERM','EACCES','ENOSYS'].includes(error.code))return t.skip('This host does not permit directory links');throw error;}
    await assert.rejects(()=>install({codexHome,overwrite:true,allowNonWindows:true}),/real directories/);
    assert.equal(await readFile(join(outside,'preserved.txt'),'utf8'),'PRESERVE OUTSIDE');
    await assert.rejects(()=>access(join(codexHome,'backups')));
  }finally{
    assert.match(relative(resolve(tmpdir()),resolve(root)),/^deepseek-redirected-install-[^\\/]+$/);
    await rm(root,{recursive:true,force:true});
  }
});
