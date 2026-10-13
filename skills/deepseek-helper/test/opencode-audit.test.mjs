import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,rm} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAuditReader} from '../scripts/opencode-runner.mjs';

async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'opencode-audit-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 return join(directory,'audit.jsonl');
}

test('audit polls preserve Unicode when appended bytes split a codepoint',async t=>{
 const path=await fixture(t),received=[];
 const reader=createAuditReader(path,record=>received.push(record));
 const expected={event:'reply_stream',text:'中文🙂公开回复'};
 const bytes=Buffer.from(JSON.stringify(expected)+'\n');
 const start=bytes.indexOf(Buffer.from('中'));
 await writeFile(path,bytes.subarray(0,start+1));await reader();
 assert.equal(received.length,0);
 await appendFile(path,bytes.subarray(start+1,start+2));await reader();
 assert.equal(received.length,0);
 await appendFile(path,bytes.subarray(start+2));
 await Promise.all([reader(),reader(),reader.finish()]);
 assert.deepEqual(received,[expected]);
 await reader.finish();await reader();
 assert.equal(received.length,1);
});

test('finish drains unpolled complete records and rejects an unterminated tail',async t=>{
 const path=await fixture(t),received=[];
 await writeFile(path,'{"seq":1}\n{"seq":2}');
 const reader=createAuditReader(path,record=>received.push(record));
 await assert.rejects(reader.finish(),/Unterminated/);
 assert.deepEqual(received,[{seq:1}]);
 await appendFile(path,'\n');
 await assert.rejects(reader(),/Unterminated/);
 await assert.rejects(reader.finish(),/Unterminated/);
});

test('finish rejects truncated UTF-8 and polling rejects malformed UTF-8',async t=>{
 const path=await fixture(t);
 await writeFile(path,Buffer.concat([Buffer.from('{"text":"'),Buffer.from([0xe4,0xb8])]));
 const reader=createAuditReader(path,()=>assert.fail('Partial record must not be accepted'));
 await reader();await assert.rejects(reader.finish(),/Invalid UTF-8 at end/);
 const other=path+'.invalid';await writeFile(other,Buffer.from([0xff,0x0a]));
 await assert.rejects(createAuditReader(other,()=>assert.fail('Invalid record must not be accepted'))(),/Invalid UTF-8/);
});

test('audit parse errors omit raw data and remain fatal after another poll',async t=>{
 const path=await fixture(t);await writeFile(path,'{"PRIVATE_SENTINEL":wrong}\n');
 const reader=createAuditReader(path,()=>assert.fail('Malformed record must not be accepted'));
 await assert.rejects(reader(),error=>/Malformed OpenCode audit record/.test(error.message)&&!error.message.includes('PRIVATE_SENTINEL'));
 await assert.rejects(reader.finish(),/Malformed OpenCode audit record/);
});

test('complete final record is accepted exactly once and a missing unused audit is allowed',async t=>{
 const path=await fixture(t),received=[];
 const unused=createAuditReader(path,()=>assert.fail('Missing file has no records'));
 await unused();await unused.finish();
 await writeFile(path,'{"seq":1}\n{"seq":2}\n');
 const reader=createAuditReader(path,record=>received.push(record));
 await reader.finish();await reader.finish();await reader();
 assert.deepEqual(received,[{seq:1},{seq:2}]);
});

test('finish rereads EOF after joining an earlier poll with a stale file size',async t=>{
 const path=await fixture(t),received=[];
 await writeFile(path,'{"seq":1}\n');
 const reader=createAuditReader(path,record=>{
  received.push(record);
  if(record.seq===1)appendFileSync(path,'{"seq":2}\n');
 });
 await Promise.all([reader(),reader.finish()]);
 assert.deepEqual(received,[{seq:1},{seq:2}]);
});
