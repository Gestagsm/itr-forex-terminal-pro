'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ASSET_DIR = path.join(ROOT, 'admin', 'public');
const SESSION_COOKIE = 'itr_admin_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const MAX_BODY_BYTES = 16 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const DEFAULT_SETTINGS = {
  ai: { provider: 'none', model: '', apiKey: '' },
  broker: { provider: 'simulated', environment: 'demo', accountId: '', apiKey: '', accessToken: '' }
};
const AI_PROVIDERS = new Set(['none', 'openai', 'anthropic', 'google']);
const BROKER_PROVIDERS = new Set(['simulated', 'oanda', 'interactive-brokers', 'metatrader5']);

function validateOptions(options) {
  if (!options.username || !options.password) throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD must be configured before starting the admin service.');
  if (options.password.length < 14) throw new Error('ADMIN_PASSWORD must be at least 14 characters long.');
  if (!options.terminalUrl) throw new Error('ADMIN_TERMINAL_URL must be configured.');
  const terminal = new URL(options.terminalUrl);
  if (!['http:', 'https:'].includes(terminal.protocol) || terminal.username || terminal.password
    || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(terminal.hostname)) {
    throw new Error('ADMIN_TERMINAL_URL must point to a local HTTP(S) terminal service.');
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('ADMIN_PORT must be a valid TCP port.');
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(options.host);
  if (!loopback && !options.cookieSecure) {
    throw new Error('Remote admin binding requires ADMIN_COOKIE_SECURE=1 behind a trusted HTTPS proxy.');
  }
  return { terminal, loopback };
}

function safeEqual(left, right) {
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(left)).digest(),
    crypto.createHash('sha256').update(String(right)).digest()
  );
}

function passwordKey(password, salt) {
  return crypto.scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function sealSettings(settings, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(settings), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

function openSettings(envelope, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8'));
}

function publicSettings(settings) {
  return {
    ai: { provider: settings.ai.provider, model: settings.ai.model, hasApiKey: Boolean(settings.ai.apiKey) },
    broker: {
      provider: settings.broker.provider, environment: settings.broker.environment,
      accountId: settings.broker.accountId,
      hasApiKey: Boolean(settings.broker.apiKey), hasAccessToken: Boolean(settings.broker.accessToken)
    },
    integrationsActive: false
  };
}

function validateSettings(body, previous) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Settings must be an object.');
  const ai = body.ai, broker = body.broker;
  if (!ai || typeof ai !== 'object' || !AI_PROVIDERS.has(ai.provider)) throw new Error('Choose a supported AI provider.');
  if (!broker || typeof broker !== 'object' || !BROKER_PROVIDERS.has(broker.provider)) throw new Error('Choose a supported broker provider.');
  if (!['demo', 'live'].includes(broker.environment)) throw new Error('Broker environment must be demo or live.');
  const text = (value, field, max) => {
    if (typeof value !== 'string' || value.length > max) throw new Error(`${field} must be text no longer than ${max} characters.`);
    return value.trim();
  };
  const secret = (value, field, oldValue, clear) => {
    if (clear) return '';
    if (value === undefined || value === '') return oldValue;
    return text(value, field, 4096);
  };
  const sameAiProvider = ai.provider === previous.ai.provider;
  const sameBrokerProvider = broker.provider === previous.broker.provider;
  return {
    ai: {
      provider: ai.provider,
      model: text(ai.model || '', 'AI model', 120),
      apiKey: secret(ai.apiKey, 'AI API key', sameAiProvider ? previous.ai.apiKey : '', ai.clearApiKey)
    },
    broker: {
      provider: broker.provider,
      environment: broker.environment,
      accountId: text(broker.accountId || '', 'Broker account ID', 160),
      apiKey: secret(broker.apiKey, 'Broker API key', sameBrokerProvider ? previous.broker.apiKey : '', broker.clearApiKey),
      accessToken: secret(broker.accessToken, 'Broker access token', sameBrokerProvider ? previous.broker.accessToken : '', broker.clearAccessToken)
    }
  };
}

function cookieValue(request) {
  const cookie = request.headers.cookie || '';
  for (const field of cookie.split(';')) {
    const separator = field.indexOf('=');
    if (separator < 0 || field.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    return field.slice(separator + 1).trim();
  }
  return '';
}

function createAdminServer(options, upstreamFetch = fetch) {
  const { terminal } = validateOptions(options);
  const secret = crypto.randomBytes(32);
  const sessions = new Map();
  const loginAttempts = new Map();
  const dataDir = options.dataDir || path.join(ROOT, 'history', '.admin');
  const dataFile = path.join(dataDir, 'admin-state.json');
  fs.mkdirSync(dataDir, { recursive: true });
  let state;
  if (fs.existsSync(dataFile)) {
    state = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    if (state.version !== 1 || !state.auth || !state.encryptedSettings) throw new Error('Admin state file is invalid; refusing to start with missing authentication or settings data.');
  } else {
    const salt = crypto.randomBytes(16);
    const key = passwordKey(options.password, salt);
    state = {
      version: 1,
      auth: { username: options.username, salt: salt.toString('base64'), verifier: key.subarray(0, 32).toString('base64') },
      encryptedSettings: sealSettings(DEFAULT_SETTINGS, key.subarray(32))
    };
    persistState();
  }
  let terminalHealth = { ok: false, error: 'Not checked yet', checkedAt: null };

  function persistState() {
    const temporary = `${dataFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temporary, dataFile);
  }

  function sign(payload) {
    return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  }

  function sessionFor(request) {
    const token = cookieValue(request);
    const separator = token.lastIndexOf('.');
    if (separator < 1) return null;
    const payload = token.slice(0, separator), signature = token.slice(separator + 1);
    if (!safeEqual(signature, sign(payload))) return null;
    const session = sessions.get(payload);
    if (!session || session.expiresAt <= Date.now()) {
      sessions.delete(payload);
      return null;
    }
    return { payload, ...session };
  }

  function sendJson(response, status, data, headers = {}) {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    });
    response.end(JSON.stringify(data));
  }

  function cookieHeader(value, maxAge) {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${options.cookieSecure ? '; Secure' : ''}`;
  }

  function originMatches(request) {
    const origin = request.headers.origin;
    if (!origin || !request.headers.host) return false;
    try {
      const parsed = new URL(origin);
      return parsed.host.toLowerCase() === request.headers.host.toLowerCase()
        && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
    } catch {
      return false;
    }
  }

  function readJson(request) {
    return new Promise((resolve, reject) => {
      let body = '';
      request.on('data', chunk => {
        body += chunk;
        if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
          reject(new Error('Request body is too large.'));
          request.destroy();
        }
      });
      request.on('end', () => {
        if (!body) return resolve({});
        try { resolve(JSON.parse(body)) }
        catch { reject(new Error('Request must contain valid JSON.')) }
      });
      request.on('error', reject);
    });
  }

  function allowLogin(address) {
    const now = Date.now();
    const attempts = (loginAttempts.get(address) || []).filter(at => now - at < LOGIN_WINDOW_MS);
    loginAttempts.set(address, attempts);
    return attempts.length < LOGIN_MAX_ATTEMPTS;
  }

  async function proxyTerminal(endpoint, method, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await upstreamFetch(new URL(endpoint, terminal), {
        method, cache: 'no-store', signal: controller.signal,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.apiToken ? { Authorization: `Bearer ${options.apiToken}` } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Terminal returned HTTP ${response.status}`);
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");

    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return sendJson(response, 200, {
        service: 'itr-admin',
        terminal: { available: terminalHealth.ok, checkedAt: terminalHealth.checkedAt }
      });
    }
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      return fs.createReadStream(path.join(ASSET_DIR, 'index.html')).pipe(response);
    }
    if (request.method === 'GET' && ['/admin.css', '/admin.js'].includes(url.pathname)) {
      const asset = path.join(ASSET_DIR, path.basename(url.pathname));
      response.writeHead(200, { 'Content-Type': MIME[path.extname(asset)], 'Cache-Control': 'no-cache' });
      return fs.createReadStream(asset).pipe(response);
    }

    const address = request.socket.remoteAddress || 'unknown';
    if (request.method === 'POST') {
      if (!originMatches(request)) return sendJson(response, 403, { error: 'Request origin was not accepted.' });
      if ((request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        return sendJson(response, 415, { error: 'Content-Type must be application/json.' });
      }
      let body;
      try { body = await readJson(request) }
      catch (error) { return sendJson(response, 400, { error: error.message }) }

      if (url.pathname === '/api/login') {
        if (!allowLogin(address)) return sendJson(response, 429, { error: 'Too many sign-in attempts. Wait 15 minutes and try again.' });
        loginAttempts.get(address).push(Date.now());
        const candidate = passwordKey(String(body.password || ''), Buffer.from(state.auth.salt, 'base64'));
        const valid = safeEqual(body.username || '', state.auth.username)
          && safeEqual(candidate.subarray(0, 32).toString('base64'), state.auth.verifier);
        if (!valid) return sendJson(response, 401, { error: 'Username or password is incorrect.' });
        loginAttempts.delete(address);
        const payload = `${Date.now()}.${crypto.randomBytes(24).toString('base64url')}`;
        sessions.set(payload, { username: state.auth.username, expiresAt: Date.now() + SESSION_TTL_MS, key: candidate.subarray(32) });
        return sendJson(response, 200, { username: state.auth.username }, { 'Set-Cookie': cookieHeader(`${payload}.${sign(payload)}`, Math.floor(SESSION_TTL_MS / 1000)) });
      }

      const session = sessionFor(request);
      if (!session) return sendJson(response, 401, { error: 'Administrator sign-in is required.' }, { 'Set-Cookie': cookieHeader('', 0) });
      if (url.pathname === '/api/logout') {
        sessions.delete(session.payload);
        return sendJson(response, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) });
      }
      if (url.pathname === '/api/profile') {
        if (typeof body.currentPassword !== 'string') return sendJson(response, 400, { error: 'Enter your current password.' });
        const oldKey = passwordKey(body.currentPassword, Buffer.from(state.auth.salt, 'base64'));
        if (!safeEqual(oldKey.subarray(0, 32).toString('base64'), state.auth.verifier)) {
          return sendJson(response, 401, { error: 'Current password is incorrect.' });
        }
        const username = body.username === undefined ? state.auth.username : String(body.username).trim();
        if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) return sendJson(response, 400, { error: 'Username must be 3–64 letters, numbers, dots, underscores or hyphens.' });
        const newPassword = body.newPassword || body.currentPassword;
        if (typeof newPassword !== 'string' || newPassword.length < 14 || newPassword.length > 256) {
          return sendJson(response, 400, { error: 'New password must be at least 14 characters and no longer than 256.' });
        }
        const salt = crypto.randomBytes(16);
        const newKey = passwordKey(newPassword, salt);
        let existingSettings;
        try { existingSettings = openSettings(state.encryptedSettings, oldKey.subarray(32)) }
        catch (error) { return sendJson(response, 500, { error: `Could not decrypt saved settings: ${error.message}` }) }
        const nextState = {
          ...state,
          auth: { username, salt: salt.toString('base64'), verifier: newKey.subarray(0, 32).toString('base64') },
          encryptedSettings: sealSettings(existingSettings, newKey.subarray(32))
        };
        try {
          const temporary = `${dataFile}.${process.pid}.tmp`;
          fs.writeFileSync(temporary, JSON.stringify(nextState), { mode: 0o600 });
          fs.renameSync(temporary, dataFile);
          state = nextState;
        } catch (error) {
          return sendJson(response, 500, { error: `Could not securely save profile: ${error.message}` });
        }
        sessions.clear();
        const payload = `${Date.now()}.${crypto.randomBytes(24).toString('base64url')}`;
        const expiresAt = Date.now() + SESSION_TTL_MS;
        sessions.set(payload, { username, expiresAt, key: newKey.subarray(32) });
        return sendJson(response, 200, { username }, {
          'Set-Cookie': cookieHeader(`${payload}.${sign(payload)}`, Math.floor(SESSION_TTL_MS / 1000))
        });
      }
      if (url.pathname === '/api/settings') {
        let previous;
        try {
          previous = openSettings(state.encryptedSettings, session.key);
        } catch (error) {
          return sendJson(response, 500, { error: `Could not decrypt integration settings: ${error.message}` });
        }
        let next;
        try { next = validateSettings(body, previous) }
        catch (error) { return sendJson(response, 400, { error: error.message }) }
        const nextState = { ...state, encryptedSettings: sealSettings(next, session.key) };
        try {
          const temporary = `${dataFile}.${process.pid}.tmp`;
          fs.writeFileSync(temporary, JSON.stringify(nextState), { mode: 0o600 });
          fs.renameSync(temporary, dataFile);
          state = nextState;
          return sendJson(response, 200, publicSettings(next));
        } catch (error) {
          return sendJson(response, 500, { error: `Could not save integration settings: ${error.message}` });
        }
      }
      if (url.pathname === '/api/robot/config') {
        if (typeof body.enabled !== 'boolean') return sendJson(response, 400, { error: 'enabled must be a boolean.' });
        try { return sendJson(response, 200, await proxyTerminal('/robot/config', 'POST', { enabled: body.enabled })) }
        catch (error) { return sendJson(response, 502, { error: `Terminal control request failed: ${error.message}` }) }
      }
      return sendJson(response, 404, { error: 'Admin API route not found.' });
    }

    if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' });
    if (url.pathname === '/api/session') {
      const session = sessionFor(request);
      if (!session) return sendJson(response, 401, { error: 'Sign-in required.' });
      return sendJson(response, 200, { username: session.username, expiresAt: session.expiresAt });
    }
    if (url.pathname === '/api/profile') {
      const session = sessionFor(request);
      if (!session) return sendJson(response, 401, { error: 'Sign-in required.' });
      return sendJson(response, 200, { username: session.username });
    }
    if (url.pathname === '/api/settings') {
      const session = sessionFor(request);
      if (!session) return sendJson(response, 401, { error: 'Sign-in required.' });
      try {
        return sendJson(response, 200, publicSettings(openSettings(state.encryptedSettings, session.key)));
      } catch (error) {
        return sendJson(response, 500, { error: `Could not decrypt integration settings: ${error.message}` });
      }
    }
    const protectedRoutes = {
      '/api/status': '/status',
      '/api/account': '/account',
      '/api/robot': '/robot'
    };
    if (Object.hasOwn(protectedRoutes, url.pathname)) {
      if (!sessionFor(request)) return sendJson(response, 401, { error: 'Sign-in required.' });
      try {
        const data = await proxyTerminal(protectedRoutes[url.pathname], 'GET');
        if (url.pathname === '/api/status') {
          terminalHealth = { ok: true, error: '', checkedAt: new Date().toISOString() };
        }
        return sendJson(response, 200, data);
      } catch (error) {
        terminalHealth = { ok: false, error: error.message, checkedAt: new Date().toISOString() };
        return sendJson(response, 502, { error: `Terminal service unavailable: ${error.message}` });
      }
    }
    return sendJson(response, 404, { error: 'Not found.' });
  });

  return server;
}

if (require.main === module) {
  require('dotenv').config({ path: path.join(ROOT, '.env') });
  const port = +(process.env.ADMIN_PORT || 4200);
  const host = process.env.ADMIN_HOST || '127.0.0.1';
  const options = {
    username: process.env.ADMIN_USERNAME || '',
    password: process.env.ADMIN_PASSWORD || '',
    terminalUrl: process.env.ADMIN_TERMINAL_URL || 'http://127.0.0.1:4100',
    apiToken: process.env.API_TOKEN || '',
    port,
    host,
    cookieSecure: process.env.ADMIN_COOKIE_SECURE === '1'
  };
  try {
    const server = createAdminServer(options);
    server.listen(port, host, () => {
      console.log(`ITR standalone admin portal listening at ${options.cookieSecure ? 'https' : 'http'}://${host}:${port}`);
    });
    server.on('error', error => {
      console.error(`Admin service failed to listen: ${error.message}`);
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(`Admin service configuration error: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { createAdminServer, validateOptions };
