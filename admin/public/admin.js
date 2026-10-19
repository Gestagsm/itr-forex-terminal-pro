(() => {
  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const api = async (url, body) => {
    const response = await fetch(url, body
      ? { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  };
  let robot = null, loading = false, refreshTimer = null;

  function signedOut() {
    clearInterval(refreshTimer);
    $('dashboard-view').hidden = true;
    $('login-view').hidden = false;
    $('password').value = '';
    $('username').focus();
  }

  function renderFeeds(status) {
    const streams = status.streams || [];
    const healthy = streams.filter(stream => !stream.lastError && !stream.csvError).length;
    $('feed-summary').textContent = `${healthy} / ${streams.length} feeds healthy`;
    $('feed-list').innerHTML = streams.map(stream => {
      const ok = !stream.lastError && !stream.csvError;
      const note = stream.lastError || stream.csvError || (stream.lastWrite ? `Last write ${stream.lastWrite}` : 'Waiting for first write');
      return `<article class="feed"><div class="feed-head"><span>${escapeHtml(stream.ds)} <span class="subtle">/</span> ${escapeHtml(stream.sym)}</span><span class="feed-badge ${ok ? '' : 'issue'}">${ok ? '● Online' : '● Issue'}</span></div><small>${escapeHtml(note)} · ${Number(stream.queued) || 0} queued</small></article>`;
    }).join('') || '<p class="subtle">No data streams configured.</p>';
  }

  function showDashboard(username) {
    $('login-view').hidden = true;
    $('dashboard-view').hidden = false;
    $('admin-user').textContent = username;
    refresh();
    refreshTimer = setInterval(refresh, 8000);
  }

  function showView(viewName) {
    document.querySelectorAll('.portal-view').forEach(view => { view.hidden = view.id !== `view-${viewName}` });
    document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === viewName));
    if (viewName === 'profile') loadProfile();
    if (viewName === 'settings') loadSettings();
  }

  async function loadProfile() {
    $('profile-message').textContent = '';
    try {
      const profile = await api('/api/profile');
      $('profile-username').value = profile.username;
      $('profile-current-password').value = '';
      $('profile-new-password').value = '';
      $('profile-confirm-password').value = '';
    } catch (error) {
      if (error.status === 401) signedOut();
      else $('profile-message').textContent = error.message;
    }
  }

  async function loadSettings() {
    $('settings-message').textContent = 'Loading saved configuration…';
    try {
      const settings = await api('/api/settings');
      $('ai-provider').value = settings.ai.provider;
      $('ai-model').value = settings.ai.model;
      $('ai-api-key').value = '';
      $('ai-key-status').textContent = settings.ai.hasApiKey ? 'Key stored · hidden' : 'No key stored';
      $('ai-clear-key').checked = false;
      $('broker-provider').value = settings.broker.provider;
      $('broker-environment').value = settings.broker.environment;
      $('broker-account').value = settings.broker.accountId;
      $('broker-api-key').value = '';
      $('broker-access-token').value = '';
      $('broker-key-status').textContent = settings.broker.hasApiKey ? 'Key stored · hidden' : 'No key stored';
      $('broker-token-status').textContent = settings.broker.hasAccessToken ? 'Token stored · hidden' : 'No token stored';
      $('broker-clear-key').checked = false;
      $('broker-clear-token').checked = false;
      $('settings-message').textContent = settings.integrationsActive
        ? 'Provider adapters are active.'
        : 'Settings are stored securely; provider connections are not active.';
    } catch (error) {
      if (error.status === 401) signedOut();
      else $('settings-message').textContent = error.message;
    }
  }

  async function refresh() {
    if (loading || $('dashboard-view').hidden) return;
    loading = true;
    $('dashboard-error').textContent = '';
    try {
      const [status, account, robotStatus] = await Promise.all([
        api('/api/status'), api('/api/account'), api('/api/robot')
      ]);
      const db = status.database || {};
      $('connection').className = 'status online';
      $('connection').innerHTML = '<i></i> Systems connected';
      $('terminal-state').textContent = status.running ? 'Operational' : 'Stopped';
      $('terminal-state').className = status.running ? 'good' : 'bad';
      $('terminal-detail').textContent = `${status.symbols?.length || 0} markets · ${status.datasets?.join(' / ') || 'No feeds'}`;
      $('database-state').textContent = db.historySynced ? 'History synced' : db.connected ? 'Connected · syncing' : db.configured ? 'Unavailable' : 'Not configured';
      $('database-state').className = db.historySynced ? 'good' : db.configured ? 'bad' : '';
      $('database-detail').textContent = db.error || `${Number(db.importedRows) || 0} local rows imported`;
      $('account-state').textContent = `$${Number(account.balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      $('account-detail').textContent = `${account.positions?.length || 0} open demo positions · ${account.orders?.length || 0} pending orders`;
      robot = robotStatus;
      $('robot-state').textContent = robot.enabled ? `Active · ${robot.tf}` : 'Paused';
      $('robot-state').className = robot.enabled ? 'good' : '';
      $('robot-detail').textContent = `${robot.symbols?.length || 0} markets monitored · ${robot.stats?.trades || 0} closed trades`;
      $('robot-toggle').textContent = robot.enabled ? 'Pause demo automation' : 'Enable demo automation';
      $('robot-toggle').disabled = false;
      renderFeeds(status);
      const config = await api('/api/settings');
      const aiNames = { none: 'Not configured', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google Gemini' };
      const brokerNames = { simulated: 'Built-in simulator', oanda: 'OANDA', 'interactive-brokers': 'Interactive Brokers', metatrader5: 'MetaTrader 5' };
      $('ai-integration-state').textContent = config.ai.provider === 'none' ? 'Not configured' : `${aiNames[config.ai.provider] || config.ai.provider} selected`;
      $('ai-integration-detail').textContent = config.ai.provider === 'none'
        ? 'Choose an AI provider and define its role before enabling trading decisions.'
        : `${config.ai.model || 'Model not set'} · ${config.ai.hasApiKey ? 'credential stored' : 'credential missing'} · adapter inactive`;
      $('broker-integration-state').textContent = config.broker.provider === 'simulated'
        ? 'Simulator only' : `${brokerNames[config.broker.provider] || config.broker.provider} selected`;
      $('broker-integration-detail').textContent = config.broker.provider === 'simulated'
        ? 'The terminal currently uses its built-in demo broker. No external broker or live order route is active.'
        : `${config.broker.environment} environment · ${config.broker.hasApiKey || config.broker.hasAccessToken ? 'credential stored' : 'credential missing'} · adapter inactive`;
      $('last-updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      if (error.status === 401) { signedOut(); return }
      $('connection').className = 'status offline';
      $('connection').innerHTML = '<i></i> Service unavailable';
      $('dashboard-error').textContent = `Could not refresh dashboard: ${error.message}`;
    } finally {
      loading = false;
    }
  }

  $('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type=submit]');
    button.disabled = true;
    $('login-error').textContent = '';
    try {
      const session = await api('/api/login', { username: $('username').value, password: $('password').value });
      $('password').value = '';
      showDashboard(session.username);
    } catch (error) {
      $('login-error').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  $('logout').onclick = async () => {
    try { await api('/api/logout', {}) } catch (error) { $('dashboard-error').textContent = error.message }
    signedOut();
  };
  $('refresh').onclick = refresh;
  document.querySelector('.portal-nav').addEventListener('click', event => {
    const button = event.target.closest('[data-view]');
    if (button) showView(button.dataset.view);
  });
  $('profile-form').addEventListener('submit', async event => {
    event.preventDefault();
    const currentPassword = $('profile-current-password').value;
    const newPassword = $('profile-new-password').value;
    if (newPassword && newPassword !== $('profile-confirm-password').value) {
      $('profile-message').textContent = 'New password and confirmation do not match.';
      return;
    }
    const button = event.currentTarget.querySelector('button[type=submit]');
    button.disabled = true;
    $('profile-message').textContent = 'Saving profile…';
    try {
      const profile = await api('/api/profile', {
        username: $('profile-username').value,
        currentPassword,
        newPassword
      });
      $('admin-user').textContent = profile.username;
      $('profile-current-password').value = '';
      $('profile-new-password').value = '';
      $('profile-confirm-password').value = '';
      $('profile-message').textContent = 'Profile saved. Other sessions have been signed out.';
    } catch (error) {
      if (error.status === 401) signedOut();
      else $('profile-message').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  $('settings-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type=submit]');
    button.disabled = true;
    $('settings-message').textContent = 'Encrypting and saving…';
    try {
      const settings = await api('/api/settings', {
        ai: {
          provider: $('ai-provider').value,
          model: $('ai-model').value,
          apiKey: $('ai-api-key').value,
          clearApiKey: $('ai-clear-key').checked
        },
        broker: {
          provider: $('broker-provider').value,
          environment: $('broker-environment').value,
          accountId: $('broker-account').value,
          apiKey: $('broker-api-key').value,
          accessToken: $('broker-access-token').value,
          clearApiKey: $('broker-clear-key').checked,
          clearAccessToken: $('broker-clear-token').checked
        }
      });
      $('ai-api-key').value = '';
      $('broker-api-key').value = '';
      $('broker-access-token').value = '';
      $('ai-key-status').textContent = settings.ai.hasApiKey ? 'Key stored · hidden' : 'No key stored';
      $('broker-key-status').textContent = settings.broker.hasApiKey ? 'Key stored · hidden' : 'No key stored';
      $('broker-token-status').textContent = settings.broker.hasAccessToken ? 'Token stored · hidden' : 'No token stored';
      $('settings-message').textContent = 'Configuration encrypted and saved. Integrations remain disconnected.';
    } catch (error) {
      if (error.status === 401) signedOut();
      else $('settings-message').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  $('robot-toggle').onclick = async () => {
    if (!robot) return;
    $('robot-toggle').disabled = true;
    try {
      robot = await api('/api/robot/config', { enabled: !robot.enabled });
      $('robot-state').textContent = robot.enabled ? `Active · ${robot.tf}` : 'Paused';
      $('robot-state').className = robot.enabled ? 'good' : '';
      $('robot-toggle').textContent = robot.enabled ? 'Pause demo automation' : 'Enable demo automation';
      $('dashboard-error').textContent = '';
    } catch (error) {
      $('dashboard-error').textContent = `Could not change demo automation: ${error.message}`;
    } finally {
      $('robot-toggle').disabled = false;
    }
  };

  api('/api/session').then(session => showDashboard(session.username)).catch(error => {
    $('login-view').hidden = false;
    $('dashboard-view').hidden = true;
    if (error.status !== 401) $('login-error').textContent = `Admin service unavailable: ${error.message}`;
  });
})();
