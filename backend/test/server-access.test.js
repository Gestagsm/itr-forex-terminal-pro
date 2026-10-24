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
  const historyPage = await (await request(app.base, '/history.html')).text();
  assert.match(historyPage, /id="d1"/, 'History keeps a custom start date');
  assert.match(historyPage, /id="d2"/, 'History keeps a custom end date');
  assert.match(historyPage, /data-q="1h"/, 'History keeps the one-hour quick range');
  assert.match(historyPage, /data-q="today"/, 'History keeps the today quick range');
  assert.match(historyPage, /id="bt"/, 'History keeps the four-hour block summary');
  assert.equal((await request(app.base, '/prices')).status, 200);
  assert.equal((await request(app.base, '/market')).status, 200);
  const publicStatusResponse = await request(app.base, '/public/status');
  assert.equal(publicStatusResponse.status, 200);
  const publicStatus = await publicStatusResponse.json();
  assert.equal(publicStatus.connected, false, 'connected remains false when PostgreSQL is not configured');
  assert.equal(publicStatus.marketRunning, true, 'marketRunning reflects the running market generator');
  assert.deepEqual(publicStatus.feeds.map(feed => feed.ds).sort(), ['GCV', 'TAQ', 'TAS']);
  assert.equal(publicStatus.feeds.every(feed => ['fresh', 'stale', 'waiting', 'paused'].includes(feed.freshness)), true);
  assert.equal(publicStatus.feeds.every(feed => Object.keys(feed).sort().join(',') === 'ds,freshness,updatedAt'), true);
  assert.equal(Object.keys(publicStatus).sort().join(','), 'connected,feeds,marketRunning');
  for (const ds of ['TAQ', 'TAS', 'GCV']) {
    const recent = await request(app.base, `/public/recent?ds=${ds}&symbol=EURUSD`);
    assert.equal(recent.status, 200, `${ds} latest feed is public`);
    const data = await recent.json();
    assert.equal(data.ds, ds);
    assert.equal(data.symbol, 'EURUSD');
    assert.ok(Array.isArray(data.cols));
    assert.ok(Array.isArray(data.rows));
    assert.equal(data.rows.some(row => '_eventTime' in row || '_sequence' in row), false);
  }
  assert.equal((await request(app.base, '/public/recent?ds=INVALID&symbol=EURUSD')).status, 400);
  const publicHistoryIndex = await request(app.base, '/history/index');
  assert.equal(publicHistoryIndex.status, 200);
  assert.ok((await publicHistoryIndex.json()).TAQ.EURUSD);
  assert.equal((await request(app.base, '/history/at?time=0')).status, 200);
  assert.equal((await request(app.base, '/history/at?time=not-a-time')).status, 400);
  const historicalRows = await request(app.base, '/history/query?ds=TAQ&symbol=EURUSD&from=0&to=4102444800000&limit=2');
  assert.equal(historicalRows.status, 200);
  const historyData = await historicalRows.json();
  assert.ok(Array.isArray(historyData.rows));
  assert.ok(historyData.rows.length <= 2);
  assert.ok(historyData.rows.every(row => row.length === historyData.cols.length));
  assert.equal((await request(app.base, '/history/query?ds=TAQ&symbol=EURUSD&from=0&to=4102444800000&limit=-1')).status, 400);
  assert.equal((await request(app.base, '/history/query?ds=TAQ&symbol=EURUSD&from=0&to=4102444800000&offset=-1')).status, 400);
  const publicBlocks = await request(app.base, '/public/history/blocks?ds=TAQ&symbol=EURUSD');
  assert.equal(publicBlocks.status, 200);
  const blockData = await publicBlocks.json();
  assert.equal(Array.isArray(blockData), true);
  for (const block of blockData) {
    assert.deepEqual(Object.keys(block).sort(), ['end', 'live', 'start']);
  }
  const csvHistory = await request(app.base, '/history/query?ds=TAQ&symbol=EURUSD&format=csv');
  assert.equal(csvHistory.status, 401, 'history export remains private');
  const candles = await request(app.base, '/candles?symbol=EURUSD&limit=2');
  assert.equal(candles.status, 200);
  assert.equal((await candles.json()).symbol, 'EURUSD');
  assert.deepEqual(await (await request(app.base, '/auth/session')).json(), { authenticated: false, configured: true });
  const demoCookie = `${encodeURIComponent('itr_terminal_session')}=demo-user-session`;
  for (const route of [
    '/', '/index.html', '/data.html', '/history.html', '/common.js',
    '/prices', '/market', '/candles?symbol=EURUSD&limit=2', '/public/status',
    '/public/recent?ds=TAQ&symbol=EURUSD', '/history/index', '/history/at?time=0',
    '/history/query?ds=TAQ&symbol=EURUSD&from=0&to=4102444800000&limit=2',
    '/public/history/blocks?ds=TAQ&symbol=EURUSD'
  ]) {
    assert.equal((await request(app.base, route, { cookie: demoCookie })).status, 200, `${route} is public with a non-operator cookie`);
  }
  assert.equal((await request(app.base, '/account', { cookie: demoCookie })).status, 401);
  assert.equal((await request(app.base, '/order', {
    method: 'POST', cookie: demoCookie, body: { symbol: 'EURUSD', side: 'BUY', lots: 1 }
  })).status, 401);

  const privateReads = [
    '/status', '/db/status', '/account', '/trades', '/curve', '/robot', '/config', '/files',
    '/fs/list', '/recent?ds=TAQ&symbol=EURUSD', '/history/blocks?ds=TAQ&symbol=EURUSD',
    '/history/query?ds=TAQ&symbol=EURUSD&format=csv', '/export/TAQ/EURUSD',
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
  for (const route of [
    '/', '/index.html', '/data.html', '/history.html', '/common.js', '/folders.js',
    '/trader.js', '/data.js', '/history.js', '/ui.css', '/trader.css',
    '/prices', '/market', '/candles?symbol=EURUSD&limit=2', '/public/status',
    '/public/recent?ds=TAQ&symbol=EURUSD'
  ]) {
    assert.equal((await request(app.base, route, { cookie })).status, 200, `${route} remains public with a session cookie`);
  }
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
