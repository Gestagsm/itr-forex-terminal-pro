(() => {
  const $ = id => document.getElementById(id), api = async p => {
    const response = await fetch(p, { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }, LIM = 200;
  let ds = 'TAQ', idx = {}, offset = 0, total = 0;
  const p2 = n => String(n).padStart(2, '0'), dstr = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/ /g, '&nbsp;');
  const range = () => ({ from: new Date(`${$('d1').value}T${$('t1').value || '00:00:00'}`).getTime(), to: new Date(`${$('d2').value}T${$('t2').value || '23:59:59'}`).getTime() + 1000 });
  const qs = (extra = '') => { const r = range(); return `ds=${ds}&symbol=${$('sym').value}&from=${r.from}&to=${r.to}${extra}` };
  const kb = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';
  const showError = error => { $('dbstate').innerHTML = `<span class="err">History lama heli karo: ${esc(error.message)}</span>` };
  const run = action => action().catch(showError);

  async function init() {
    const [history, status] = await Promise.all([api('/history/index'), api('/public/status')]); idx = history; const syms = Object.keys(idx.TAQ);
    $('dbstate').innerHTML = status.connected
      ? '<span class="okm">● Database connected</span><span class="mut"> · TAQ, TAS iyo GCV market history</span>'
      : '<span class="err">● Database disconnected</span><span class="mut"> · Xogta taariikhda suuqa ee la heli karo ayaa la soo bandhigayaa</span>';
    $('sym').innerHTML = syms.map(s => `<option>${s}</option>`).join(''); const t = dstr(new Date()); $('d1').value = $('d2').value = t;
    $('counts').innerHTML = Object.keys(idx).map(n => `<div class="box" style="min-width:150px"><b>${n}</b><div class="mut">${syms.reduce((a, s) => a + idx[n][s].blocks, 0)} block · ${syms.length} suuq</div></div>`).join('');
    $('dsTabs').innerHTML = Object.keys(idx).map(n => `<button class="btn ${n === ds ? 'blue' : ''}" data-ds="${n}">${n}</button>`).join('');
    $('dsTabs').onclick = e => {
      if (!e.target.dataset.ds) return;
      ds = e.target.dataset.ds;
      document.querySelectorAll('#dsTabs .btn').forEach(b => b.classList.toggle('blue', b.dataset.ds === ds));
      chips(); run(() => go(0));
    };
    $('sym').onchange = () => { chips(); run(() => go(0)) }; chips(); await go(0);
  }
  function chips() { const d = idx[ds][$('sym').value].dates; $('chips').innerHTML = d.map(x => `<button class="btn sm" data-d="${x}">${x}</button>`).join(' ') || '<span class="mut">weli ma jiraan</span>';
    $('chips').onclick = e => { if (e.target.dataset.d) { $('d1').value = $('d2').value = e.target.dataset.d; $('t1').value = '00:00:00'; $('t2').value = '23:59:59'; go(0) } } }
  async function go(o) {
    offset = o; const r = await api('/history/query?' + qs(`&offset=${o}&limit=${LIM}`)); total = r.total;
    $('th').innerHTML = '<tr>' + r.cols.map(c => `<th>${c}</th>`).join('') + '</tr>'; $('tb').innerHTML = r.rows.map(x => '<tr>' + x.map(v => `<td>${esc(v)}</td>`).join('') + '</tr>').join('') || `<tr><td class="mut" colspan="${r.cols.length}" style="padding:20px;text-align:center">Xog lagama helin waqtigan</td></tr>`;
    $('sum').innerHTML = `<b>${ds} · ${$('sym').value}</b> — <b>${total.toLocaleString()}</b> safaf · ${r.source === 'postgresql' ? 'PostgreSQL' : 'kayd maxalli ah'} ${r.first ? `· ${r.first} → ${r.last}` : ''}`; $('pg').textContent = total ? `${offset + 1}–${Math.min(offset + LIM, total)} / ${total.toLocaleString()}` : '';
    $('csv').href = '/history/query?' + qs('&format=csv'); await blocks();
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
  $('go').onclick = () => run(() => go(0)); $('prev').onclick = () => run(() => go(Math.max(0, offset - LIM))); $('next').onclick = () => { if (offset + LIM < total) run(() => go(offset + LIM)) };
  document.querySelector('[data-q]').parentElement.onclick = e => { const q = e.target.dataset.q; if (!q) return; const now = new Date(), t = d => `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    if (q === '5m' || q === '1h') { const f = new Date(now - (q === '5m' ? 300e3 : 3600e3)); $('d1').value = dstr(f); $('t1').value = t(f); $('d2').value = dstr(now); $('t2').value = t(now) }
    else if (q === 'today') { $('d1').value = $('d2').value = dstr(now); $('t1').value = '00:00:00'; $('t2').value = '23:59:59' }
    else { const d = idx[ds][$('sym').value].dates; $('d1').value = d[0] || dstr(now); $('d2').value = d[d.length - 1] || dstr(now); $('t1').value = '00:00:00'; $('t2').value = '23:59:59' } run(() => go(0)) };
  $('ago').onclick = () => run(async () => { const t = new Date(`${$('ad').value}T${$('at').value || '00:00:00'}`).getTime(), r = await api('/history/at?time=' + t);
    $('atsource').textContent = r.source === 'postgresql' ? '· PostgreSQL' : '· kayd maxalli ah';
    $('atb').innerHTML = Object.entries(r.rates).map(([k, v]) => v ? `<tr><td><b>${esc(v.label)}</b></td><td>${v.bid.toFixed(v.dig)}</td><td>${v.ask.toFixed(v.dig)}</td><td class="mut">${esc(v.time)}</td></tr>` : `<tr><td>${esc(k)}</td><td colspan="3" class="mut">xog ma jirto waqtigaas</td></tr>`).join('') });
  $('ad').value = dstr(new Date()); $('at').value = new Date(Date.now() - 60000).toTimeString().slice(0, 8);
  window.itrAuthReady.then(() => init()).catch(showError);
  window.addEventListener('itr-authenticated', () => run(init));
  window.addEventListener('itr-logged-out', () => run(init));
})();
