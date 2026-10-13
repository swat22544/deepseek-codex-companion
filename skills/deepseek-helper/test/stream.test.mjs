import test from 'node:test';
import assert from 'node:assert/strict';
import { projectReplyStream, MAX_REPLY_TEXT_CHARS } from '../scripts/reply-stream.mjs';

const sessionId = 'session-test';
const base = {attemptId:'session-test:1', revision:2};
const chunk = (text, extra = {}) => ({type:'chunk', ...base, index:3, time:123456, chunk:{type:'text-delta', index:0, text}, ...extra});

test('start and end retain only their explicit public fields', () => {
  const poison = {get secret(){throw new Error('private field inspected');}};
  const start = {type:'start', ...base, turn:1, step:2, private:poison};
  assert.deepEqual(projectReplyStream(sessionId, start), [{type:'start', sessionId, ...base, turn:1, step:2}]);
  const end = {type:'end', ...base, index:4, outcome:{kind:'committed', eventType:'assistant/message', seq:7, private:poison}};
  assert.deepEqual(projectReplyStream(sessionId, end), [{type:'end', sessionId, ...base, index:4, outcome:{kind:'committed', eventType:'assistant/message', seq:7}}]);
  end.outcome.eventType = 'assistant/attempt';
  assert.equal(projectReplyStream(sessionId, end)[0].outcome.eventType, 'assistant/attempt');
  end.outcome = {kind:'abandoned', private:poison};
  assert.deepEqual(projectReplyStream(sessionId, end)[0].outcome, {kind:'abandoned'});
});

test('non-text chunks are dropped without inspecting their content', () => {
  for (const type of ['reasoning-delta','tool-call-delta','block-start','block-end','usage','finish','unknown']) {
    const other = {type, get text(){throw new Error('private text inspected');}, get block(){throw new Error('private block inspected');}};
    assert.deepEqual(projectReplyStream(sessionId, chunk('ignored', {chunk:other})), []);
  }
});

test('text is lossless and each escaped control message fits stderr line bound', () => {
  const text = '\0'.repeat(7999) + '😀' + '中文\n"\\'.repeat(9000);
  const events = projectReplyStream(sessionId, chunk(text));
  assert.equal(events.map(event => event.text).join(''), text);
  for (const [index,event] of events.entries()) {
    assert.equal(event.part, index);
    assert.equal(event.parts, events.length);
    assert.ok(event.text.length <= MAX_REPLY_TEXT_CHARS);
    assert.ok(!/[\uD800-\uDBFF]$/.test(event.text));
    assert.ok(!/^[\uDC00-\uDFFF]/.test(event.text));
    const line = 'CODEX_HELPER_CONTROL ' + JSON.stringify({nonce:'f'.repeat(36), event:'reply_stream', ...event}) + '\n';
    assert.ok(Buffer.byteLength(line) < 64000);
    assert.ok(line.length < 64000);
  }
});

test('text delta preserves ordering identifiers but no incidental data', () => {
  assert.deepEqual(projectReplyStream(sessionId, chunk('hello', {secret:'must not leak'})), [{type:'text_delta', sessionId, ...base, index:3, blockIndex:0, time:123456, part:0, parts:1, text:'hello'}]);
  assert.deepEqual(projectReplyStream(sessionId, chunk('')), []);
});

test('malformed envelopes and unsupported outcomes are ignored', () => {
  for (const value of [null, 1, [], {}, {type:'start', ...base, turn:0, step:1}, chunk('x', {revision:0}), chunk('x', {index:-1}), chunk('x', {time:NaN}), chunk('x', {chunk:{type:'text-delta', index:0, text:123}}), {type:'end', ...base, index:2, outcome:{kind:'committed',eventType:'unexpected',seq:1}}]) {
    assert.deepEqual(projectReplyStream(sessionId,value), []);
  }
  assert.deepEqual(projectReplyStream(null, chunk('x')), []);
});
