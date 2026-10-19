/* folders.js — dooro folder-ka TAQ / TAS / GCV (server-ka folder browser) */
(function () {
  const DS = ['TAQ', 'TAS', 'GCV'], state = { cur: null, ds: null };
  const el = h => { const d = document.createElement('div'); d.innerHTML = h.trim(); return d.firstChild };
  const modal = el(`<div class="modal" id="fmodal"><div class="mbox">
    <h2>📁 Folders-ka xogta (TAQ · TAS · GCV)</h2>
    <div class="mut">Ilbiriqsi kasta xogta live ayaa lagu qoraa folder-ka aad dooratid (<code>&lt;folder&gt;/&lt;SYMBOL&gt;/..._LIVE.csv</code>), 4-saac kasta waxaa laga sameeyaa Excel (.xlsx).</div>
    <div id="fnote" class="okm" style="margin:8px 0"></div><div id="frows"></div>
    <div id="fbrowser" style="display:none"><hr style="border-color:#2d343c"><div class="row"><b id="fbt">Dooro folder</b></div>
      <div class="row"><button class="btn sm" id="fup">⬆ Up</button><input id="fpath" readonly></div><div class="dirs" id="fdirs"></div>
      <div class="row"><button class="btn green sm" id="fsel">✓ Dooro folder-kan</button><button class="btn sm" id="fcancel">Jooji</button></div></div>
    <div id="fmsg" class="mut"></div>
    <div class="row" style="justify-content:flex-end"><button class="btn" id="freset">Default</button><button class="btn green" id="fapply">✓ Apply</button><button class="btn" id="fclose">Xidh</button></div>
  </div></div>`);
  document.body.appendChild(modal);
  const $ = id => modal.querySelector('#' + id), api = (p, b) => fetch(p, b ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) } : undefined).then(r => r.json());
  async function show(first) {
    const c = await api('/config'); state.first = first === true && !c.setupDone;
    $('frows').innerHTML = DS.map(d => `<div class="row"><b style="width:44px">${d}</b><input id="in${d}" value="${c.folders[d].path}"><button class="btn sm" data-b="${d}">Browse…</button><span class="pill ${c.folders[d].custom ? 'on' : ''}">${c.folders[d].custom ? 'la doortay' : 'default'}</span></div>`).join('');
    $('frows').querySelectorAll('[data-b]').forEach(b => b.onclick = () => browse(b.dataset.b, $('in' + b.dataset.b).value));
    $('fbrowser').style.display = 'none'; $('fmsg').textContent = ''; $('fnote').textContent = state.first ? '👋 Marka ugu horreysay: dooro halka xogta lagu qorayo (ama riix Xidh si aad u isticmaasho folders-ka default-ka ah).' : ''; modal.classList.add('show');
  }
  async function browse(ds, p) {
    state.ds = ds; const r = await api('/fs/list?path=' + encodeURIComponent(p || '')); if (r.error) { $('fmsg').innerHTML = `<span class="err">${r.error}</span>`; return }
    state.cur = r; $('fbrowser').style.display = 'block'; $('fbt').textContent = 'Dooro folder: ' + ds; $('fpath').value = r.path;
    const sep = r.path.includes('\\') ? '\\' : '/', join = n => (r.path === '' ? n : (r.path.endsWith(sep) ? r.path + n : r.path + sep + n));
    $('fdirs').innerHTML = r.dirs.map(n => `<div data-n="${n}">📁 ${n}</div>`).join('') || '<div class="mut">(folder hoose ma jiro)</div>';
    $('fdirs').querySelectorAll('[data-n]').forEach(x => x.onclick = () => browse(ds, join(x.dataset.n)));
  }
  $('fup').onclick = () => state.cur && state.cur.parent !== null && browse(state.ds, state.cur.parent);
  $('fsel').onclick = () => { if (state.cur && state.cur.path) { $('in' + state.ds).value = state.cur.path; $('fbrowser').style.display = 'none' } };
  $('fcancel').onclick = () => $('fbrowser').style.display = 'none'; $('fclose').onclick = async () => { modal.classList.remove('show'); if (state.first) { state.first = false; await api('/config/setup-done', {}) } };
  $('freset').onclick = () => DS.forEach(d => $('in' + d).value = '');
  $('fapply').onclick = async () => {
    const body = {}; DS.forEach(d => body[d] = $('in' + d).value.trim()); const r = await api('/config/folders', body);
    if (r.error) $('fmsg').innerHTML = `<span class="err">✖ ${r.error}</span>`; else { $('fmsg').innerHTML = '<span class="okm">✔ Waa la dhigay — xogta hadda waxay ku dhacaysaa folders-kan</span>'; setTimeout(show, 900); window.dispatchEvent(new Event('folders-changed')) }
  };
  window.openFolders = show;
})();
