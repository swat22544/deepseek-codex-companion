import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {resolveRuntimePaths, resolveOpenCodePaths, resolveCodexHome, DEFAULT_HARNESS_HOME, DEFAULT_OPENCODE_CLI} from '../scripts/runtime-paths.mjs';

const fixtureRoot=await mkdtemp(join(tmpdir(),'companion-paths-'));
const absentConfig=join(fixtureRoot,'missing.json');
after(async()=>{await rm(fixtureRoot,{recursive:true,force:true});});

test('default roots retain the existing Windows install and per-user data locations', () => {
  const home=join(tmpdir(),'companion-path-test-user');
  const paths=resolveRuntimePaths({env:{},home,configPath:absentConfig});
  assert.equal(paths.installation,resolve(DEFAULT_HARNESS_HOME));
  assert.equal(paths.executable,join(resolve(DEFAULT_HARNESS_HOME),'DeepSeek Harness.exe'));
  assert.equal(paths.codexHome,join(home,'.codex'));
  assert.equal(paths.dshHome,join(home,'.dsh'));
});

test('explicit portable paths take precedence, including spaces and Unicode', () => {
  const root=join(tmpdir(),'companion paths 用户');
  const env={DEEPSEEK_HARNESS_HOME:join(root,'Harness'),CODEX_HOME:join(root,'Codex'),DSH_HOME:join(root,'DSH')};
  const paths=resolveRuntimePaths({env,home:join(root,'unused'),configPath:absentConfig});
  assert.equal(paths.installation,env.DEEPSEEK_HARNESS_HOME);
  assert.equal(paths.executable,join(env.DEEPSEEK_HARNESS_HOME,'DeepSeek Harness.exe'));
  assert.equal(paths.entrypoint,join(env.DEEPSEEK_HARNESS_HOME,'resources','app.asar','dsh','node_modules','@deepseek-ai','dsh-desktop-host','lib','cli.js'));
  assert.equal(paths.codexHome,env.CODEX_HOME);
  assert.equal(paths.dshHome,env.DSH_HOME);
});

test('overrides are resolved on each invocation; empty variables use defaults', () => {
  const home=join(tmpdir(),'companion-path-test-user');
  const env={DEEPSEEK_HARNESS_HOME:'',CODEX_HOME:'',DSH_HOME:''};
  const initial=resolveRuntimePaths({env,home,configPath:absentConfig});
  env.DEEPSEEK_HARNESS_HOME=join(home,'second install');
  env.CODEX_HOME=join(home,'second codex');
  const changed=resolveRuntimePaths({env,home,configPath:absentConfig});
  assert.notEqual(changed.installation,initial.installation);
  assert.equal(changed.codexHome,env.CODEX_HOME);
  assert.equal(initial.codexHome,join(home,'.codex'));
});

test('skill-local install setting is used unless the environment overrides it', async () => {
  const configPath=join(fixtureRoot,'installed.json');
  const installation=join(fixtureRoot,'configured Harness');
  await writeFile(configPath,'\uFEFF'+JSON.stringify({installation}));
  assert.equal(resolveRuntimePaths({env:{},configPath}).installation,installation);
  const override=join(fixtureRoot,'override Harness');
  assert.equal(resolveRuntimePaths({env:{DEEPSEEK_HARNESS_HOME:override},configPath}).installation,override);
});

test('invalid config fails closed but an explicit install override can recover', async () => {
  const configPath=join(fixtureRoot,'invalid.json');
  for (const body of ['{', 'null', '[]', '{}', JSON.stringify({installation:'relative/Harness'})]) {
    await writeFile(configPath,body);
    assert.throws(()=>resolveRuntimePaths({env:{},configPath}),/helper\.config\.json/);
  }
  const override=join(fixtureRoot,'override Harness');
  assert.equal(resolveRuntimePaths({env:{DEEPSEEK_HARNESS_HOME:override},configPath}).installation,override);
  // Monitor storage does not depend on the Harness installation configuration.
  const codexHome=join(fixtureRoot,'Codex');
  assert.equal(resolveCodexHome({env:{CODEX_HOME:codexHome}}),codexHome);
});

test('OpenCode path resolves config and per-call environment without reading provider credentials', async () => {
  const configPath=join(fixtureRoot,'opencode.json');
  const configured=join(fixtureRoot,'OpenCode 用户','opencode-cli.exe');
  const overridden=join(fixtureRoot,'OpenCode override','opencode-cli.exe');
  await writeFile(configPath,JSON.stringify({opencodeExecutable:configured}));
  assert.equal(resolveOpenCodePaths({env:{},configPath}).executable,configured);
  assert.equal(resolveRuntimePaths({env:{},configPath}).installation,resolve(DEFAULT_HARNESS_HOME));
  const env={DEEPSEEK_OPENCODE_CLI:overridden,CODEX_HOME:join(fixtureRoot,'codex')};
  assert.deepEqual(resolveOpenCodePaths({env,configPath}),{executable:overridden,codexHome:env.CODEX_HOME});
  env.DEEPSEEK_OPENCODE_CLI='';
  assert.equal(resolveOpenCodePaths({env,configPath}).executable,configured);
  env.DEEPSEEK_OPENCODE_CLI='../relative.exe';
  assert.throws(()=>resolveOpenCodePaths({env,configPath}),/absolute/);
  await writeFile(configPath,JSON.stringify({opencodeExecutable:'relative.exe'}));
  assert.throws(()=>resolveOpenCodePaths({env:{},configPath}),/helper\.config\.json/);
  assert.equal(resolveOpenCodePaths({env:{DEEPSEEK_OPENCODE_CLI:overridden},configPath}).executable,overridden);
});

test('OpenCode uses the Windows desktop CLI default when neither local nor environment path is set', {skip:process.platform!=='win32'}, () => {
  assert.equal(resolveOpenCodePaths({env:{},configPath:absentConfig}).executable,resolve(DEFAULT_OPENCODE_CLI));
});
