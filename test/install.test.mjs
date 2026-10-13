import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {install} from '../scripts/install.mjs';

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
