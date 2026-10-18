import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../ui/panel.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

// Run the complete production script, including its real event listeners and
// transport promises. Use a synthetic capability only; no local service is read.
function panel({bridge = false, ignoreAbort = false} = {}) {
  const nodes = new Map(), timeouts = new Map(), intervals = new Map();
  const windowListeners = new Map(), documentListeners = new Map();
  const requests = [], messages = [];
  let nextTimer = 0;
  let now = Date.now();
  class Clock extends Date {static now() {return now;}}
  const listen = (listeners, name, callback) => {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(callback);
  };
  const make = () => ({textContent: '', hidden: false, dataset: {}, title: '', children: [], attributes: {}, listeners: new Map(), classList: {toggle() {}}, setAttribute(key,value) {this.attributes[key]=value;}, addEventListener(name,callback) {listen(this.listeners,name,callback);}, emit(name,event={}) {for(const callback of this.listeners.get(name)||[])callback(event);}, append(...items) {this.children.push(...items);}, replaceChildren(...items) {this.children = items;}, querySelectorAll() {return [];}, focus() {}});
  const node = (id) => {if (!nodes.has(id)) nodes.set(id, make()); return nodes.get(id);};
  const parent = {postMessage(message) {messages.push(message);}};
  const document = {hidden: false, getElementById: node, querySelector: node, createElement: make, createElementNS: make, createDocumentFragment: make, addEventListener(name, callback) {listen(documentListeners, name, callback);}};
  const window = {parent, addEventListener(name, callback) {listen(windowListeners, name, callback);}};
  const context = {
    Date: Clock, Intl, URLSearchParams, AbortController, console, document, window,
    location: {hash: bridge ? '' : '#token=synthetic-test-capability', protocol: bridge ? 'file:' : 'http:', hostname: bridge ? '' : '127.0.0.1'},
    setTimeout(callback, ms) {const id = ++nextTimer; timeouts.set(id, {callback, ms}); return id;},
    clearTimeout(id) {timeouts.delete(id);},
    setInterval(callback, ms) {const id = ++nextTimer; intervals.set(id, {callback, ms}); return id;},
    clearInterval(id) {intervals.delete(id);},
    requestAnimationFrame(callback) {callback();},
    fetch(url, options) {
      return new Promise((resolve, reject) => {
        const request = {url, signal: options.signal, resolve(data) {resolve({ok: true, json: async () => data});}};
        requests.push(request);
        if (!ignoreAbort) options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})), {once: true});
      });
    }
  };
  vm.runInNewContext(script, context);
  const emit = (listeners, name, event = {}) => {for (const callback of listeners.get(name) || []) callback(event);};
  return {
    node, requests, messages, timeouts, intervals, document,
    get now() {return now;},
    advance(ms) {now += ms;},
    event(name, value) {emit(windowListeners, name, value);},
    visibility(hidden) {document.hidden = hidden; emit(documentListeners, 'visibilitychange');},
    reply(id, result) {emit(windowListeners, 'message', {source: parent, data: {jsonrpc: '2.0', id, result}});},
    host(method, id) {emit(windowListeners, 'message', {source: parent, data: {jsonrpc: '2.0', method, id}});},
    poll() {const [id, entry] = [...timeouts].find(([, timer]) => timer.ms === 2500 || timer.ms === 800) || []; assert.ok(entry, 'poll is scheduled'); timeouts.delete(id); entry.callback();}
  };
}
const listResult = (runs = []) => ({structuredContent: {runs}});

test('backend cards, status and search filters retain only visible selections across polling', async () => {
  const p=panel();
  const runs=[
    {id:'h',title:'历史读取优化',backend:'harness',status:'running'},
    {id:'z',title:'样式设计',backend:'zcode',status:'running'},
    {id:'f',title:'失败回归',backend:'zcode',status:'failed'},
    {id:'old',title:'旧任务',status:'completed'}
  ];
  p.requests[0].resolve({runs}); await flush();
  p.requests[1].resolve({run:runs[0]}); await flush();
  assert.equal(p.node('parallel-summary').textContent,'两路均有任务进行中');
  assert.equal(p.node('active-zcode').textContent,'1 进行中');
  assert.equal(p.node('total-harness').textContent,'2 条记录');
  p.node('card-zcode').emit('click');
  p.requests[2].resolve({runs}); await flush();
  assert.equal(p.requests[3].url,'/api/runs/z');
  p.requests[3].resolve({run:runs[1]}); await flush();
  assert.equal(p.node('task-title').textContent,'样式设计');
  assert.equal(p.node('run-count').textContent,'2 / 4');
  assert.equal(p.node('filter-zcode').attributes['aria-pressed'],'true');
  p.node('status-filter').emit('change',{target:{value:'attention'}});
  p.requests[4].resolve({runs}); await flush();
  assert.equal(p.requests[5].url,'/api/runs/f');
  p.requests[5].resolve({run:runs[2]}); await flush();
  assert.equal(p.node('run-count').textContent,'1 / 4');
  p.node('search').emit('input',{target:{value:'不存在'}});
  p.requests[6].resolve({runs}); await flush();
  assert.equal(p.node('empty-title').textContent,'没有匹配的任务');
  assert.equal(p.node('detail').hidden,true);
  assert.equal(p.requests.length,7,'no detail read for an empty filter');
  p.poll(); p.requests[7].resolve({runs}); await flush();
  assert.equal(p.requests.length,8,'polling must not restore a filtered-out selection');
  p.event('pagehide',{persisted:false});
});

test('HTTP BFCache suspension aborts polling and restores timers across repeated visits', async () => {
  const p = panel();
  assert.equal(p.requests.length, 1);
  assert.equal(p.intervals.size, 1);
  p.event('pagehide', {persisted: true});
  assert.equal(p.requests[0].signal.aborted, true);
  await flush();
  assert.equal(p.timeouts.size, 0);
  assert.equal(p.intervals.size, 0);
  p.visibility(false);
  p.event('hashchange');
  p.event('pageshow', {persisted: false});
  assert.equal(p.requests.length, 1, 'cached page stays inactive until restored');

  p.event('pageshow', {persisted: true});
  assert.equal(p.requests.length, 2);
  assert.equal(p.intervals.size, 1);
  p.requests[1].resolve({runs: []});
  await flush();
  assert.equal(p.node('connection-label').textContent, '监看已连接');
  p.poll();
  assert.equal(p.requests.length, 3);
  p.event('pagehide', {persisted: true});
  await flush();
  assert.equal(p.intervals.size, 0);
  p.event('pageshow', {persisted: true});
  p.event('pageshow', {persisted: true});
  assert.equal(p.requests.length, 4);
  assert.equal(p.intervals.size, 1, 'duplicate pageshow does not add elapsed timers');
  p.event('pagehide', {persisted: false});
  await flush();
  p.event('pageshow', {persisted: true});
  p.visibility(false);
  assert.equal(p.requests.length, 4, 'real navigation permanently disposes the page');
  assert.equal(p.timeouts.size, 0);
  assert.equal(p.intervals.size, 0);
});

test('HTTP response from a suspended visit cannot populate the restored page', async () => {
  const p = panel({ignoreAbort: true});
  p.event('pagehide', {persisted: true});
  assert.equal(p.timeouts.size, 0, 'abort clears transport timer even before the response settles');
  p.event('pageshow', {persisted: true});
  p.requests[0].resolve({runs: [{id: 'stale', title: 'Stale response', status: 'running'}]});
  await flush();
  assert.equal(p.requests.length, 2);
  assert.equal(p.requests[1].url, '/api/runs', 'restore performs a fresh list read instead of reading stale detail');
  assert.equal(p.node('run-count').textContent, '0');
  p.requests[1].resolve({runs: []});
  await flush();
  assert.equal(p.node('connection-label').textContent, '监看已连接');
  p.event('pagehide', {persisted: false});
});

test('restoration resumes the elapsed display for the selected task', async () => {
  const p = panel();
  const run = {id: 'active', title: 'Active task', status: 'running', elapsedMs: 60000, startedAt: new Date(p.now).toISOString(), updatedAt: new Date(p.now).toISOString(), events: [], artifacts: []};
  p.requests[0].resolve({runs: [run]});
  await flush();
  p.requests[1].resolve({run});
  await flush();
  assert.equal(p.node('task-elapsed').textContent, '01:00');
  p.advance(1000);
  [...p.intervals.values()][0].callback();
  assert.equal(p.node('task-elapsed').textContent, '01:01');
  p.event('pagehide', {persisted: true});
  assert.equal(p.intervals.size, 0);
  p.advance(4000);
  p.event('pageshow', {persisted: true});
  [...p.intervals.values()][0].callback();
  assert.equal(p.node('task-elapsed').textContent, '01:05');
  p.event('pagehide', {persisted: false});
  await flush();
});

test('bridge BFCache restoration keeps initialization but replaces canceled tool reads', async () => {
  const p = panel({bridge: true});
  const initialize = p.messages.find((message) => message.method === 'ui/initialize');
  p.reply(initialize.id, {});
  await flush();
  const oldRead = p.messages.find((message) => message.method === 'tools/call');
  assert.ok(oldRead);
  p.event('pagehide', {persisted: true});
  await flush();
  assert.equal(p.timeouts.size, 0);
  assert.equal(p.intervals.size, 0);
  const beforeRestore = p.messages.length;
  p.host('ui/notifications/tool-result');
  assert.equal(p.messages.length, beforeRestore);
  p.event('pageshow', {persisted: true});
  await flush();
  const reads = p.messages.filter((message) => message.method === 'tools/call');
  assert.equal(reads.length, 2);
  assert.equal(p.messages.filter((message) => message.method === 'ui/initialize').length, 1);
  p.reply(oldRead.id, listResult([{id: 'stale', title: 'Old bridge reply', status: 'running'}]));
  p.reply(reads[1].id, listResult());
  await flush();
  assert.equal(p.node('run-count').textContent, '0');
  assert.equal(p.node('connection-label').textContent, '监看已连接');
  assert.equal(p.intervals.size, 1);
  p.poll();
  await flush();
  assert.equal(p.messages.filter((message) => message.method === 'tools/call').length, 3);
  p.host('ui/resource-teardown', 99);
  await flush();
  assert.equal(p.timeouts.size, 0);
  assert.equal(p.intervals.size, 0);
  assert.ok(p.messages.some((message) => message.id === 99 && message.result));
  const count = p.messages.length;
  p.event('pageshow', {persisted: true});
  p.host('ui/notifications/tool-result');
  await flush();
  assert.equal(p.messages.length, count, 'host teardown is permanent');
});

test('bridge initialization canceled by BFCache is retried without accepting late replies', async () => {
  const p = panel({bridge: true});
  const first = p.messages.find((message) => message.method === 'ui/initialize');
  p.event('pagehide', {persisted: true});
  p.event('pageshow', {persisted: true});
  await flush();
  const initializations = p.messages.filter((message) => message.method === 'ui/initialize');
  assert.equal(initializations.length, 2);
  p.reply(first.id, {});
  await flush();
  assert.equal(p.messages.some((message) => message.method === 'tools/call'), false);
  p.reply(initializations[1].id, {});
  await flush();
  assert.equal(p.messages.filter((message) => message.method === 'ui/notifications/initialized').length, 1);
  const read = p.messages.find((message) => message.method === 'tools/call');
  p.reply(read.id, listResult());
  await flush();
  assert.equal(p.node('connection-label').textContent, '监看已连接');
  p.event('pagehide', {persisted: true});
  p.host('ui/resource-teardown', 101);
  assert.ok(p.messages.some((message) => message.id === 101 && message.result));
  const count = p.messages.length;
  p.event('pageshow', {persisted: true});
  await flush();
  assert.equal(p.messages.length, count, 'teardown while cached also prevents restoration');
});
