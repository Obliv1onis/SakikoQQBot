'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { ConversationQueue } = require('../lib/conversation-queue');
const root = path.resolve(__dirname, '..');
const localRequire = createRequire(path.join(root, 'index.js'));
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// 在隔离上下文里运行真实业务代码，替换传输、模型、时钟；不加载 .env、不打开端口。
function harness(t, { reply = '回复', time = '2026-10-07T15:00:00', translate = false } = {}) {
  const requests = [];
  const sent = [];
  const timers = new Map();
  const routes = new Map();
  const middleware = [];
  let nextTimer = 0;
  let context;
  const run = (code) => vm.runInContext(code, context);
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    send(payload, callback) {
      const packet = JSON.parse(payload);
      sent.push(packet);
      callback?.();
      queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({
        echo: packet.echo, status: 'ok', retcode: 0, data: [],
      }))));
    }
    terminate() { this.readyState = 3; this.emit('close'); }
  }
  function express() {
    return {
      disable() {}, use(...handlers) { middleware.push(...handlers); },
      get(url, callback) { routes.set(`GET ${url}`, callback); },
      post(url, callback) { routes.set(`POST ${url}`, callback); },
    };
  }
  express.json = express.static = () => (req, res, next) => next();
  const create = async (params, options) => {
    requests.push({ params, options });
    const content = typeof reply === 'function' ? await reply(params, options) : reply;
    return { choices: [{ message: { content } }] };
  };
  const NativeDate = Date;
  class FakeDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return new NativeDate(time).getTime(); }
  }
  context = vm.createContext({
    require(name) {
      if (name === 'dotenv') return { config() { throw new Error('Tests must not read .env'); } };
      if (name === 'ws') return Socket;
      if (name === 'express') return express;
      if (name === 'openai') return class { chat = { completions: { create } }; };
      return localRequire(name);
    },
    module: { exports: {} }, __dirname: root,
    process: { env: { NAPCAT_WS_URL: 'ws://localhost:3001', OPENAI_API_KEY: 'test', OPENAI_MODEL: 'test', MASTER_QQ: '123', TRANSLATE_USER_MESSAGES: translate ? '1' : '0' } },
    console: { log() {}, error() {} }, URL, AbortController, Date: FakeDate,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearInterval(id) { timers.delete(id); },
  });
  // Strip only the environment loader; startup is protected by require.main.
  vm.runInContext(source.replace("require('dotenv').config();", ''), context);
  run('openai = new OpenAI({}); connect();');
  t.after(() => run('stop()'));
  const message = (text, id = '1', userId = '123') => {
    context.event = { post_type: 'message', message_type: 'private', user_id: userId, raw_message: text, message_id: id };
    run('handleEvent(event)');
  };
  const history = () => JSON.parse(run("JSON.stringify(getState('123').history)"));
  return { run, message, history, requests, sent, timers, routes, middleware, context };
}

function response() {
  return { statusCode: 200, body: null, headers: {}, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; }, set(key, value) { this.headers[key] = value; return this; } };
}

test('same user is serialized; other users are independent; failures do not poison queue', async () => {
  const queue = new ConversationQueue();
  const gate = deferred();
  const order = [];
  const first = queue.run('1', async () => { order.push('first'); await gate.promise; throw new Error('failure'); });
  const failure = assert.rejects(first, /failure/);
  const second = queue.run('1', () => order.push('second'));
  await queue.run('2', () => order.push('other'));
  assert.deepEqual(order, ['first', 'other']);
  gate.resolve();
  await Promise.all([failure, second]);
  assert.deepEqual(order, ['first', 'other', 'second']);
});

test('restart clears buffer and timers and rejects an in-flight stale completion', async (t) => {
  const gate = deferred();
  const h = harness(t, { reply: () => gate.promise });
  h.message('旧消息');
  const pending = h.run("flushUser('123')");
  await tick();
  h.message('还没处理', '2');
  h.message('!restart', '3');
  assert.equal(h.run("getState('123').buffer.length"), 0);
  assert.equal(h.run("getState('123').timer"), null);
  assert.equal(h.requests[0].options.signal.aborted, true);
  gate.resolve('不应该发送');
  await pending;
  assert.deepEqual(h.history(), []);
  assert.equal(h.sent.filter((p) => p.params.message === '不应该发送').length, 0);
});

test('new generation is not blocked by a stale model request', async (t) => {
  const gate = deferred();
  let calls = 0;
  const h = harness(t, { reply: () => ++calls === 1 ? gate.promise : '新回复' });
  h.message('旧消息');
  const old = h.run("flushUser('123')");
  await tick();
  h.message('!restart');
  h.message('新消息');
  await h.run("flushUser('123')");
  assert.deepEqual(h.history().map((m) => m.content), ['新消息', '新回复']);
  gate.resolve('旧回复');
  await old;
  assert.deepEqual(h.history().map((m) => m.content), ['新消息', '新回复']);
});

test('role and language switches cancel stale completions', async (t) => {
  for (const command of ['!role uika', '!lang jp', '!online 0']) {
    const gate = deferred();
    const h = harness(t, { reply: () => gate.promise });
    h.message('消息');
    const pending = h.run("flushUser('123')");
    await tick();
    h.message(command);
    gate.resolve('旧回复');
    await pending;
    assert.equal(h.sent.some((p) => p.params.message === '旧回复'), false);
    assert.equal(h.history().length, 0);
  }
});

test('normal turns do not race and default mode makes one model call per turn', async (t) => {
  const gate = deferred();
  const h = harness(t, { reply: (params) => params.messages.at(-1).content === '第一条' ? gate.promise : '第二条回复' });
  h.message('第一条');
  const first = h.run("flushUser('123')");
  await tick();
  h.message('第二条', '2');
  const second = h.run("flushUser('123')");
  await tick();
  assert.equal(h.requests.length, 1);
  gate.resolve('第一条回复');
  await Promise.all([first, second]);
  assert.deepEqual(h.history().map((m) => m.content), ['第一条', '第一条回复', '第二条', '第二条回复']);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].params.messages.at(-2).content, '第一条回复');
});

test('recall removes buffered message and does not reply when buffer becomes empty', async (t) => {
  const h = harness(t);
  h.message('撤回的内容', '11');
  h.run("handleFriendRecall({ user_id: '123', message_id: '11' })");
  await h.run("flushUser('123')");
  assert.equal(h.requests.length, 0);
  assert.equal(h.run("getState('123').timer"), null);
});

test('recall during generation cancels stale response and preserves remaining messages', async (t) => {
  const gate = deferred();
  const h = harness(t, { reply: () => gate.promise });
  h.message('保留', '10');
  h.message('撤回', '11');
  const pending = h.run("flushUser('123')");
  await tick();
  h.run("handleFriendRecall({ user_id: '123', message_id: '11' })");
  assert.equal(h.run("getState('123').buffer[0].text"), '保留');
  gate.resolve('过时的回复');
  await pending;
  assert.deepEqual(h.history(), []);
  assert.equal(h.sent.length, 0);
});

test('user response cancels already generating opener', async (t) => {
  const gate = deferred();
  const h = harness(t, { reply: () => gate.promise });
  const pending = h.run("sendProactiveOpener('123')");
  await tick();
  h.message('我在');
  gate.resolve('还在吗');
  await pending;
  assert.equal(h.sent.length, 0);
  assert.equal(h.requests[0].options.signal.aborted, true);
});

test('NOREPLY and END work for background messages, including reality mode', async (t) => {
  for (const reply of ['[NOREPLY]', '[END]晚安']) {
    const h = harness(t, { reply });
    h.run("userOnlineMode['123'] = 0");
    await h.run("sendProactiveOpener('123')");
    assert.equal([...h.timers.values()].some((timer) => timer.delay === 60000 || timer.delay === 100000), false);
    assert.equal(h.sent.some((p) => /\[(?:NOREPLY|END)\]/.test(p.params.message)), false);
    if (reply === '[NOREPLY]') assert.equal(h.sent.length, 0);
    else assert.equal(h.history()[0].content, '晚安');
  }
});

test('failed sending does not write assistant history or broadcast success', async (t) => {
  const h = harness(t);
  h.run("ws.send = (payload, cb) => cb(new Error('send failed'))");
  h.message('你好');
  await h.run("flushUser('123')");
  assert.deepEqual(h.history().map((m) => m.role), ['user']);
  assert.equal(h.run('pendingApiCalls.size'), 0);
});

test('send uses plain text escaping and stores cleaned delivered text', async (t) => {
  const h = harness(t, { reply: '（微笑）你好' });
  h.message('你好');
  await h.run("flushUser('123')");
  assert.equal(h.sent[0].params.auto_escape, true);
  assert.equal(h.history()[1].content, '你好');
});

test('connection close rejects pending requests immediately and malformed payloads are ignored', async (t) => {
  const h = harness(t);
  h.run("ws.send = () => {}; ws.emit('message', 'null'); ws.emit('message', '[]'); ws.emit('message', '{')");
  const pending = h.run("callNapCatApi('get_friend_list')");
  const rejected = assert.rejects(pending, /连接已断开/);
  h.run("ws.emit('close')");
  await rejected;
  assert.equal(h.run('pendingApiCalls.size'), 0);
});

test('cooldown blocks proactive messages and uika remains exempt', async (t) => {
  const h = harness(t, { reply: '[MELTDOWN:2]回复' });
  h.run("getState('123').meltdownUntil = Date.now() + 1000");
  await h.run("forceProactiveChat('123')");
  assert.equal(h.requests.length, 0);
  h.run("getState('123').meltdownUntil = 0; userRoles['123'] = 'uika'");
  h.message('你好');
  await h.run("flushUser('123')");
  assert.equal(h.run("getState('123').meltdownUntil"), 0);
  assert.equal(h.sent[0].params.message, '回复');
});

test('late startup never creates past triggers, and scheduling stops after 22:00', (t) => {
  const h = harness(t);
  h.run("ensureTriggersForUser('123')");
  assert.equal(h.run("userDailyTriggers['123'].times.every((time) => time >= Date.now())"), true);
  const late = harness(t, { time: '2026-10-07T23:00:00' });
  late.run("ensureTriggersForUser('123'); knownUsers.add('123'); checkProactiveTriggers()");
  assert.equal(late.run("userDailyTriggers['123'].times.length"), 0);
  assert.equal(late.requests.length, 0);
});

test('overdue scheduler triggers are coalesced into one opener', async (t) => {
  const h = harness(t);
  h.run("knownUsers.add('123'); userDailyTriggers['123'] = { date: todayDateStr(), times: [Date.now()-3000, Date.now()-2000, Date.now()-1000] }; checkProactiveTriggers()");
  await tick();
  assert.equal(h.requests.length, 1);
});

test('history endpoint validates QQ IDs without allocating state for unknown users', (t) => {
  const h = harness(t);
  const route = h.routes.get('GET /api/history/:userId');
  const valid = response();
  route({ params: { userId: '456' } }, valid);
  assert.equal(valid.statusCode, 200);
  assert.equal(h.run('pendingByUser.size'), 0);
  const invalid = response();
  route({ params: { userId: '__proto__' } }, invalid);
  assert.equal(invalid.statusCode, 400);
});

test('admin rejects foreign origins and rebinding hosts', (t) => {
  const h = harness(t);
  for (const headers of [
    { host: 'evil.example:3000' },
    { host: '127.0.0.1:3000', origin: 'https://evil.example' },
    { host: '127.0.0.1:3000', 'sec-fetch-site': 'cross-site' },
  ]) {
    const res = response();
    h.middleware[0]({ get: (key) => headers[key], path: '/api/stats' }, res, () => assert.fail('must reject'));
    assert.equal(res.statusCode, 403);
  }
  let passed = false;
  h.middleware[0]({ get: (key) => ({ host: 'localhost:3000', origin: 'http://localhost:3000' })[key], path: '/api/stats' }, response(), () => { passed = true; });
  assert.equal(passed, true);
});

test('unknown prototype commands are ignored and tabs delimit valid commands', (t) => {
  const h = harness(t);
  assert.doesNotThrow(() => h.message('!__defineGetter__'));
  h.message('!role\tuika');
  assert.equal(h.run("userRoles['123']"), 'uika');
});

test('restart permission applies to non-master and valid config is checked', (t) => {
  const h = harness(t);
  h.run("globalAllowRestart = 0; getState('456').history.push({ role: 'user', content: 'keep' })");
  h.message('!restart', '1', '456');
  assert.equal(h.run("getState('456').history.length"), 1);
  assert.doesNotThrow(() => h.run('validateConfig()'));
  h.context.process.env.OPENAI_MODEL = '';
  assert.throws(() => h.run('validateConfig()'), /OPENAI_MODEL/);
});

test('optional translation can be enabled', async (t) => {
  const h = harness(t, { translate: true, reply: '翻译或回复' });
  h.message('hello');
  await h.run("flushUser('123')");
  assert.equal(h.requests.length, 2);
});

test('restart during typing stops unsent parts and clears the old history', async (t) => {
  const h = harness(t, { reply: '第一段[SPLIT]第二段比较长' });
  h.message('你好');
  const pending = h.run("flushUser('123')");
  await tick();
  assert.equal(h.sent[0].params.message, '第一段');
  h.message('!restart');
  await pending;
  assert.equal(h.sent.some((p) => p.params.message === '第二段比较长'), false);
  assert.deepEqual(h.history(), []);
});

test('interrupted background typing preserves already delivered text', async (t) => {
  const h = harness(t, { reply: '第一段[SPLIT]第二段比较长' });
  const pending = h.run("sendProactiveOpener('123')");
  await tick();
  h.message('我在');
  await pending;
  assert.deepEqual(h.history().map((m) => m.content), ['第一段']);
  assert.equal(h.run("getState('123').unansweredOpener"), false);
  assert.equal(h.sent.length, 1);
  assert.equal([...h.timers.values()].some((timer) => timer.delay === 60000 || timer.delay === 100000), false);
});

test('API rejection and timeout both release pending request state', async (t) => {
  const h = harness(t);
  h.run('ws.send = () => {}');
  const rejected = h.run("callNapCatApi('get_friend_list')");
  const rejection = assert.rejects(rejected, /返回失败/);
  h.run("ws.emit('message', JSON.stringify({ echo: [...pendingApiCalls.keys()][0], status: 'failed', retcode: 0 }))");
  await rejection;
  const timed = h.run("callNapCatApi('get_friend_list')");
  const timeout = assert.rejects(timed, /超时/);
  const timer = [...h.timers.values()].find((entry) => entry.delay === 8000);
  timer.callback();
  await timeout;
  assert.equal(h.run('pendingApiCalls.size'), 0);
});

test('admin inline scripts parse successfully', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length);
  for (const [, code] of scripts) assert.doesNotThrow(() => new vm.Script(code));
});


test('farewell fallback matches complete farewells rather than quoted words or numbers', (t) => {
  const h = harness(t);
  for (const text of ['晚安！', '拜拜', '88', 'おやすみなさい']) {
    h.context.input = text;
    assert.equal(h.run('FAREWELL_KEYWORDS_RE.test(input)'), true, text);
  }
  for (const text of ['188元', '晚安是什么意思？', 'bye bye这首歌', '晚安，明天几点集合？', '不要说再见']) {
    h.context.input = text;
    assert.equal(h.run('FAREWELL_KEYWORDS_RE.test(input)'), false, text);
  }
});

test('context budget evicts whole old turns before requesting the model', async (t) => {
  const h = harness(t);
  h.run("getState('123').history = [{role:'user',content:'旧'.repeat(16000)},{role:'assistant',content:'旧回复'},{role:'user',content:'近'.repeat(15000)},{role:'assistant',content:'近回复'}]");
  h.message('最新问题');
  await h.run("flushUser('123')");
  const messages = h.requests[0].params.messages;
  assert.equal(messages[1].role, 'user');
  assert.equal(messages[1].content, '近'.repeat(15000));
  assert.equal(messages.at(-1).content, '最新问题');
  assert.ok(messages.slice(1).reduce((sum, m) => sum + m.content.length, 0) <= 24000);
});

test('trimming keeps the latest turn and bounds consecutive proactive history', (t) => {
  const h = harness(t);
  assert.equal(h.run("(() => { const history = [{role:'user',content:'新'.repeat(16000)},{role:'assistant',content:'答'.repeat(10000)}]; trimHistory(history); return history.length; })()"), 2);
  assert.equal(h.run("(() => { const history = Array.from({length:40}, () => ({role:'assistant',content:'主动消息'})); trimHistory(history); return history.length; })()"), 30);
});


test('unanswered opener blocks later automatic openers even after the activity gap', async (t) => {
  const h = harness(t);
  await h.run("sendProactiveOpener('123', {automatic:true})");
  h.run("userLastActivity['123'] = Date.now() - 7200000");
  await h.run("triggerProactiveChat('123')");
  assert.equal(h.requests.length, 1);
  assert.equal(h.run("getState('123').unansweredOpener"), true);
  h.message('我在');
  await h.run("flushUser('123')");
  assert.equal(h.run("getState('123').unansweredOpener"), false);
  h.run("userLastActivity['123'] = Date.now() - 7200000");
  await h.run("triggerProactiveChat('123')");
  assert.equal(h.requests.length, 3);
});

test('queued automatic openers recheck unanswered state inside the queue', async (t) => {
  const h = harness(t);
  await Promise.all([h.run("sendProactiveOpener('123', {automatic:true})"), h.run("sendProactiveOpener('123', {automatic:true})")]);
  assert.equal(h.requests.length, 1);
});

test('failed opener can retry and background meltdown never starts a cooldown', async (t) => {
  const h = harness(t, {reply:'[MELTDOWN:2]你好'});
  h.run("ws.send = (payload, cb) => cb(new Error('failed'))");
  await h.run("sendProactiveOpener('123', {automatic:true})");
  assert.equal(h.run("getState('123').unansweredOpener"), false);
  const ok = harness(t, {reply:'[MELTDOWN:2]你好'});
  await ok.run("sendProactiveOpener('123')");
  assert.equal(ok.run("getState('123').meltdownUntil"), 0);
  assert.equal(ok.sent[0].params.message, '你好');
});

test('comma fragments and standalone names are joined before delivery', async (t) => {
  const h = harness(t, {reply:'爽世，[SPLIT]最近怎么样？'});
  h.message('你好');
  await h.run("flushUser('123')");
  assert.deepEqual(h.sent.map((p) => p.params.message), ['爽世，最近怎么样？']);
  assert.equal(h.run("splitByPunctuation('这是一段很长的句子，包含多个从句，但是应当完整发送。', 10).length"), 1);
});

test('normal conversation never schedules an unattended-message nag', async (t) => {
  const h = harness(t);
  h.run("getState('123').history = Array.from({length:10}, (_,i) => ({role:i%2?'assistant':'user',content:'历史'}))");
  h.message('今天还不错');
  await h.run("flushUser('123')");
  assert.equal([...h.timers.values()].some((timer) => timer.delay === 60000 || timer.delay === 100000), false);
});

test('cancelled background model cannot block an incoming user turn', async (t) => {
  const gate = deferred();
  let count = 0;
  const h = harness(t, {reply: () => ++count === 1 ? gate.promise : '收到'});
  const background = h.run("sendProactiveOpener('123')");
  await tick();
  h.message('新问题');
  await h.run("flushUser('123')");
  assert.equal(h.sent[0].params.message, '收到');
  gate.resolve('过时主动消息');
  await background;
  await tick();
  assert.equal(h.sent.length, 1);
});

test('control markers are consumed regardless of order in reality mode', async (t) => {
  const h = harness(t, {reply:'[END][MELTDOWN:1]够了。[END]'});
  h.run("userOnlineMode['123'] = 0");
  h.message('旧事');
  await h.run("flushUser('123')");
  assert.equal(h.sent[0].params.message, '够了。');
  assert.equal(h.run("getState('123').meltdownUntil > Date.now()"), true);
  assert.equal(h.run("parseReply('[END][NOREPLY]').text"), '');
});

test('online cleanup preserves factual parentheses while removing stage directions', async (t) => {
  const h = harness(t, {reply:'（微笑）明天（三点）见，带上谱子（第二版）。'});
  h.message('几点见');
  await h.run("flushUser('123')");
  assert.equal(h.sent[0].params.message, '明天（三点）见，带上谱子（第二版）。');
});


test('recall while sending cancels remaining parts and removes recalled user text', async (t) => {
  const h = harness(t, {reply:'第一段[SPLIT]不应该发送的第二段'});
  h.message('撤回内容', '77');
  const pending = h.run("flushUser('123')");
  await tick();
  h.run("handleFriendRecall({user_id:'123', message_id:'77'})");
  await pending;
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.history().map((m) => m.content), ['第一段']);
});

test('outdated meltdown reply does not discard newly arrived user messages', async (t) => {
  const gate = deferred();
  const h = harness(t, {reply: () => gate.promise});
  h.message('旧话题');
  const pending = h.run("flushUser('123')");
  await tick();
  h.message('对不起，换个话题', '2');
  gate.resolve('[MELTDOWN:2]够了');
  await pending;
  assert.equal(h.run("getState('123').buffer.length"), 1);
  assert.equal(h.run("getState('123').meltdownUntil"), 0);
});
