(() => {
  const $ = id => document.getElementById(id);
  const api = async (path, options) => {
    const response = await fetch(path, options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  };
  const n = value => Number(value).toLocaleString();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]).replace(/ /g, '&nbsp;');
  const feedName = ds => ({ TAQ: 'TAQ Pro', TAS: 'TAS Pro', GCV: 'GCV' }[ds] || ds);
  let symbolsInitialized = false;

  $('start').onclick = () => api('/start', { method: 'POST' });
  $('stop').onclick = () => api('/stop', { method: 'POST' });

  async function refreshPublic() {
    try {
      const [status, prices] = await Promise.all([api('/public/status'), api('/prices')]);
      $('conn').textContent = status.connected
        ? status.marketRunning ? '● Database connected · feeds live' : '● Database connected · feeds paused'
        : status.marketRunning ? 'Database disconnected · feeds not stored' : 'Database disconnected';
      $('conn').className = `pill ${status.connected ? 'on' : 'off'}`;
      if (!symbolsInitialized) {
        $('rsym').innerHTML = Object.keys(prices).map(symbol => `<option>${esc(symbol)}</option>`).join('');
        symbolsInitialized = true;
      }
      $('feeds').innerHTML = ['TAQ', 'TAS', 'GCV'].map(ds => {
        const feed = status.feeds.find(item => item.ds === ds);
        const state = feed ? feed.freshness : 'waiting';
        const latest = feed?.updatedAt ? new Date(feed.updatedAt).toLocaleTimeString() : '—';
        const label = { fresh: 'LIVE · fresh', stale: 'STALE', paused: 'PAUSED', waiting: 'Waiting for data' }[state] || state;
        return `<div class="box"><h3>${feedName(ds)}</h3><div class="pill ${state === 'fresh' ? 'on' : 'off'}">${label}</div><div class="mut" style="margin-top:8px">Last update ${esc(latest)}</div></div>`;
      }).join('');
      const ds = $('rds').value, symbol = $('rsym').value;
      const recent = await api(`/public/recent?ds=${encodeURIComponent(ds)}&symbol=${encodeURIComponent(symbol)}`);
      $('rth').innerHTML = '<tr>' + recent.cols.map(column => `<th>${esc(column)}</th>`).join('') + '</tr>';
      $('rtb').innerHTML = recent.rows.map(row => '<tr>' + recent.cols.map(column => `<td>${esc(row[column])}</td>`).join('') + '</tr>').join('');
    } catch (error) {
      $('conn').textContent = 'Public feed unavailable';
      $('conn').className = 'pill off';
      $('feeds').textContent = error.message;
    }
  }

  async function refreshPrivate() {
    if (!window.itrHasPrivateAccess()) return;
    const [status, config] = await Promise.all([api('/status'), api('/config')]);
    $('folders').innerHTML = status.datasets.map(dataset => {
      const streams = status.streams.filter(stream => stream.ds === dataset);
      const lastWrite = streams.map(stream => stream.lastWrite).filter(Boolean).sort().pop() || '—';
      const error = streams.find(stream => stream.csvError);
      const folder = config.folders[dataset];
      return `<div class="box"><h3>${esc(dataset)} folder</h3><div style="font:12px monospace;word-break:break-all">${esc(folder.path)}</div><div style="margin-top:8px"><span class="pill ${folder.custom ? 'on' : ''}">${folder.custom ? 'la doortay' : 'default'}</span> <span class="mut">qoritaankii u dambeeyay: <b class="up">${esc(lastWrite)}</b></span></div>${error ? `<div class="err">⚠ CSV: ${esc(error.csvError)}</div>` : ''}</div>`;
    }).join('');
    $('st').innerHTML = status.streams.map(stream => `<tr><td><b>${esc(stream.ds)}</b></td><td>${esc(stream.sym)}</td><td>${n(stream.generated)}</td><td class="up">${n(stream.sent)}</td><td>${n(stream.queued)}</td><td class="${stream.failed ? 'down' : ''}">${n(stream.failed)}</td><td>${esc(stream.lastWrite || '—')}</td><td class="mut">${esc(stream.block.slice(-17))}</td><td>${esc(stream.xlsxAt || '—')}</td><td>${n(stream.files)}</td><td class="err">${esc(stream.lastError || stream.csvError || stream.xlsxError)}</td></tr>`).join('');
    const ds = $('rds').value, symbol = $('rsym').value;
    $('xx').href = `/export/${encodeURIComponent(ds)}/${encodeURIComponent(symbol)}`;
    $('xc').href = `/export/${encodeURIComponent(ds)}/${encodeURIComponent(symbol)}?format=csv`;
  }

  async function refreshFiles() {
    if (!window.itrHasPrivateAccess()) return;
    const files = await api('/files');
    $('files').innerHTML = Object.entries(files).map(([dataset, symbols]) =>
      `<div><b>${esc(dataset)}</b>` + Object.entries(symbols).map(([symbol, entries]) =>
        `<details><summary>${esc(symbol)} <span class="mut">(${entries.length})</span></summary>` + entries.map(file =>
          `<div><a href="/download/${encodeURIComponent(dataset)}/${encodeURIComponent(symbol)}/${encodeURIComponent(file.name)}">${esc(file.name)}</a> <span class="mut">${(file.size / 1024).toFixed(0)} KB</span></div>`
        ).join('') + '</details>'
      ).join('') + '</div>'
    ).join('');
  }

  async function refreshPrivateView() {
    const isAuthenticated = window.itrHasPrivateAccess();
    $('privateData').hidden = !isAuthenticated;
    if (!isAuthenticated) return;
    try {
      await refreshPrivate();
    } catch (error) {
      $('folders').innerHTML = `<div class="err">${esc(error.message)}</div>`;
    }
  }

  async function refreshPrivateFiles() {
    if (!window.itrHasPrivateAccess()) return;
    try {
      await refreshFiles();
    } catch (error) {
      $('files').textContent = error.message;
    }
  }

  $('rds').onchange = () => {
    refreshPublic();
    refreshPrivateView();
  };
  $('rsym').onchange = () => {
    refreshPublic();
    refreshPrivateView();
  };
  window.itrAuthReady.then(() => {
    refreshPublic();
    refreshPrivateView();
    refreshPrivateFiles();
  });
  window.addEventListener('itr-authenticated', () => {
    refreshPrivateView();
    refreshPrivateFiles();
  });
  window.addEventListener('itr-logged-out', () => {
    $('privateData').hidden = true;
  });
  setInterval(refreshPublic, 2000);
  setInterval(refreshPrivateView, 2000);
  setInterval(refreshPrivateFiles, 10000);
  addEventListener('folders-changed', () => setTimeout(refreshPrivateView, 500));
})();
