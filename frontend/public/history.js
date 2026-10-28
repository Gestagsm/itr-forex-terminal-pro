(() => {
  const $ = id => document.getElementById(id), api = async p => {
    let response;
    try { response = await fetch(`${window.itrPublicApiBase || ''}${p}`, { cache: 'no-store' }) }
    catch (error) {
      if (error instanceof TypeError) throw new Error('Server-ka History lama gaari karo. Hubi isku xirka ama mar kale isku day.');
      throw error;
    }
    let result;
    try { result = await response.json() }
    catch {
      if (!response.ok) throw new Error(`Server-ku wuxuu soo celiyay HTTP ${response.status}.`);
      throw new Error('Jawaabta server-ka ma ahayn JSON sax ah.');
    }
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }, LIM = 200;
  let ds = 'TAQ', idx = {}, offset = 0, total = 0;
  const p2 = n => String(n).padStart(2, '0'), dstr = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/ /g, '&nbsp;');
  const range = () => ({ from: new Date(`${$('d1').value}T${$('t1').value || '00:00:00'}`).getTime(), to: new Date(`${$('d2').value}T${$('t2').value || '23:59:59'}`).getTime() + 1000 });
  const qs = (extra = '') => { const r = range(); return `ds=${ds}&symbol=${$('sym').value}&from=${r.from}&to=${r.to}${extra}` };
  const kb = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';
  const showError = error => {
    $('dbstate').innerHTML = `<span class="err">History lama heli karo: ${esc(error.message)}</span> <button class="btn sm" id="retry-history">Dib u tijaabi</button>`;
    $('retry-history').onclick = () => run(init);
  };
  const run = action => action().catch(showError);
  const setSearchState = (message, loading = false, failed = false) => {
    const state = $('searchstate');
    state.setAttribute('aria-busy', String(loading));
    state.innerHTML = loading
      ? `<span class="history-spinner" aria-hidden="true"></span>${message}`
      : failed
        ? `<span class="err">${esc(message)}</span> <button class="btn sm" id="retry-search">Dib u raadi</button>`
        : esc(message);
    if (failed) $('retry-search').onclick = () => go(offset);
  };
  const setSearchControlsDisabled = disabled => {
    document.querySelectorAll('#dsTabs button, #sym, #d1, #d2, #t1, #t2, #go, #prev, #next, [data-q], #chips button')
      .forEach(control => { control.disabled = disabled });
  };

  async function init() {
    $('dbstate').textContent = 'Xogta History-ga ayaa la soo rarayaa…';
    idx = await api('/history/index');
    const syms = Object.keys(idx[ds] || {});
    if (!syms.length) throw new Error('Liiska suuqyada History-ga waa madhan yahay.');
    $('dbstate').innerHTML = '<span class="mut">Xogta History-ga waa la helay; xaaladda server-ka waa la hubinayaa.</span>';
    api('/public/status').then(status => {
      $('dbstate').innerHTML = status.connected
        ? '<span class="okm">● Database connected</span><span class="mut"> · TAQ, TAS iyo GCV market history</span>'
        : '<span class="err">● Database disconnected</span><span class="mut"> · Xogta taariikhda suuqa ee la heli karo ayaa la soo bandhigayaa</span>';
    }).catch(() => {
      $('dbstate').innerHTML = '<span class="mut">Xogta History-ga waa la helay; xaaladda server-ka lama xaqiijin.</span>';
    });
    $('sym').innerHTML = syms.map(s => `<option>${s}</option>`).join('');
    const t = dstr(new Date()); $('d1').value = $('d2').value = t;
    $('counts').innerHTML = Object.keys(idx).map(n => {
      const datasetSymbols = Object.keys(idx[n] || {});
      return `<div class="box" style="min-width:150px"><b>${n}</b><div class="mut">${datasetSymbols.reduce((a, s) => a + idx[n][s].blocks, 0)} block · ${datasetSymbols.length} suuq</div></div>`;
    }).join('');
    $('dsTabs').innerHTML = Object.keys(idx).map(n => `<button class="btn ${n === ds ? 'blue' : ''}" data-ds="${n}">${n}</button>`).join('');
    $('dsTabs').onclick = e => {
      if (!e.target.dataset.ds) return;
      ds = e.target.dataset.ds;
      document.querySelectorAll('#dsTabs .btn').forEach(b => b.classList.toggle('blue', b.dataset.ds === ds));
      chips(); go(0);
    };
    $('sym').onchange = () => { chips(); go(0) };
    chips();
    await go(0);
  }
  function chips() {
    const d = idx[ds][$('sym').value].dates;
    $('chips').innerHTML = d.map(x => `<button class="btn sm" data-d="${x}">${x}</button>`).join(' ') || '<span class="mut">weli ma jiraan</span>';
    $('chips').onclick = e => {
      if (!e.target.dataset.d) return;
      $('d1').value = $('d2').value = e.target.dataset.d; $('t1').value = '00:00:00'; $('t2').value = '23:59:59'; go(0);
    };
  }
  async function go(o) {
    offset = o; setSearchControlsDisabled(true); setSearchState('Raadinta xogta taariikhda…', true);
    try {
      const r = await api('/history/query?' + qs(`&offset=${o}&limit=${LIM}`)); total = r.total;
      $('th').innerHTML = '<tr>' + r.cols.map(c => `<th>${c}</th>`).join('');
      $('tb').innerHTML = r.rows.map(x => '<tr>' + x.map(v => `<td>${esc(v)}</td>`).join('') + '</tr>').join('') || `<tr><td class="mut" colspan="${r.cols.length}" style="padding:20px;text-align:center">Xog lagama helin waqtigan</td></tr>`;
      $('sum').innerHTML = `<b>${ds} · ${$('sym').value}</b> — <b>${total.toLocaleString()}</b> safaf · ${r.source === 'postgresql' ? 'PostgreSQL' : 'kayd maxalli ah'} ${r.first ? `· ${r.first} → ${r.last}` : ''}`;
      $('pg').textContent = total ? `${offset + 1}–${Math.min(offset + LIM, total)} / ${total.toLocaleString()}` : '';
      $('csv').href = '/history/query?' + qs('&format=csv');
      setSearchState(total ? `Raadintu way dhammaatay · ${total.toLocaleString()} saf ayaa la helay.` : 'Raadintu way dhammaatay; xog lagama helin waqtigan.');
      try { await blocks() }
      catch (error) { $('bl').innerHTML = `<tr><td colspan="6" class="err">Faahfaahinta block-yada lama heli karo: ${esc(error.message)}</td></tr>` }
    } catch (error) {
      setSearchState(`Raadintu way fashilantay: ${error.message}`, false, true);
    } finally { setSearchControlsDisabled(false) }
  }
  async function blocks() {
    const params = `ds=${encodeURIComponent(ds)}&symbol=${encodeURIComponent($('sym').value)}&date=${encodeURIComponent($('d1').value)}`;
    const b = window.itrHasPrivateAccess()
      ? await api(`/history/blocks?${params}`)
      : await api(`/public/history/blocks?${params}`);
    $('bt').textContent = `${ds} · ${$('sym').value} · ${$('d1').value}`;
    $('bl').innerHTML = b.map(x => {
      const fileDetails = x.xlsx
        ? `<a class="btn sm green" href="/download/${encodeURIComponent(ds)}/${encodeURIComponent($('sym').value)}/${encodeURIComponent(x.xlsx)}">⬇ Excel</a>`
        : '<span class="mut">Xog suuqa</span>';
      return `<tr><td>${esc(x.name || `${ds} · ${$('sym').value}`)}</td><td>${esc(x.start)}</td><td>${esc(x.end)}</td><td>${x.size === undefined ? '—' : kb(x.size)}</td><td>${x.live ? '<span class="pill on">LIVE</span>' : '<span class="pill">archived</span>'}</td><td>${fileDetails}</td></tr>`;
    }).join('') || '<tr><td colspan="6" class="mut" style="padding:14px;text-align:center">Block ma jiro maalintan</td></tr>';
  }
  $('go').onclick = () => go(0);
  $('prev').onclick = () => go(Math.max(0, offset - LIM));
  $('next').onclick = () => { if (offset + LIM < total) go(offset + LIM) };
  document.querySelector('[data-q]').parentElement.onclick = e => {
    const q = e.target.dataset.q; if (!q) return;
    const now = new Date(), t = d => `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    if (q === '5m' || q === '1h') { const f = new Date(now - (q === '5m' ? 300e3 : 3600e3)); $('d1').value = dstr(f); $('t1').value = t(f); $('d2').value = dstr(now); $('t2').value = t(now) }
    else if (q === 'today') { $('d1').value = $('d2').value = dstr(now); $('t1').value = '00:00:00'; $('t2').value = '23:59:59' }
    else { const d = idx[ds][$('sym').value].dates; $('d1').value = d[0] || dstr(now); $('d2').value = d[d.length - 1] || dstr(now); $('t1').value = '00:00:00'; $('t2').value = '23:59:59' }
    go(0);
  };
  $('ago').onclick = () => run(async () => {
    const t = new Date(`${$('ad').value}T${$('at').value || '00:00:00'}`).getTime(), r = await api('/history/at?time=' + t);
    $('atsource').textContent = r.source === 'postgresql' ? '· PostgreSQL' : '· kayd maxalli ah';
    $('atb').innerHTML = Object.entries(r.rates).map(([k, v]) => v ? `<tr><td><b>${esc(v.label)}</b></td><td>${v.bid.toFixed(v.dig)}</td><td>${v.ask.toFixed(v.dig)}</td><td class="mut">${esc(v.time)}</td></tr>` : `<tr><td>${esc(k)}</td><td colspan="3" class="mut">xog ma jirto waqtigaas</td></tr>`).join('');
  });
  $('ad').value = dstr(new Date()); $('at').value = new Date(Date.now() - 60000).toTimeString().slice(0, 8);
  window.itrAuthReady.then(() => init()).catch(showError);
  window.addEventListener('itr-authenticated', () => run(init));
  window.addEventListener('itr-logged-out', () => run(init));
})();
