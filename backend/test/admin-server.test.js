'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAdminServer, validateOptions } = require('../admin-server');

const options = port => ({
  username: 'itr-operator',
  password: 'test-password-with-more-than-14-characters',
  terminalUrl: 'http://127.0.0.1:4100',
  apiToken: 'admin-proxy-test-token-with-at-least-thirty-two-characters',
  host: '127.0.0.1',
  port,
  cookieSecure: false
});

async function startAdmin(upstreamFetch) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itr-admin-test-'));
  const server = createAdminServer({ ...options(0), dataDir }, upstreamFetch);
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  return {
    base: `http://127.0.0.1:${address.port}`,
    server,
    dataDir,
    close: () => !server.listening ? Promise.resolve() : new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    })
  };
}

function cleanup(app) {
  return async () => {
    await app.close();
    fs.rmSync(app.dataDir, { recursive: true, force: true });
  };
}

function request(base, path, { method = 'GET', body, cookie, origin = base } = {}) {
  const headers = {};
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;
  return fetch(`${base}${path}`, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test('admin service requires credentials and protects remote binding', () => {
  assert.throws(() => validateOptions({ ...options(4200), password: '' }), /ADMIN_USERNAME and ADMIN_PASSWORD/);
  assert.throws(() => validateOptions({ ...options(4200), password: 'short' }), /at least 14 characters/);
  assert.throws(() => validateOptions({ ...options(4200), terminalUrl: 'http://example.com' }), /local HTTP\(S\)/);
  assert.throws(() => validateOptions({ ...options(4200), host: '0.0.0.0' }), /ADMIN_COOKIE_SECURE=1/);
  assert.doesNotThrow(() => validateOptions({ ...options(4200), host: '0.0.0.0', cookieSecure: true }));
});

test('standalone admin sign-in protects status and robot controls and logout revokes session', async t => {
  const proxied = [];
  const app = await startAdmin(async (url, init) => {
    proxied.push({
      path: new URL(url).pathname,
      method: init.method,
      body: init.body && JSON.parse(init.body),
      authorization: new Headers(init.headers).get('authorization')
    });
    const data = new URL(url).pathname === '/robot/config'
      ? { enabled: JSON.parse(init.body).enabled, tf: 'M5', symbols: [], stats: {} }
      : { running: true, streams: [], symbols: ['EURUSD'], datasets: ['TAQ'], database: { historySynced: true } };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  t.after(cleanup(app));

  const asset = await request(app.base, '/');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await asset.text(), /CONTROL PLANE/);
  const stylesheet = await request(app.base, '/admin.css');
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get('content-type'), /text\/css/);

  const unauthorized = await request(app.base, '/api/status');
  assert.equal(unauthorized.status, 401);
  const blockedPost = await request(app.base, '/api/robot/config', { method: 'POST', body: { enabled: true } });
  assert.equal(blockedPost.status, 401);
  assert.equal(proxied.length, 0, 'unauthenticated actions never reach the terminal');

  const rejectedOrigin = await request(app.base, '/api/login', {
    method: 'POST', origin: 'https://attacker.example',
    body: { username: 'itr-operator', password: options(0).password }
  });
  assert.equal(rejectedOrigin.status, 403);

  const failedLogin = await request(app.base, '/api/login', {
    method: 'POST', body: { username: 'itr-operator', password: 'wrong' }
  });
  assert.equal(failedLogin.status, 401);
  const login = await request(app.base, '/api/login', {
    method: 'POST', body: { username: 'itr-operator', password: options(0).password }
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';', 1)[0];
  assert.equal((await request(app.base, '/api/session', { cookie })).status, 200);
  assert.equal((await request(app.base, '/api/status', { cookie })).status, 200);
  assert.equal(proxied[0].authorization, `Bearer ${options(0).apiToken}`);

  const robotResponse = await request(app.base, '/api/robot/config', {
    method: 'POST', cookie, body: { enabled: false }
  });
  assert.equal(robotResponse.status, 200);
  assert.deepEqual(proxied.map(call => call.path), ['/status', '/robot/config']);
  assert.deepEqual(proxied[1].body, { enabled: false });

  assert.equal((await request(app.base, '/api/logout', { method: 'POST', cookie, body: {} })).status, 200);
  assert.equal((await request(app.base, '/api/session', { cookie })).status, 401);
});

test('admin service rate-limits failed login attempts', async t => {
  const app = await startAdmin(async () => new Response('{}'));
  t.after(cleanup(app));
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await request(app.base, '/api/login', {
      method: 'POST', body: { username: 'itr-operator', password: 'invalid' }
    });
    assert.equal(response.status, 401);
  }
  const limited = await request(app.base, '/api/login', {
    method: 'POST', body: { username: 'itr-operator', password: 'invalid' }
  });
  assert.equal(limited.status, 429);
});

test('profile password change preserves encrypted API settings and revokes old sessions', async t => {
  const app = await startAdmin(async () => new Response('{}'));
  t.after(cleanup(app));
  const login = async (username, password) => {
    const response = await request(app.base, '/api/login', {
      method: 'POST', body: { username, password }
    });
    return { response, cookie: response.headers.get('set-cookie')?.split(';', 1)[0] };
  };
  const initial = await login('itr-operator', options(0).password);
  assert.equal(initial.response.status, 200);
  const anotherSession = await login('itr-operator', options(0).password);
  assert.equal(anotherSession.response.status, 200);

  const saved = await request(app.base, '/api/settings', {
    method: 'POST', cookie: initial.cookie,
    body: {
      ai: { provider: 'openai', model: 'gpt-test', apiKey: 'ai-secret-test-value' },
      broker: {
        provider: 'oanda', environment: 'demo', accountId: 'demo-123',
        apiKey: 'broker-secret-test-value', accessToken: 'access-token-test-value'
      }
    }
  });

  const savedBody = await saved.json();
  assert.equal(saved.status, 200, JSON.stringify(savedBody));
  const publicConfig = savedBody;
  assert.equal(publicConfig.ai.hasApiKey, true);
  assert.equal(publicConfig.broker.hasAccessToken, true);
  assert.equal(JSON.stringify(publicConfig).includes('secret-test-value'), false);

  const stateFile = path.join(app.dataDir, 'admin-state.json');
  const diskBefore = fs.readFileSync(stateFile, 'utf8');
  assert.equal(diskBefore.includes('ai-secret-test-value'), false);
  assert.equal(diskBefore.includes('broker-secret-test-value'), false);
  assert.equal(diskBefore.includes('access-token-test-value'), false);

  const newPassword = 'replacement-test-password-with-20-characters';
  const changed = await request(app.base, '/api/profile', {
    method: 'POST', cookie: initial.cookie,
    body: {
      username: 'primary-admin',
      currentPassword: options(0).password,
      newPassword
    }
  });

  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).username, 'primary-admin');
  const refreshedCookie = changed.headers.get('set-cookie').split(';', 1)[0];
  assert.equal((await request(app.base, '/api/session', { cookie: refreshedCookie })).status, 200);
  assert.equal((await request(app.base, '/api/session', { cookie: anotherSession.cookie })).status, 401);
  assert.deepEqual(await (await request(app.base, '/api/settings', { cookie: refreshedCookie })).json(), {
    ai: { provider: 'openai', model: 'gpt-test', hasApiKey: true },
    broker: {
      provider: 'oanda', environment: 'demo', accountId: 'demo-123',
      hasApiKey: true, hasAccessToken: true
    },
    integrationsActive: false
  });

  await app.close();
  const restarted = createAdminServer({ ...options(0), dataDir: app.dataDir }, async () => new Response('{}'));
  await new Promise((resolve, reject) => restarted.listen(0, '127.0.0.1', resolve).once('error', reject));
  const restartedBase = `http://127.0.0.1:${restarted.address().port}`;
  try {
    assert.equal((await request(restartedBase, '/api/session', { cookie: refreshedCookie })).status, 401);
    assert.equal((await request(restartedBase, '/api/login', {
      method: 'POST', body: { username: 'itr-operator', password: options(0).password }
    })).status, 401);
    const newLogin = await request(restartedBase, '/api/login', {
      method: 'POST', body: { username: 'primary-admin', password: newPassword }
    });
    assert.equal(newLogin.status, 200);
    const newCookie = newLogin.headers.get('set-cookie').split(';', 1)[0];
    const persistedSettings = await request(restartedBase, '/api/settings', { cookie: newCookie });
    assert.equal(persistedSettings.status, 200);
    assert.equal((await persistedSettings.json()).ai.hasApiKey, true);
  } finally {
    await new Promise(resolve => { restarted.close(resolve); restarted.closeAllConnections() });
  }
});

test('API settings can clear secrets and discard credentials when changing providers', async t => {
  const app = await startAdmin(async () => new Response('{}'));
  t.after(cleanup(app));
  const login = await request(app.base, '/api/login', {
    method: 'POST', body: { username: 'itr-operator', password: options(0).password }
  });
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const save = body => request(app.base, '/api/settings', { method: 'POST', cookie, body });

  assert.equal((await save({
    ai: { provider: 'openai', model: 'test-model', apiKey: 'keep-ai-key' },
    broker: { provider: 'oanda', environment: 'demo', accountId: 'paper-1', apiKey: 'remove-broker-key', accessToken: 'remove-token' }
  })).status, 200);

  const switched = await save({
    ai: { provider: 'anthropic', model: 'test-model', apiKey: '' },
    broker: { provider: 'oanda', environment: 'demo', accountId: 'paper-1', apiKey: '', accessToken: '', clearApiKey: true }
  });
  assert.equal(switched.status, 200);
  assert.deepEqual(await switched.json(), {
    ai: { provider: 'anthropic', model: 'test-model', hasApiKey: false },
    broker: { provider: 'oanda', environment: 'demo', accountId: 'paper-1', hasApiKey: false, hasAccessToken: true },
    integrationsActive: false
  });

  const changedBroker = await save({
    ai: { provider: 'anthropic', model: 'test-model', apiKey: '' },
    broker: { provider: 'interactive-brokers', environment: 'demo', accountId: 'paper-1', apiKey: '', accessToken: '' }
  });
  assert.equal(changedBroker.status, 200);
  assert.equal((await changedBroker.json()).broker.hasAccessToken, false);

  const settingsFile = fs.readFileSync(path.join(app.dataDir, 'admin-state.json'), 'utf8');
  assert.equal(settingsFile.includes('keep-ai-key'), false);
  assert.equal(settingsFile.includes('remove-broker-key'), false);
  assert.equal(settingsFile.includes('remove-token'), false);
});
