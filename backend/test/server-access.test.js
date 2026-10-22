'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const API_TOKEN = 'unit-test-api-token-with-at-least-thirty-two-characters';

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startTerminal(t, { token = API_TOKEN } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itr-terminal-access-test-'));
  const port = await unusedPort();
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    STATUS_PORT: String(port),
    HISTORY_DIR: path.join(tempDir, 'history'),
    NO_OPEN: '1',
    WARMUP_HOURS: '0',
    SYMBOLS: 'EURUSD',
    DATABASE_URL: '',
    PGHOST: '',
    PGDATABASE: '',
    PGUSER: '',
    API_COOKIE_SECURE: '0'
  };
  if (token) env.API_TOKEN = token;
  else env.API_TOKEN = '';
  const child = spawn(process.execPath, [path.join(ROOT, 'backend', 'server.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk });
  child.stderr.on('data', chunk => { output += chunk });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    if (child.exitCode !== null) break;
    try { ready = (await fetch(`${base}/prices`)).ok }
    catch { await new Promise(resolve => setTimeout(resolve, 100)) }
  }
  if (!ready) {
    child.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`Terminal did not start. ${output}`);
  }
  const close = async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  };
  t.after(close);
  return { base, close };
}

function request(base, route, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    headers.Origin = base;
  }
  if (cookie) headers.Cookie = cookie;
  return fetch(`${base}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test('terminal allows public market reads but protects private data, files, and every mutation', async t => {
  const app = await startTerminal(t);
  for (const route of ['/', '/index.html', '/data.html', '/history.html', '/common.js']) {
    assert.equal((await request(app.base, route)).status, 200, `${route} remains public`);
  }
  assert.equal((await request(app.base, '/prices')).status, 200);
  assert.equal((await request(app.base, '/market')).status, 200);
  const candles = await request(app.base, '/candles?symbol=EURUSD&limit=2');
  assert.equal(candles.status, 200);
  assert.equal((await candles.json()).symbol, 'EURUSD');
  assert.deepEqual(await (await request(app.base, '/auth/session')).json(), { authenticated: false, configured: true });

  const privateReads = [
    '/status', '/db/status', '/account', '/trades', '/curve', '/robot', '/config',
    '/fs/list', '/files', '/recent?ds=TAQ&symbol=EURUSD', '/history/index',
    '/history/at?time=0', '/history/blocks?ds=TAQ&symbol=EURUSD',
    '/history/query?ds=TAQ&symbol=EURUSD', '/export/TAQ/EURUSD',
    '/download/TAQ/EURUSD/private.xlsx'
  ];
  for (const route of privateReads) assert.equal((await request(app.base, route)).status, 401, `${route} is private`);

  const mutations = [
    ['/start', {}], ['/stop', {}], ['/order', { symbol: 'EURUSD', side: 'BUY', lots: 1 }],
    ['/close', { id: 1 }], ['/closeall', {}], ['/modify', { id: 1 }],
    ['/cancel', { id: 1 }], ['/account/reset', { balance: 10000 }],
    ['/robot/config', { enabled: false }], ['/config/setup-done', {}],
    ['/config/folders', { TAQ: 'C:\\private' }]
  ];
  for (const [route, body] of mutations) {
    assert.equal((await request(app.base, route, { method: 'POST', body })).status, 401, `${route} is protected`);
  }

  const rejectedLogin = await request(app.base, '/auth/login', { method: 'POST', body: { token: 'incorrect' } });
  assert.equal(rejectedLogin.status, 401);
  const login = await request(app.base, '/auth/login', { method: 'POST', body: { token: API_TOKEN } });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  assert.deepEqual(await (await request(app.base, '/auth/session', { cookie })).json(), { authenticated: true, configured: true });
  assert.equal((await request(app.base, '/account', { cookie })).status, 200);
  assert.equal((await request(app.base, '/robot/config', {
    method: 'POST', cookie, body: { enabled: false }
  })).status, 200);
  assert.equal((await fetch(`${app.base}/account`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` }
  })).status, 200);
  assert.equal((await fetch(`${app.base}/robot/config`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false })
  })).status, 200);
  assert.equal((await request(app.base, '/auth/logout', { method: 'POST', cookie })).status, 200);
  assert.equal((await request(app.base, '/account', { cookie })).status, 401);
});

test('terminal keeps public market reads available and fails closed when API_TOKEN is missing', async t => {
  const app = await startTerminal(t, { token: '' });
  assert.equal((await request(app.base, '/prices')).status, 200);
  assert.equal((await request(app.base, '/market')).status, 200);
  assert.equal((await request(app.base, '/candles?symbol=EURUSD&limit=2')).status, 200);
  assert.equal((await request(app.base, '/account')).status, 401);
  assert.equal((await request(app.base, '/config')).status, 401);
  assert.equal((await request(app.base, '/download/TAQ/EURUSD/private.xlsx')).status, 401);
  assert.equal((await request(app.base, '/order', { method: 'POST', body: {} })).status, 401);
  assert.deepEqual(await (await request(app.base, '/auth/session')).json(), { authenticated: false, configured: false });
  assert.equal((await request(app.base, '/auth/login', { method: 'POST', body: { token: API_TOKEN } })).status, 503);
});
