import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,access,lstat,symlink,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,resolve} from 'node:path';
import {registerTaskHooks} from '../scripts/register-task-hooks.mjs';
import {makeTaskHookCommands} from '../scripts/install.mjs';

const template={
  description:'Fixture task preflight',
  hooks:{
    UserPromptSubmit:[{hooks:[{type:'command',command:'source-only',commandWindows:'source-only',timeout:5,additionalContextLimit:0,statusMessage:'加载规则'}]}],
    SessionStart:[{matcher:'^(resume|compact|fork)$',hooks:[{type:'command',command:'source-only',commandWindows:'source-only',timeout:5,additionalContextLimit:0,statusMessage:'恢复规则'}]}],
    Stop:[{hooks:[{type:'command',command:'do-not-copy-this-event'}]}]
  }
};

async function fixture(run,{name="Codex it's 中文 root"}={}){
  const root=await mkdtemp(join(tmpdir(),'deepseek-hook-registration-'));
  try{
    const codexHome=join(root,name),directory=join(codexHome,'plugins','deepseek-monitor','hooks');
    await mkdir(directory,{recursive:true});
    await writeFile(join(directory,'hooks.json'),JSON.stringify(template));
    await writeFile(join(directory,'task-preflight.mjs'),'// Public fixture only; never executed.\n');
    await run({root,codexHome,directory,hookPath:join(codexHome,'hooks.json'),scriptPath:join(directory,'task-preflight.mjs')});
  }finally{
    assert.match(relative(resolve(tmpdir()),resolve(root)),/^deepseek-hook-registration-[^\\/]+$/);
    await rm(root,{recursive:true,force:true});
  }
}

async function backups(codexHome){
  try{return await readdir(join(codexHome,'backups'));}
  catch(error){if(error.code==='ENOENT')return [];throw error;}
}
const handlers=(value,event)=>value.hooks[event].flatMap(group=>group.hooks);

test('explicit registration creates two absolute task hooks without copying other template events',async()=>{
  await fixture(async({codexHome,hookPath,scriptPath})=>{
    const result=await registerTaskHooks({codexHome});
    assert.equal(result.changed,true);
    assert.equal(result.registered,true);
    assert.equal(result.hookTrustRequired,true);
    assert.equal(result.backupDirectory,null);
    assert.equal(result.scriptPath,scriptPath);
    const installed=JSON.parse(await readFile(hookPath,'utf8'));
    assert.deepEqual(Object.keys(installed.hooks),['UserPromptSubmit','SessionStart']);
    const expected=makeTaskHookCommands(process.execPath,scriptPath);
    for(const event of Object.keys(installed.hooks)){
      assert.equal(installed.hooks[event].length,1);
      assert.deepEqual(installed.hooks[event][0],{
        ...template.hooks[event][0],
        hooks:template.hooks[event][0].hooks.map(handler=>({...handler,...expected}))
      });
      assert.ok(!expected.command.includes('$'+'{PLUGIN_ROOT}'));
      const decoded=Buffer.from(expected.commandWindows.split(' ').at(-1),'base64').toString('utf16le');
      assert.ok(!decoded.includes('$env:PLUGIN_ROOT'));
      assert.ok(decoded.includes("$ProgressPreference='SilentlyContinue'"));
      assert.ok(decoded.includes('[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)'));
      assert.ok(decoded.includes('[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)'));
      assert.ok(decoded.includes("$OutputEncoding=[Console]::OutputEncoding"));
      assert.ok(decoded.includes("Codex it''s 中文 root"));
      assert.ok(decoded.endsWith('exit $LASTEXITCODE'));
    }
    assert.deepEqual(await backups(codexHome),[]);
  });
});

test('existing external groups and top-level fields survive and the exact original bytes are backed up',async()=>{
  await fixture(async({codexHome,hookPath})=>{
    const original={
      personal:{preserve:'all fields'},
      hooks:{
        UserPromptSubmit:[{matcher:'external',custom:7,hooks:[{type:'command',command:'external-hook',timeout:11}]}],
        Stop:[{hooks:[{type:'prompt',prompt:'preserve the user prompt hook'}]}]
      },
      description:'external description'
    };
    const bytes=Buffer.from('\uFEFF'+JSON.stringify(original)+'\r\n');
    await writeFile(hookPath,bytes);
    const result=await registerTaskHooks({codexHome});
    assert.equal(result.changed,true);
    assert.ok(result.backupDirectory);
    assert.ok((await readFile(join(result.backupDirectory,'hooks.json'))).equals(bytes));
    const current=JSON.parse(await readFile(hookPath,'utf8'));
    assert.deepEqual(current.personal,original.personal);
    assert.equal(current.description,original.description);
    assert.deepEqual(current.hooks.UserPromptSubmit[0],original.hooks.UserPromptSubmit[0]);
    assert.deepEqual(current.hooks.Stop,original.hooks.Stop);
    assert.equal(current.hooks.UserPromptSubmit.length,2);
    assert.equal(current.hooks.SessionStart.length,1);
  });
});

test('mixed groups keep external handlers and status-message spoofs while replacing only exact owned targets',async()=>{
  await fixture(async({codexHome,hookPath,scriptPath,root})=>{
    const oldNode=join(root,'old node.exe');
    const owned=makeTaskHookCommands(oldNode,scriptPath);
    const external={type:'command',command:'external-hook',statusMessage:'加载规则'};
    const prompt={type:'prompt',prompt:'preserve me'};
    const mixedWindows={type:'command',command:owned.command,commandWindows:'foreign-windows-command'};
    const decoded=Buffer.from(owned.commandWindows.split(' ').at(-1),'base64').toString('utf16le');
    const spoofWindows={type:'command',commandWindows:'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand '+Buffer.from("Write-Output 'external action'; "+decoded,'utf16le').toString('base64'),statusMessage:'加载规则'};
    const extraArgument={type:'command',command:owned.command+' --external-action',statusMessage:'加载规则'};
    const original={hooks:{
      UserPromptSubmit:[{matcher:'mixed',custom:'preserve group',hooks:[
        external,{type:'command',...owned},prompt,mixedWindows,spoofWindows,extraArgument,
        {type:'command',commandWindows:owned.commandWindows},
        {type:'command',command:owned.command}
      ]}],
      SessionStart:[{matcher:'old',hooks:[{type:'command',...owned}]}],
      Stop:[{hooks:[external]}]
    }};
    await writeFile(hookPath,JSON.stringify(original));
    await registerTaskHooks({codexHome});
    const current=JSON.parse(await readFile(hookPath,'utf8'));
    assert.deepEqual(current.hooks.UserPromptSubmit[0],{matcher:'mixed',custom:'preserve group',hooks:[external,prompt,mixedWindows,spoofWindows,extraArgument]});
    assert.equal(current.hooks.UserPromptSubmit.length,2);
    assert.equal(current.hooks.SessionStart.length,1);
    assert.equal(current.hooks.SessionStart[0].matcher,template.hooks.SessionStart[0].matcher);
    assert.deepEqual(current.hooks.Stop,original.hooks.Stop);
    assert.ok(!handlers(current,'SessionStart').some(handler=>handler.command===owned.command));
  });
});

test('repeated registration is a byte-preserving no-op and changing Node replaces each owned handler once',async()=>{
  await fixture(async({codexHome,hookPath,root,scriptPath})=>{
    await registerTaskHooks({codexHome});
    const bytes=await readFile(hookPath),before=await lstat(hookPath);
    const repeat=await registerTaskHooks({codexHome});
    assert.equal(repeat.changed,false);
    assert.equal(repeat.backupDirectory,null);
    assert.ok((await readFile(hookPath)).equals(bytes));
    assert.equal((await lstat(hookPath)).mtimeMs,before.mtimeMs);
    assert.deepEqual(await backups(codexHome),[]);
    const nodeExecutable=join(root,"new Node it's 中文.exe");
    const update=await registerTaskHooks({codexHome,nodeExecutable});
    assert.equal(update.changed,true);
    assert.ok((await readFile(join(update.backupDirectory,'hooks.json'))).equals(bytes));
    const current=JSON.parse(await readFile(hookPath,'utf8'));
    for(const event of ['UserPromptSubmit','SessionStart']){
      assert.equal(handlers(current,event).length,1);
      assert.equal(handlers(current,event)[0].command,makeTaskHookCommands(nodeExecutable,scriptPath).command);
    }
    assert.equal((await registerTaskHooks({codexHome,nodeExecutable})).changed,false);
    assert.equal((await backups(codexHome)).length,1);
  });
});

test('removal deletes only owned handlers, is idempotent and works after plugin files are removed',async()=>{
  await fixture(async({codexHome,hookPath,directory})=>{
    const external={type:'command',command:'external-hook'};
    await writeFile(hookPath,JSON.stringify({custom:'preserve',hooks:{UserPromptSubmit:[{matcher:'external',hooks:[external]}],Stop:[{hooks:[external]}]}}));
    await registerTaskHooks({codexHome});
    const previous=await readFile(hookPath);
    await rm(directory,{recursive:true,force:true});
    const result=await registerTaskHooks({codexHome,remove:true});
    assert.equal(result.registered,false);
    assert.equal(result.hookTrustRequired,false);
    assert.equal(result.changed,true);
    assert.ok((await readFile(join(result.backupDirectory,'hooks.json'))).equals(previous));
    const current=JSON.parse(await readFile(hookPath,'utf8'));
    assert.deepEqual(current,{custom:'preserve',hooks:{UserPromptSubmit:[{matcher:'external',hooks:[external]}],Stop:[{hooks:[external]}],SessionStart:[]}});
    const count=(await backups(codexHome)).length;
    const bytes=await readFile(hookPath);
    assert.equal((await registerTaskHooks({codexHome,remove:true})).changed,false);
    assert.ok((await readFile(hookPath)).equals(bytes));
    assert.equal((await backups(codexHome)).length,count);
  });
});

test('removing absent global hooks does not create configuration or backups',async()=>{
  await fixture(async({codexHome,hookPath,directory})=>{
    await rm(directory,{recursive:true,force:true});
    const result=await registerTaskHooks({codexHome,remove:true});
    assert.equal(result.changed,false);
    await assert.rejects(()=>access(hookPath));
    assert.deepEqual(await backups(codexHome),[]);
  });
});

test('malformed, oversized and structurally invalid global files fail before any writes',async()=>{
  await fixture(async({codexHome,hookPath})=>{
    const invalid=[
      '{bad json',
      'null',
      '[]',
      '{}',
      '{"hooks":[]}',
      '{"hooks":{"Stop":{}}}',
      '{"hooks":{"Stop":[{}]}}',
      '{"hooks":{"Stop":[{"hooks":{}}]}}',
      '{"hooks":{"Stop":[{"hooks":[null]}]}}',
      Buffer.from([0xff,0xfe,0xff]),
      JSON.stringify({hooks:{},padding:'x'.repeat(1024*1024)})
    ];
    for(const contents of invalid){
      await writeFile(hookPath,contents);
      const before=await readFile(hookPath);
      await assert.rejects(()=>registerTaskHooks({codexHome}),/configuration|Hook events|Hook groups|Hook handlers/);
      assert.ok((await readFile(hookPath)).equals(before));
      assert.deepEqual(await backups(codexHome),[]);
      assert.ok(!(await readdir(codexHome)).some(name=>name.startsWith('.hooks.deepseek-')));
    }
    await unlink(hookPath);await mkdir(hookPath);
    await assert.rejects(()=>registerTaskHooks({codexHome}),/regular file/);
    assert.deepEqual(await backups(codexHome),[]);
  });
});

test('a global hooks symlink is rejected without modifying its target',async(t)=>{
  await fixture(async({codexHome,hookPath,root})=>{
    const target=join(root,'external-hooks.json'),bytes='{"hooks":{},"external":"preserve"}\n';
    await writeFile(target,bytes);
    try{await symlink(target,hookPath,'file');}
    catch(error){
      if(error.code!=='EPERM'&&error.code!=='EACCES')throw error;
      t.diagnostic('This Windows environment does not permit creating the symlink fixture; other invalid file cases still run.');
      return;
    }
    await assert.rejects(()=>registerTaskHooks({codexHome}),/regular file/);
    assert.equal(await readFile(target,'utf8'),bytes);
    assert.deepEqual(await backups(codexHome),[]);
  });
});

test('invalid installed templates and failed backups leave the previous global configuration intact',async()=>{
  await fixture(async({codexHome,hookPath,directory})=>{
    const before='{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"external-hook"}]}]}}\n';
    await writeFile(hookPath,before);
    const templatePath=join(directory,'hooks.json');
    await writeFile(templatePath,JSON.stringify({hooks:{UserPromptSubmit:[]}}));
    await assert.rejects(()=>registerTaskHooks({codexHome}),/template/);
    assert.equal(await readFile(hookPath,'utf8'),before);
    assert.deepEqual(await backups(codexHome),[]);
    await writeFile(templatePath,JSON.stringify(template));
    await writeFile(join(codexHome,'backups'),'external marker');
    await assert.rejects(()=>registerTaskHooks({codexHome}),/backup root/);
    assert.equal(await readFile(hookPath,'utf8'),before);
    assert.equal(await readFile(join(codexHome,'backups'),'utf8'),'external marker');
    assert.ok(!(await readdir(codexHome)).some(name=>name.startsWith('.hooks.deepseek-')));
  });
});

test('registration leaves personal instructions, configuration and unrelated hook files byte-identical',async()=>{
  await fixture(async({codexHome})=>{
    const files=[
      [join(codexHome,'AGENTS.md'),'# Personal instructions\n'],
      [join(codexHome,'config.toml'),'# Personal settings and trust\n'],
      [join(codexHome,'unrelated-hooks.json'),'{"hooks":{},"personal":true}\n']
    ];
    for(const [path,contents] of files)await writeFile(path,contents);
    await registerTaskHooks({codexHome});
    await registerTaskHooks({codexHome,remove:true});
    for(const [path,contents] of files)assert.equal(await readFile(path,'utf8'),contents);
  });
});
