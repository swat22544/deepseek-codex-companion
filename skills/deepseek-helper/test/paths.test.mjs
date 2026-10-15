import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {resolveRuntimePaths, resolveZCodePaths, resolveCodexHome, DEFAULT_HARNESS_HOME, DEFAULT_ZCODE_HOME} from '../scripts/runtime-paths.mjs';

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

test('ZCode resolves installation paths in environment, configuration, default order using the current Node runtime', async () => {
  const configPath=join(fixtureRoot,'zcode.json');
  const configured=join(fixtureRoot,'ZCode 用户'),overridden=join(fixtureRoot,'ZCode override');
  const home=join(fixtureRoot,'user');
  await writeFile(configPath,'\uFEFF'+JSON.stringify({zcodeInstallation:configured}));
  const paths=resolveZCodePaths({env:{},home,configPath});
  assert.deepEqual(paths,{installation:configured,executable:process.execPath,entrypoint:join(configured,'resources','glm','zcode.cjs'),codexHome:join(home,'.codex')});
  const env={DEEPSEEK_ZCODE_HOME:overridden,CODEX_HOME:join(fixtureRoot,'custom Codex')};
  assert.deepEqual(resolveZCodePaths({env,home,configPath}),{installation:overridden,executable:process.execPath,entrypoint:join(overridden,'resources','glm','zcode.cjs'),codexHome:env.CODEX_HOME});
  env.DEEPSEEK_ZCODE_HOME='';
  assert.equal(resolveZCodePaths({env,home,configPath}).installation,configured);
  assert.equal(resolveRuntimePaths({env:{},configPath}).installation,resolve(DEFAULT_HARNESS_HOME));
});

test('ZCode rejects relative paths and invalid settings but an explicit environment override can recover', async () => {
  const configPath=join(fixtureRoot,'zcode-invalid.json');
  for(const body of ['{','null','[]','{}',JSON.stringify({zcodeInstallation:'relative/ZCode'})]){
    await writeFile(configPath,body);
    assert.throws(()=>resolveZCodePaths({env:{},configPath}),/helper\.config\.json/);
  }
  const override=join(fixtureRoot,'ZCode override');
  assert.equal(resolveZCodePaths({env:{DEEPSEEK_ZCODE_HOME:override},configPath}).installation,override);
  assert.throws(()=>resolveZCodePaths({env:{DEEPSEEK_ZCODE_HOME:'relative/ZCode'},configPath}),/absolute/);
});

test('ZCode default does not infer account/data paths', {skip:process.platform!=='win32'}, async () => {
  const paths=resolveZCodePaths({env:{},configPath:absentConfig});
  assert.equal(paths.installation,resolve(DEFAULT_ZCODE_HOME));
  assert.deepEqual(Object.keys(paths).sort(),['codexHome','entrypoint','executable','installation']);
  assert.equal(resolveZCodePaths({env:{},configPath:absentConfig}).installation,resolve(DEFAULT_ZCODE_HOME));
});
