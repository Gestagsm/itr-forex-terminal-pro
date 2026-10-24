(() => {
  const $ = id => document.getElementById(id), TFS = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];
  let sym = 'EURUSD', tf = 'M5', N = 120, P = {}, A = { authenticated: false, positions: [], orders: [], stats: {} }, C = [], dig = 5, tab = 'pos', R = null, hover = -1, prevBid = {}, G = null;
  let chartRange = null, replayIndex = -1, replayTimer = null, chartRequest = 0;
  const chartTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const api = (p, b) => fetch(p, b ? { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) } : { cache: 'no-store' }).then(r => r.json());
  const money = x => (x < 0 ? '-' : '') + '$' + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const cls = x => (x >= 0 ? 'up' : 'down'), fx = (s, v) => (v === undefined || v === null ? '-' : (+v).toFixed(P[s] ? P[s].dig : 5));
  const pip = s => Math.pow(10, -(P[s].dig - 1)), esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const label = s => (P[s] ? P[s].label : s), hms = t => new Date(t).toLocaleString('en-GB', { hour12: false }).replace(',', '');

  /* ---------- tf buttons ---------- */
  $('tfs').innerHTML = TFS.map(t => `<span class="tf ${t === tf ? 'on' : ''}" data-tf="${t}">${t}</span>`).join(' ');
  $('tfs').onclick = e => { const t = e.target.dataset.tf; if (!t) return; tf = t; replayIndex = -1; stopReplay(); document.querySelectorAll('.tf').forEach(x => x.classList.toggle('on', x.dataset.tf === t)); loadChart(); loop() };
  $('otype').onchange = () => { $('prow').style.display = $('otype').value === 'MARKET' ? 'none' : 'flex'; const q = P[sym]; if (q && !$('oprice').value) $('oprice').value = q.bid.toFixed(q.dig) };

  /* ---------- loop: prices + account + candles ---------- */
  let refreshInFlight = false, refreshPending = false;
  async function loop() {
    if (refreshInFlight) { refreshPending = true; return }
    refreshInFlight = true;
    try {
      P = await api('/prices');
      if (window.itrHasPrivateAccess()) {
        const account = await api('/account');
        A = account.error ? { authenticated: false, positions: [], orders: [], stats: {} } : { ...account, authenticated: true };
      } else A = { authenticated: false, positions: [], orders: [], stats: {} };
      $('conn').textContent = '● LIVE'; $('conn').className = 'pill on'; render();
    } catch (e) { $('conn').textContent = 'offline'; $('conn').className = 'pill off' }
    finally {
      refreshInFlight = false;
      if (refreshPending) { refreshPending = false; queueMicrotask(loop) }
    }
  }
  setInterval(loop, 1000); loop(); loadChart();
  function stopReplay() {
    if (replayTimer) clearInterval(replayTimer);
    replayTimer = null;
    $('chart-play').textContent = 'Replay';
  }
  async function loadChart() {
    const request = ++chartRequest, query = new URLSearchParams({ symbol: sym, tf, timezone: chartTimezone });
    if (chartRange) {
      query.set('from', String(chartRange.from));
      query.set('to', String(chartRange.to));
    } else query.set('limit', String(N));
    $('chart-status').textContent = 'Loading…';
    try {
      const result = await api(`/candles?${query}`);
      if (request !== chartRequest) return;
      if (result.error) throw new Error(result.error);
      C = result.candles || [];
      dig = result.digits || 5;
      replayIndex = -1;
      stopReplay();
      const count = `${result.count || 0} ${tf} candles · ${result.source || 'local-history'}`;
      $('chart-status').textContent = `${count}${result.truncated ? ` · range capped at ${result.maxCandles}` : ''} · ${result.timezone || 'local time'}`;
      draw();
    } catch (error) {
      if (request === chartRequest) $('chart-status').textContent = `Chart error: ${error.message}`;
    }
  }
  $('chart-load').onclick = () => {
    const from = $('chart-from').value, to = $('chart-to').value;
    if (!from || !to || from > to) { $('chart-status').textContent = 'Choose a valid start and end date.'; return }
    const [fromYear, fromMonth, fromDay] = from.split('-').map(Number);
    const [toYear, toMonth, toDay] = to.split('-').map(Number);
    const start = new Date(fromYear, fromMonth - 1, fromDay), end = new Date(toYear, toMonth - 1, toDay);
    end.setDate(end.getDate() + 1);
    chartRange = { from: start.getTime(), to: end.getTime() };
    replayIndex = -1; stopReplay(); loadChart();
  };
  $('chart-live').onclick = () => {
    chartRange = null; $('chart-from').value = ''; $('chart-to').value = '';
    replayIndex = -1; stopReplay(); loadChart();
  };
  $('chart-back').onclick = () => {
    if (!C.length) return;
    replayIndex = replayIndex < 0 ? Math.max(0, C.length - 2) : Math.max(0, replayIndex - 1);
    stopReplay(); draw();
  };
  $('chart-forward').onclick = () => {
    if (replayIndex < 0 || !C.length) return;
    replayIndex = replayIndex + 1 >= C.length ? -1 : replayIndex + 1;
    draw();
  };
  $('chart-play').onclick = () => {
    if (replayTimer) { stopReplay(); return }
    if (!C.length) return;
    if (replayIndex < 0 || replayIndex >= C.length - 1) replayIndex = 0;
    $('chart-play').textContent = 'Pause';
    draw();
    replayTimer = setInterval(() => {
      if (replayIndex >= C.length - 1) { stopReplay(); return }
      replayIndex++; draw();
    }, 500);
  };
  let cfgC = null;
  async function fstat() { if (!window.itrHasPrivateAccess()) return; try { const [s, c] = await Promise.all([api('/status'), api('/config')]); cfgC = c;
    if (!c.setupDone && !window.__setupShown) { window.__setupShown = true; openFolders(true) } } catch (e) {} }
  setInterval(() => { if (window.itrHasPrivateAccess()) fstat() }, 2000);

  function render() {
    const s = A;
    $('metrics').innerHTML = (s.authenticated
      ? [['Balance', money(s.balance)], ['Equity', money(s.equity)], ['Floating P/L', `<span class="${cls(s.floating)}">${money(s.floating)}</span>`], ['Margin', money(s.margin)], ['Free Margin', money(s.free)], ['Margin Level', s.level === null ? '—' : s.level.toFixed(0) + '%']]
      : [['Account', 'Sign in for account controls']]).map(([k, v]) => `<div>${k}<b>${v}</b></div>`).join('');
    $('watch').innerHTML = Object.entries(P).map(([k, p]) => { const ch = (p.bid - p.open) / p.open * 100, pb = prevBid[k], c = pb === undefined ? '' : p.bid > pb ? 'up' : p.bid < pb ? 'down' : ''; prevBid[k] = p.bid;
      const ps = A.positions.filter(x => x.sym === k), pl = ps.reduce((a, x) => a + x.pnl, 0);
      return `<div class="pair ${k === sym ? 'active' : ''}" data-s="${k}"><b>${p.label}</b><span class="px ${c}">${p.bid.toFixed(p.dig)}</span><span class="px mut">${p.ask.toFixed(p.dig)}</span><span class="${cls(ch)}" style="text-align:right">${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%</span>${ps.length ? `<span class="pl"><span>● ${ps.length} position</span><b class="${cls(pl)}">${pl >= 0 ? '+' : ''}${money(pl)}</b></span>` : ''}</div>` }).join('');
    const q = P[sym]; if (q) { $('tsym').textContent = q.label; $('csym').textContent = q.label; $('psell').textContent = q.bid.toFixed(q.dig); $('pbuy').textContent = q.ask.toFixed(q.dig);
      $('cpx').innerHTML = `<span class="${q.dir === '⇧' ? 'up' : 'down'}">${q.bid.toFixed(q.dig)}</span> <span class="mut" style="font-size:11px">/ ${q.ask.toFixed(q.dig)} · spread ${q.spread}pt</span>` }
    draw(); renderTab(false);
  }
  $('watch').onclick = e => { const r = e.target.closest('[data-s]'); if (r) { sym = r.dataset.s; $('oprice').value = ''; replayIndex = -1; stopReplay(); loadChart(); loop() } };

  /* ---------- orders ---------- */
  async function order(side) {
    const q = P[sym], type = $('otype').value, price = type === 'MARKET' ? (side === 'BUY' ? q.ask : q.bid) : +$('oprice').value, slp = +$('osl').value, tpp = +$('otp').value, b = side === 'BUY' ? 1 : -1;
    const r = await api('/order', { symbol: sym, side, lots: +$('olots').value, type, price: type === 'MARKET' ? 0 : price, sl: slp ? price - b * slp * pip(sym) : 0, tp: tpp ? price + b * tpp * pip(sym) : 0 });
    $('omsg').innerHTML = r.ok ? `<span class="okm">✔ ${side} ${$('olots').value} ${label(sym)} ${type === 'MARKET' ? 'executed' : 'pending'}</span>` : `<span class="err">✖ ${r.error}</span>`; loop();
  }
  $('bsell').onclick = () => order('SELL'); $('bbuy').onclick = () => order('BUY');

  /* ---------- tabs ---------- */
  $('tabs').onclick = e => { const t = e.target.dataset.t; if (!t) return; tab = t; document.querySelectorAll('#tabs span').forEach(x => x.classList.toggle('on', x.dataset.t === t)); $('tabc').innerHTML = ''; renderTab(true) };
  $('tabc').onclick = async e => { const b = e.target.closest('[data-act]'); if (!b) return; const id = +b.dataset.id;
    if (b.dataset.act === 'close') await api('/close', { id }); if (b.dataset.act === 'cancel') await api('/cancel', { id });
    if (b.dataset.act === 'edit') { const p = A.positions.find(x => x.id === id), sl = prompt('Stop Loss (qiimo, 0 = ka saar)', p.sl), tp = prompt('Take Profit (qiimo, 0 = ka saar)', p.tp); if (sl !== null && tp !== null) { const r = await api('/modify', { id, sl: +sl, tp: +tp }); if (r.error) alert(r.error) } }
    if (b.dataset.act === 'closeall') await api('/closeall', {}); if (b.dataset.act === 'reset' && confirm('Account-ka dib u deji ($10,000)?')) await api('/account/reset', { balance: 10000 });
    if (b.dataset.act === 'rcfg') { const c = {}; document.querySelectorAll('#rform [data-k]').forEach(i => c[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.value); R = await api('/robot/config', c); $('rmsg').textContent = '✔ la dhigay' }
    if (b.dataset.act === 'rtoggle') { R = await api('/robot/config', { enabled: !R.enabled }); renderTab(true) } loop() };
  $('robotBtn').onclick = async () => { if (!R) R = await api('/robot'); R = await api('/robot/config', { enabled: !R.enabled }); botBtn() };
  function botBtn() { if (!R) return; $('robotBtn').textContent = '🤖 ROBOT: ' + (R.enabled ? 'ON' : 'OFF'); $('robotBtn').className = 'btn ' + (R.enabled ? 'green' : 'red') }

  const cards = o => `<div class="cards">${o.map(([k, v, c]) => `<div>${k}<b class="${c || ''}">${v}</b></div>`).join('')}</div>`;
  async function renderTab(force) {
    const el = $('tabc');
    if (!A.authenticated && ['his', 'sta', 'rob'].includes(tab)) {
      el.innerHTML = '<div class="mut" style="padding:16px">Sign in to view private account history and robot data.</div>';
      return;
    }
    if (tab === 'pos') el.innerHTML = `<div style="margin-bottom:6px"><button class="btn sm red" data-act="closeall">Close All</button></div><table><thead><tr><th>ID</th><th>Symbol</th><th>Type</th><th>Lots</th><th>Open</th><th>Price</th><th>SL</th><th>TP</th><th>P/L</th><th>By</th><th></th></tr></thead><tbody>` +
      (A.positions.map(p => `<tr><td>#${p.id}</td><td>${label(p.sym)}</td><td class="${p.side === 'BUY' ? 'up' : 'down'}">${p.side}</td><td>${p.lots}</td><td>${fx(p.sym, p.open)}</td><td>${fx(p.sym, p.price)}</td><td>${p.sl ? fx(p.sym, p.sl) : '-'}</td><td>${p.tp ? fx(p.sym, p.tp) : '-'}</td><td class="${cls(p.pnl)}">${money(p.pnl)}</td><td>${p.magic === 'EA' ? '<span class="tag">EA</span>' : 'manual'}</td><td><button class="btn sm" data-act="edit" data-id="${p.id}">✎</button> <button class="btn sm red" data-act="close" data-id="${p.id}">✕</button></td></tr>`).join('') || '<tr><td colspan="11" class="mut" style="text-align:center;padding:16px">Position furan ma jiro</td></tr>') + '</tbody></table>';
    else if (tab === 'ord') el.innerHTML = `<table><thead><tr><th>ID</th><th>Symbol</th><th>Type</th><th>Lots</th><th>Price</th><th>SL</th><th>TP</th><th></th></tr></thead><tbody>` +
      (A.orders.map(o => `<tr><td>#${o.id}</td><td>${label(o.sym)}</td><td>${o.side} ${o.type}</td><td>${o.lots}</td><td>${fx(o.sym, o.price)}</td><td>${o.sl ? fx(o.sym, o.sl) : '-'}</td><td>${o.tp ? fx(o.sym, o.tp) : '-'}</td><td><button class="btn sm red" data-act="cancel" data-id="${o.id}">Cancel</button></td></tr>`).join('') || '<tr><td colspan="8" class="mut" style="text-align:center;padding:16px">Pending order ma jiro</td></tr>') + '</tbody></table>';
    else if (tab === 'his') { if (force || Date.now() % 3 === 0) { const t = await api('/trades?limit=200'); if (tab !== 'his') return;
      el.innerHTML = `<table><thead><tr><th>ID</th><th>Symbol</th><th>Type</th><th>Lots</th><th>Open</th><th>Close</th><th>P/L</th><th>Sabab</th><th>By</th><th>Xidhmay</th></tr></thead><tbody>` +
        (t.map(x => `<tr><td>#${x.id}</td><td>${label(x.sym)}</td><td class="${x.side === 'BUY' ? 'up' : 'down'}">${x.side}</td><td>${x.lots}</td><td>${fx(x.sym, x.open)}</td><td>${fx(x.sym, x.close)}</td><td class="${cls(x.pnl)}">${money(x.pnl)}</td><td>${esc(x.reason)}</td><td>${x.magic === 'EA' ? '<span class="tag">EA</span>' : 'manual'}</td><td>${hms(x.closeTime)}</td></tr>`).join('') || '<tr><td colspan="10" class="mut" style="text-align:center;padding:16px">Trade xidhan ma jiro</td></tr>') + '</tbody></table>' } }
    else if (tab === 'sta') { const s = A.stats || {}; if (force || !$('eq')) el.innerHTML = '<div id="sc"></div><canvas id="eq" style="width:100%;height:110px;background:#0c0f12;border-radius:4px"></canvas><div id="bym" style="margin-top:6px"></div><div style="margin-top:6px"><button class="btn sm red" data-act="reset">Reset account</button></div>';
      $('sc').innerHTML = cards([['Trades', s.trades], ['Win rate', s.winRate + '%'], ['Profit factor', s.profitFactor], ['Net', money(s.net || 0), cls(s.net || 0)], ['Avg win', money(s.avgWin || 0)], ['Avg loss', money(s.avgLoss || 0)], ['Expectancy', money(s.expectancy || 0)], ['Max DD', (s.maxDrawdownPct || 0) + '%'], ['P/L maanta', money(A.pnlToday || 0), cls(A.pnlToday || 0)]]);
      if (force || Date.now() % 3 === 0) { drawCurve(await api('/curve')); const tr = await api('/trades?limit=5000'); if (tab !== 'sta') return;
        const rows = Object.keys(P).map(k => { const t = tr.filter(x => x.sym === k && !/^CANCEL/.test(x.reason)), net = t.reduce((a, x) => a + x.pnl, 0), fl = A.positions.filter(x => x.sym === k).reduce((a, x) => a + x.pnl, 0);
          return `<tr><td>${label(k)}</td><td>${t.length}</td><td>${t.filter(x => x.pnl > 0).length}</td><td class="${cls(net)}">${money(net)}</td><td class="${cls(fl)}">${money(fl)}</td><td class="${cls(net + fl)}"><b>${money(net + fl)}</b></td></tr>` }).join('');
        $('bym').innerHTML = `<table><thead><tr><th>Suuq</th><th>Trades</th><th>Wins</th><th>Realized</th><th>Floating</th><th>Guud</th></tr></thead><tbody>${rows}</tbody></table>` } }
    else if (tab === 'rob') { if (force || !$('rform')) { R = await api('/robot'); botBtn(); const c = R.config, f = (k, l, t = 'number', extra = '') => `<div><label>${l}</label><input data-k="${k}" type="${t}" value="${c[k]}" ${extra}></div>`;
      el.innerHTML = `<div id="rdyn"></div><div class="rgrid" id="rform"><div><label>Timeframe</label><select data-k="tf">${TFS.map(t => `<option ${t === c.tf ? 'selected' : ''}>${t}</option>`).join('')}</select></div>` + f('riskPct', 'Risk % / trade', 'number', 'step=0.1') + f('rr', 'Reward : Risk (TP)', 'number', 'step=0.1') + f('atrSl', 'SL = ATR ×', 'number', 'step=0.1') + f('minScore', 'Min score (1-4)') + f('maxOpen', 'Max open') + f('dailyLossPct', 'Daily loss limit %') + f('maxDdPct', 'Max drawdown kill %') + f('cooldownMin', 'Cooldown (min)') + f('maxHoldBars', 'Max hold (candles)') +
        `<div style="display:flex;align-items:end"><button class="btn green sm" data-act="rcfg">Apply</button> <span id="rmsg" class="mut" style="margin-left:6px"></span></div></div>` }
      if (force || Date.now() % 3 === 0) { R = await api('/robot'); botBtn(); const d = $('rdyn'); if (!d || tab !== 'rob') return; const s = R.stats;
        d.innerHTML = `<div style="margin-bottom:6px"><span class="pill ${R.enabled ? 'on' : 'off'}">${R.enabled ? 'ROBOT ON · ' + R.tf : 'ROBOT OFF'}</span> <button class="btn sm" data-act="rtoggle">${R.enabled ? 'Stop robot' : 'Start robot'}</button> <span class="err">${esc(R.halted)}</span></div>` +
          cards([['EA trades', s.trades], ['Win rate', s.winRate + '%'], ['PF', s.profitFactor], ['Net', money(s.net), cls(s.net)], ['Max DD', s.maxDrawdownPct + '%'], ['P/L maanta', money(R.dayPnl), cls(R.dayPnl)]]) +
          `<table><thead><tr><th>Symbol</th><th>Trend</th><th>RSI</th><th>ATR</th><th>Score</th><th>Signal</th><th>Cooldown</th></tr></thead><tbody>` + R.symbols.map(x => { const i = x.ind || {};
            return `<tr><td>${label(x.sym)}</td><td class="${i.trend === 'UP' ? 'up' : i.trend === 'DOWN' ? 'down' : 'mut'}">${i.trend || (i.have ? 'warm-up ' + i.have + '/' + i.need : '—')}</td><td>${i.rsi ?? '-'}</td><td>${i.atr ? (+i.atr).toPrecision(3) : '-'}</td><td>${i.score ?? '-'}/4</td><td>${x.signal ? `${x.signal.side} (${esc(x.signal.why)}) ${x.signal.time}` : '-'}</td><td>${x.cooldown ? x.cooldown + 'm' : '-'}</td></tr>` }).join('') + '</tbody></table>' +
          `<div class="logl" style="margin-top:6px">` + R.log.map(l => `<div class="${l.level}">${new Date(l.t).toLocaleTimeString('en-GB')} ${l.sym ? '[' + l.sym + '] ' : ''}${esc(l.msg)}</div>`).join('') + '</div>' } }
  }
  function drawCurve(c) { const cv = $('eq'); if (!cv || !c.length) return; const W = cv.clientWidth, H = cv.clientHeight, d = devicePixelRatio || 1; cv.width = W * d; cv.height = H * d; const g = cv.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0);
    const v = c.map(x => x[1]), lo = Math.min(...v), hi = Math.max(...v) || 1, rg = hi - lo || 1; g.strokeStyle = v[v.length - 1] >= v[0] ? '#2ebd85' : '#df294a'; g.lineWidth = 1.5; g.beginPath();
    v.forEach((y, i) => { const px = i / (v.length - 1 || 1) * (W - 10) + 5, py = H - 8 - (y - lo) / rg * (H - 16); i ? g.lineTo(px, py) : g.moveTo(px, py) }); g.stroke(); g.fillStyle = '#8a96a3'; g.font = '10px monospace'; g.fillText('Equity ' + hi.toFixed(0), 6, 11); g.fillText(lo.toFixed(0), 6, H - 2) }

  /* ---------- chart ---------- */
  const cv = $('cv'), ctx = cv.getContext('2d');
  function draw() {
    const d = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight; if (!W) return; cv.width = W * d; cv.height = H * d; ctx.setTransform(d, 0, 0, d, 0, 0); ctx.clearRect(0, 0, W, H); ctx.font = '11px monospace';
    const visible = replayIndex >= 0 ? C.slice(0, replayIndex + 1) : C;
    if (!visible.length) { ctx.fillStyle = '#8a96a3'; ctx.fillText('Candles ma jiraan weli…', 20, 30); G = null; return }
    const R_ = 70, B = 20, T = 28, L = 6, volH = (H - T - B) * 0.14, pH = H - T - B - volH - 6, pW = W - R_ - L, q = replayIndex >= 0 ? null : P[sym];
    let hi = Math.max(...visible.map(c => c.h), q ? q.ask : 0), lo = Math.min(...visible.map(c => c.l), q ? q.bid : 1e9); const pos = replayIndex >= 0 ? [] : A.positions.filter(p => p.sym === sym);
    for (const p of pos) for (const v of [p.open, p.sl, p.tp]) if (v) { hi = Math.max(hi, v); lo = Math.min(lo, v) } const pd = (hi - lo || Math.pow(10, -dig)) * 0.08; hi += pd; lo -= pd;
    const vmax = Math.max(...visible.map(c => c.v)) || 1, step = pW / visible.length, bw = Math.min(14, Math.max(2, step * 0.66)), y = p => T + (hi - p) / (hi - lo) * pH, x = i => L + step * (i + 0.5);
    ctx.strokeStyle = '#1d2329'; ctx.fillStyle = '#8a96a3'; ctx.textAlign = 'left';
    for (let g = 0; g <= 6; g++) { const p = lo + (hi - lo) * g / 6, yy = y(p); ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(W - R_, yy); ctx.stroke(); ctx.fillText(p.toFixed(dig), W - R_ + 6, yy + 4) }
    visible.forEach((c, i) => { const col = c.c >= c.o ? '#41c99a' : '#ee6c7d', cx = x(i); ctx.strokeStyle = ctx.fillStyle = col; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, y(c.h)); ctx.lineTo(cx, y(c.l)); ctx.stroke();
      const yo = y(c.o), yc = y(c.c); ctx.fillRect(cx - bw / 2, Math.min(yo, yc), bw, Math.max(1.5, Math.abs(yo - yc))); ctx.globalAlpha = 0.28; const vh = c.v / vmax * volH; if (vh > 0) ctx.fillRect(cx - bw / 2, H - B - vh, bw, vh); ctx.globalAlpha = 1 });
    const line = (p, col, lab, dash) => { if (!p) return; const yy = y(p); ctx.setLineDash(dash); ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(W - R_, yy); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = col; ctx.fillRect(W - R_, yy - 8, R_ - 2, 16); ctx.fillStyle = '#0c0f12'; ctx.fillText(lab, W - R_ + 3, yy + 4) };
    if (q) { line(q.ask, '#4f9bf7', q.ask.toFixed(dig), [2, 3]); line(q.bid, C[C.length - 1].c >= C[C.length - 1].o ? '#2ebd85' : '#df294a', q.bid.toFixed(dig), [4, 3]) }
    for (const p of pos) { line(p.open, p.pnl >= 0 ? '#2ebd85' : '#df294a', `${p.side[0]} ${p.pnl >= 0 ? '+' : ''}${p.pnl.toFixed(2)}`, [6, 3]); line(p.sl, '#df294a', 'SL', [1, 3]); line(p.tp, '#2ebd85', 'TP', [1, 3]) }
    ctx.fillStyle = '#8fa1ad'; ctx.textAlign = 'center'; const ev = Math.max(1, Math.ceil(visible.length / Math.max(1, Math.floor(pW / 90)))); visible.forEach((c, i) => { if (i % ev === 0 && x(i) > 40) ctx.fillText(c.time.slice(tf === 'D1' ? 5 : 11) || c.time.slice(5), x(i), H - 5) });
    const k = hover >= 0 && hover < visible.length ? visible[hover] : visible[visible.length - 1];
    $('ohlc').innerHTML = `${k.time} &nbsp; O <b>${k.o.toFixed(dig)}</b> H <b>${k.h.toFixed(dig)}</b> L <b>${k.l.toFixed(dig)}</b> C <b class="${cls(k.c - k.o)}">${k.c.toFixed(dig)}</b> &nbsp; Vol ${k.v}`; G = { L, step, n: visible.length };
  }
  cv.onmousemove = e => { if (!G) return; const r = cv.getBoundingClientRect(); hover = Math.floor((e.clientX - r.left - G.L) / G.step); draw() }; cv.onmouseleave = () => { hover = -1; draw() };
  cv.onwheel = e => { e.preventDefault(); N = Math.max(30, Math.min(400, N + (e.deltaY > 0 ? 15 : -15))); if (!chartRange) loadChart() };
  addEventListener('resize', draw);
  (async () => { const m = await api('/market'); $('sess').innerHTML = m.sessions.map(s => `<span class="pill ${s.open ? 'on' : ''}" title="${s.name}">${s.name[0] + (s.name === 'New York' ? 'Y' : s.name.slice(1, 3))}</span>`).join('') })();
  window.addEventListener('itr-authenticated', () => {
    loop();
    fstat();
    api('/robot').then(r => { if (!r.error) { R = r; botBtn() } });
    renderTab(true);
  });
  window.itrAuthReady.then(() => {
    if (!window.itrHasPrivateAccess()) return;
    fstat();
    api('/robot').then(r => { if (!r.error) { R = r; botBtn() } });
  });
  renderTab(true);
})();
