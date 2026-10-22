(() => {
  const $ = id => document.getElementById(id), api = (p, b) => fetch(p, b ? { method: 'POST' } : undefined).then(r => r.json()), n = x => Number(x).toLocaleString(), esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/ /g, '&nbsp;');
  $('start').onclick = () => api('/start', 1); $('stop').onclick = () => api('/stop', 1); let init = false;
  async function refresh() {
    if (!window.itrHasPrivateAccess()) return;
    try {
      const [s, c] = await Promise.all([api('/status'), api('/config')]); $('conn').textContent = s.running ? '● LIVE' : '■ Stopped'; $('conn').className = 'pill ' + (s.running ? 'on' : 'off');
      if (!init) { $('rsym').innerHTML = s.symbols.map(x => `<option>${x}</option>`).join(''); init = true }
      $('folders').innerHTML = s.datasets.map(d => { const st = s.streams.filter(x => x.ds === d), last = st.map(x => x.lastWrite).filter(Boolean).sort().pop() || '—', er = st.find(x => x.csvError);
        return `<div class="box"><h3>${d} folder</h3><div style="font:12px monospace;word-break:break-all">${esc(c.folders[d].path)}</div><div style="margin-top:8px"><span class="pill ${c.folders[d].custom ? 'on' : ''}">${c.folders[d].custom ? 'la doortay' : 'default'}</span> <span class="mut">qoritaankii u dambeeyay: <b class="up">${last}</b></span></div>${er ? `<div class="err">⚠ CSV: ${esc(er.csvError)}</div>` : ''}</div>` }).join('');
      $('st').innerHTML = s.streams.map(x => `<tr><td><b>${x.ds}</b></td><td>${x.sym}</td><td>${n(x.generated)}</td><td class="up">${n(x.sent)}</td><td>${n(x.queued)}</td><td class="${x.failed ? 'down' : ''}">${n(x.failed)}</td><td>${x.lastWrite || '—'}</td><td class="mut">${x.block.slice(-17)}</td><td>${x.xlsxAt || '—'}</td><td>${x.files}</td><td class="err">${esc(x.lastError || x.csvError || x.xlsxError)}</td></tr>`).join('');
      const ds = $('rds').value, sy = $('rsym').value, r = await api(`/recent?ds=${ds}&symbol=${sy}`); $('xx').href = `/export/${ds}/${sy}`; $('xc').href = `/export/${ds}/${sy}?format=csv`;
      $('rth').innerHTML = '<tr>' + r.cols.map(c => `<th>${c}</th>`).join('') + '</tr>'; $('rtb').innerHTML = r.rows.map(x => '<tr>' + r.cols.map(c => `<td>${esc(x[c])}</td>`).join('') + '</tr>').join('');
    } catch (e) { $('conn').textContent = 'offline'; $('conn').className = 'pill off' }
  }
  async function files() { if (!window.itrHasPrivateAccess()) return; try { const f = await api('/files'); $('files').innerHTML = Object.entries(f).map(([d, m]) => `<div><b>${d}</b>` + Object.entries(m).map(([sy, l]) => `<details><summary>${sy} <span class="mut">(${l.length})</span></summary>` + l.map(x => `<div><a href="/download/${d}/${sy}/${encodeURIComponent(x.name)}">${x.name}</a> <span class="mut">${(x.size / 1024).toFixed(0)} KB</span></div>`).join('') + '</details>').join('') + '</div>').join('') } catch (e) {} }
  window.itrAuthReady.then(() => {
    if (window.itrHasPrivateAccess()) { refresh(); files() }
    else $('conn').textContent = 'Sign in for private feed controls';
  });
  window.addEventListener('itr-authenticated', () => { refresh(); files() });
  setInterval(() => { if (window.itrHasPrivateAccess()) refresh() }, 1000);
  setInterval(() => { if (window.itrHasPrivateAccess()) files() }, 10000);
  addEventListener('folders-changed', () => setTimeout(refresh, 500));
})();
