'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { WebSocketServer } = require('ws');

// 只连接临时回环端口，使用真实 Express / ws / OpenAI SDK 验证协议链路。
test('local HTTP → model SDK → NapCat WebSocket → history and SSE', { timeout: 10000 }, async (t) => {
  const modelRequests = [];
  const model = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    modelRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '模拟回复' } }] }));
  });
  t.after(() => { model.closeAllConnections(); model.close(); });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');

  const napcat = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  t.after(() => { for (const client of napcat.clients) client.terminate(); napcat.close(); });
  await once(napcat, 'listening');
  const packets = [];
  napcat.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const packet = JSON.parse(raw);
      packets.push(packet);
      socket.send(JSON.stringify({ echo: packet.echo, status: 'ok', retcode: 0,
        data: packet.action === 'get_friend_list' ? [{ user_id: 123 }] : { message_id: 42 } }));
    });
  });

  const root = path.resolve(__dirname, '..');
  const localRequire = createRequire(path.join(root, 'index.js'));
  const context = vm.createContext({
    require: (name) => name === 'dotenv' ? { config() {} } : localRequire(name),
    module: {}, __dirname: root, URL, AbortController,
    console: { log() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    process: { env: {
      NAPCAT_WS_URL: `ws://127.0.0.1:${napcat.address().port}`,
      OPENAI_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`,
      OPENAI_API_KEY: 'local-test-only', OPENAI_MODEL: 'mock', MASTER_QQ: '123',
    } },
  });
  const run = (code) => vm.runInContext(code, context);
  run(fs.readFileSync(path.join(root, 'index.js'), 'utf8'));
  const app = run('adminApp');
  const listen = app.listen.bind(app);
  app.listen = (port, host, callback) => listen(0, host, callback);
  t.after(() => run('stop()'));
  run('start()');
  const admin = run('adminServer');
  await once(run('ws'), 'open');
  const port = admin.address().port;

  const request = (url, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method,
      headers: { Host: '127.0.0.1:3000', 'Content-Type': 'application/json', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });

  const stats = await request('/api/stats');
  assert.equal(JSON.parse(stats.text).napcatConnected, true);
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/api/stats', { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await request('/api/history/__proto__')).status, 400);

  let eventText = '';
  const stream = http.get({ hostname: '127.0.0.1', port, path: '/api/stream', headers: { Host: '127.0.0.1:3000' } });
  stream.on('error', () => {});
  t.after(() => stream.destroy());
  const [streamResponse] = await once(stream, 'response');
  streamResponse.on('data', (chunk) => { eventText += chunk; });

  const forced = await request('/api/force-chat', { method: 'POST', body: { targetId: '123' } });
  assert.equal(forced.status, 200, forced.text);
  assert.equal(modelRequests.length, 1);
  assert.equal(packets.filter((p) => p.action === 'send_private_msg').length, 1);
  const history = JSON.parse((await request('/api/history/123')).text);
  assert.deepEqual(history, [{ role: 'assistant', content: '模拟回复' }]);
  assert.match(eventText, /bot_message/);
  const persona = await request('/api/set-persona', { method: 'POST', body: { mode: 'night' } });
  assert.equal(JSON.parse(persona.text).personaOverride, 'night');
});
