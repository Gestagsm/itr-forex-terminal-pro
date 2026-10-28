/* common.js — haddii server-ku ma socdo (ama bogga si toos ah loo furay), farriin cad ayaa soo baxda */
(function () {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(8,10,13,.97);z-index:9999;display:none;align-items:center;justify-content:center;padding:20px;font-family:Segoe UI,Arial,sans-serif';
  ov.innerHTML = `<div style="max-width:620px;background:#161b22;border:1px solid #df294a;border-radius:10px;padding:28px;color:#e1e4e6;line-height:1.55">
    <h2 style="margin:0 0 10px;color:#ff6b81">⚠ Barnaamijka (server-ka) ma socdo</h2>
    <div id="ovmsg"></div>
    <ol style="padding-left:20px"><li><b>itr-forex-terminal.exe</b> double-click ku dhufo — <i>ama</i> <b>start.bat</b> (waxay u baahan tahay Node.js 18+)</li>
    <li>Daaqadda madow (console) ha xidhin — waa inay furan tahay</li><li>Browser-ka ka fur: <a href="http://localhost:4100" style="color:#4f9bf7">http://localhost:4100</a></li></ol>
    <div style="color:#8a96a3;font-size:12px">Ha furin <code>index.html</code> si toos ah (double-click) — suuqyada, trading-ka, History-ga iyo faylasha folders-ka waxay ka yimaadaan server-ka oo kaliya.</div>
    <div style="margin-top:14px"><a href="http://localhost:4100" style="background:#4f9bf7;color:#0c0f12;padding:9px 16px;border-radius:5px;font-weight:bold;text-decoration:none">Isku day mar kale</a></div></div>`;
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(ov));
  const show = m => { ov.style.display = 'flex'; ov.querySelector('#ovmsg').innerHTML = m || '' }, hide = () => { ov.style.display = 'none' };
  if (location.protocol === 'file:') { document.addEventListener('DOMContentLoaded', () => show('<b>Faylkan si toos ah ayaad u furtay (file://).</b> Waa inaad marka hore server-ka shido.')); return }
  window.itrPublicApiBase = location.hostname === 'gestagsm.github.io' ? 'https://itr.iibshe.com' : '';
  const of = window.fetch; let fails = 0, authState = false, authConfigured = false, authPrompt = null;
  const updateAuthButtons = () => document.querySelectorAll('[data-api-auth]').forEach(button => {
    button.textContent = authState ? 'Sign out' : authConfigured ? 'Admin / private access' : 'Private controls unavailable';
    button.disabled = !authState && !authConfigured;
    button.setAttribute('aria-label', authState ? 'Sign out of private terminal access' : 'Sign in for private terminal access');
  });
  const updatePrivateControls = () => {
    if (document.body) document.body.classList.toggle('api-authenticated', authState);
    document.querySelectorAll('[data-private-control], .private-controls button, .private-controls input, .private-controls select').forEach(control => {
      control.disabled = !authState;
    });
  };
  function requestAccess() {
    if (authState) return Promise.resolve(true);
    if (!authConfigured) return Promise.resolve(false);
    if (authPrompt) return authPrompt;
    authPrompt = new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(8,10,13,.78);z-index:10001;display:flex;align-items:center;justify-content:center;padding:20px;font-family:Segoe UI,Arial,sans-serif';
      overlay.innerHTML = `<form style="width:min(420px,100%);background:#161b22;border:1px solid #39434d;border-radius:10px;padding:22px;color:#e1e4e6">
        <h2 style="margin:0 0 8px">Private terminal access</h2>
        <p style="color:#9aa6b2;font-size:13px">Enter the API_TOKEN configured by the terminal operator. Market prices, charts, and TAQ Pro / TAS Pro / GCV live feeds are public read-only. Sign-in is only for account data, controls, configuration, and private files.</p>
        <label for="itr-api-token">Access credential</label>
        <input id="itr-api-token" type="password" autocomplete="current-password" required style="display:block;box-sizing:border-box;width:100%;margin:6px 0 10px;padding:10px;background:#0c0f12;color:#e1e4e6;border:1px solid #39434d;border-radius:5px">
        <div data-auth-error role="alert" style="min-height:18px;color:#ff6b81;font-size:13px;margin-bottom:8px"></div>
        <div style="display:flex;justify-content:flex-end;gap:8px"><button type="button" data-auth-cancel>Cancel</button><button type="submit">Sign in</button></div>
      </form>`;
      const form = overlay.querySelector('form'), input = overlay.querySelector('input'), message = overlay.querySelector('[data-auth-error]');
      let finished = false;
      const finish = value => {
        if (finished) return;
        finished = true;
        overlay.remove();
        authPrompt = null;
        resolve(value);
      };
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const submit = form.querySelector('[type="submit"]');
        submit.disabled = true;
        message.textContent = '';
        try {
          const response = await of('/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: input.value })
          });
          const result = await response.json();
          if (!response.ok) { message.textContent = result.error || 'Sign-in failed.'; return }
          authState = true;
          updateAuthButtons();
          updatePrivateControls();
          window.dispatchEvent(new Event('itr-authenticated'));
          finish(true);
        } catch (error) {
          message.textContent = error.message;
        } finally {
          if (!finished) submit.disabled = false;
        }
      });
      form.querySelector('[data-auth-cancel]').addEventListener('click', () => finish(false));
      document.body.appendChild(overlay);
      input.focus();
    });
    return authPrompt;
  }
  window.requestIAuth = requestAccess;
  window.itrHasPrivateAccess = () => authState;
  window.itrAuthReady = of('/auth/session').then(response => response.json()).then(result => {
    authState = result.authenticated === true;
    authConfigured = result.configured === true;
    updateAuthButtons();
    updatePrivateControls();
  }).catch(() => {});
  function authPath(input) {
    try { return new URL(typeof input === 'string' ? input : input.url, location.href).pathname }
    catch { return '' }
  }
  async function updatePublicFeedStatus() {
    const databaseStatus = document.getElementById('dbstat'), feedStatus = document.getElementById('fstat');
    if (!databaseStatus && !feedStatus) return;
    const setBadge = (target, label, state, title) => {
      const badge = document.createElement('span');
      badge.className = `fp ${state}`;
      badge.textContent = label;
      badge.title = title;
      target.appendChild(badge);
    };
    try {
      const response = await of(`${window.itrPublicApiBase}/public/status`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const status = await response.json();
      if (databaseStatus) {
        databaseStatus.replaceChildren();
        setBadge(databaseStatus, `DB ${status.connected ? '✓' : '✖'}`, status.connected ? 'ok' : 'bad',
          status.connected ? 'PostgreSQL connected' : 'PostgreSQL disconnected');
      }
      if (feedStatus) {
        feedStatus.replaceChildren();
        for (const dataset of ['TAQ', 'TAS', 'GCV']) {
          const feed = status.feeds.find(item => item.ds === dataset);
          const fresh = feed?.freshness === 'fresh';
          const label = feed?.freshness === 'fresh' ? '✓' : feed?.freshness === 'paused' ? 'Ⅱ' : '✖';
          const detail = feed?.freshness || 'unavailable';
          setBadge(feedStatus, `${dataset} ${label}`, fresh ? 'ok' : 'bad',
            `${dataset}: ${detail}${feed?.updatedAt ? ` · ${feed.updatedAt}` : ''}`);
        }
      }
    } catch (error) {
      if (databaseStatus) {
        databaseStatus.replaceChildren();
        setBadge(databaseStatus, 'DB ?', '', `Database status unavailable: ${error.message}`);
      }
      if (feedStatus) {
        feedStatus.replaceChildren();
        for (const dataset of ['TAQ', 'TAS', 'GCV']) setBadge(feedStatus, `${dataset} ?`, '', 'Feed status unavailable');
      }
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    updatePublicFeedStatus();
    setInterval(updatePublicFeedStatus, 2000);
    document.querySelectorAll('[data-api-auth]').forEach(button => button.addEventListener('click', async () => {
      if (!authState) return requestAccess();
      try {
        const response = await of('/auth/logout', { method: 'POST' });
        if (!response.ok && response.status !== 401) return;
        authState = false;
        updateAuthButtons();
        updatePrivateControls();
        window.dispatchEvent(new Event('itr-logged-out'));
      } catch (error) { show(error.message) }
    }));
    updateAuthButtons();
    updatePrivateControls();
    new MutationObserver(updatePrivateControls).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('click', async event => {
      const link = event.target.closest('a[href]');
      if (!link) return;
      const url = new URL(link.href, location.href);
      if (!(url.pathname.startsWith('/download/') || url.pathname.startsWith('/export/')
        || url.pathname === '/history/query' && url.searchParams.get('format') === 'csv') || authState) return;
      event.preventDefault();
      if (await requestAccess()) location.assign(url.href);
    });
    window.itrAuthReady.then(() => { updateAuthButtons(); updatePrivateControls() });
  });
  window.fetch = async (...args) => {
    try {
      let response = await of(...args);
      const path = authPath(args[0]);
      if (response.status === 401 && !path.startsWith('/auth/')) {
        if (authState) {
          authState = false;
          updateAuthButtons();
          updatePrivateControls();
          window.dispatchEvent(new Event('itr-logged-out'));
        }
        if (authConfigured && window.navigator.userActivation && window.navigator.userActivation.isActive
          && await requestAccess()) response = await of(...args);
      }
      fails = 0;
      hide();
      return response;
    } catch (error) {
      if (++fails >= 2) show('Isku-xirka server-ka waa go\'ay.');
      throw error;
    }
  };
})();
