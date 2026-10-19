'use strict';
/* robot.js — Expert Advisor (EA): trend-pullback multi-confirmation + ATR risk + position sizing + trade management + kill-switches
 * Waxay ku shaqaysaa candle-ka xidhmay (closed candle) ee TF la doortay. Waa DEMO / tacliin — ma aha talo maaliyadeed. */
const I = require('./indicators');
const { TF, dayKey, market } = require('./market');

const DEFAULTS = {
  enabled: true, tf: 'M15', symbols: null,                 // null = dhammaan suuqyada
  riskPct: 0.5, rr: 2, atrPeriod: 14, atrSl: 1.5,           // 1% khatar, TP = 2R, SL = 1.5 x ATR
  emaFast: 9, emaSlow: 21, emaTrend: 100, rsiPeriod: 14, donchian: 12, minScore: 3,
  maxOpen: 4, maxPerSymbol: 1, maxLots: 10, maxMarginPct: 25,
  maxSpreadMult: 2, sessionMinFactor: 0.7, spikeAtr: 3,    // spread filter, session filter, spike filter
  breakevenR: 1, trailStartR: 1.5, trailAtr: 1.2, maxHoldBars: 48, exitOnReverse: true,
  cooldownMin: 15, dailyLossPct: 3, maxDdPct: 15           // kill-switches
};

function createRobot({ broker, symbols, defs, getQuote, getCandles, clock = Date.now, weekendClosed = false, store }) {
  const cfg = { ...DEFAULTS, ...(store && store.get() || {}) };
  const sym = {}; for (const s of symbols) sym[s] = { lastBucket: 0, cooldownUntil: 0, ind: null, signal: null };
  const logs = []; let halted = '';
  const log = (level, s, msg) => { logs.push({ t: clock(), level, sym: s || '', msg }); if (logs.length > 300) logs.shift() };
  const persist = () => store && store.set(cfg);
  const active = () => cfg.symbols && cfg.symbols.length ? cfg.symbols.filter(s => sym[s]) : symbols;
  const tfMs = () => TF[cfg.tf] * 60000;
  const bucket = t => { const x = new Date(t), m = TF[cfg.tf]; x.setHours(0, Math.floor((x.getHours() * 60 + x.getMinutes()) / m) * m, 0, 0); return x.getTime() };
  const usdPerQuote = s => { const q = defs[s].quote; if (q === 'USD') return 1; const ref = q === 'JPY' ? 'USDJPY' : 'USDCAD', r = getQuote(ref); return 1 / ((r.bid + r.ask) / 2) };

  /* ---- 1) shaqada indicators + signal (candle xidhan oo kaliya) ---- */
  function analyse(s, candles) {
    const need = Math.max(cfg.emaTrend, 60) + 10; if (candles.length < need) return { ready: false, have: candles.length, need };
    const c = candles.map(x => x.c), h = candles.map(x => x.h), l = candles.map(x => x.l), n = c.length - 1;
    const ef = I.ema(c, cfg.emaFast), es = I.ema(c, cfg.emaSlow), et = I.ema(c, cfg.emaTrend), rs = I.rsi(c, cfg.rsiPeriod), at = I.atr(h, l, c, cfg.atrPeriod), mc = I.macd(c);
    const atrNow = at[n], atrAvg = at.slice(n - 49, n + 1).reduce((a, b) => a + b, 0) / 50;
    const trendUp = c[n] > et[n] && et[n] > et[n - 5], trendDn = c[n] < et[n] && et[n] < et[n - 5];
    const crossUp = [0, 1, 2].some(k => ef[n - k] > es[n - k] && ef[n - k - 1] <= es[n - k - 1]), crossDn = [0, 1, 2].some(k => ef[n - k] < es[n - k] && ef[n - k - 1] >= es[n - k - 1]);
    const pullUp = ef[n] > es[n] && [0, 1, 2].some(k => l[n - k] <= es[n - k]) && c[n] > es[n], pullDn = ef[n] < es[n] && [0, 1, 2].some(k => h[n - k] >= es[n - k]) && c[n] < es[n];
    const brkUp = c[n] > I.highest(h, cfg.donchian, n), brkDn = c[n] < I.lowest(l, cfg.donchian, n);
    const L = [crossUp || pullUp, mc.hist[n] > 0 && mc.hist[n] > mc.hist[n - 1], rs[n] > 50 && rs[n] < 70, brkUp];
    const S = [crossDn || pullDn, mc.hist[n] < 0 && mc.hist[n] < mc.hist[n - 1], rs[n] < 50 && rs[n] > 30, brkDn];
    const scoreL = L.filter(Boolean).length, scoreS = S.filter(Boolean).length;
    const volOk = atrNow >= 0.6 * atrAvg, spike = (h[n] - l[n]) > cfg.spikeAtr * atrNow;
    let side = null, score = 0, why = [];
    if (trendUp && scoreL >= cfg.minScore) { side = 'BUY'; score = scoreL; why = ['trend↑', crossUp ? 'EMA cross' : pullUp ? 'pullback' : '', L[1] ? 'MACD' : '', L[2] ? 'RSI ' + rs[n].toFixed(0) : '', brkUp ? 'breakout' : ''] }
    else if (trendDn && scoreS >= cfg.minScore) { side = 'SELL'; score = scoreS; why = ['trend↓', crossDn ? 'EMA cross' : pullDn ? 'pullback' : '', S[1] ? 'MACD' : '', S[2] ? 'RSI ' + rs[n].toFixed(0) : '', brkDn ? 'breakout' : ''] }
    return { ready: true, side, score, why: why.filter(Boolean).join(' + '), atr: atrNow, rsi: rs[n], emaTrend: et[n], trend: trendUp ? 'UP' : trendDn ? 'DOWN' : 'FLAT', scoreL, scoreS, volOk, spike, time: candles[n].time, price: c[n] };
  }

  /* ---- 2) position sizing: lots = khatar($) / (masaafada SL x contract x USD) ---- */
  function sizeLots(s, slDist) {
    const snap = broker.snapshot(), riskUsd = snap.equity * cfg.riskPct / 100, perLot = slDist * defs[s].size * usdPerQuote(s);
    let lots = Math.floor(riskUsd / perLot * 100) / 100; lots = Math.min(lots, cfg.maxLots);
    const q = getQuote(s), unit = defs[s].size * (defs[s].base === 'USD' ? 1 : (q.bid + q.ask) / 2) / snap.leverage;     // margin / lot
    lots = Math.min(lots, Math.floor(snap.free * cfg.maxMarginPct / 100 / unit * 100) / 100);
    return lots;
  }

  /* ---- 3) gal (entry) ---- */
  function tryEnter(s, a, now) {
    const st = sym[s], q = getQuote(s), mine = broker.view().filter(p => p.magic === 'EA');
    if (!a.side) return;
    const skip = r => log('skip', s, `${a.side} score ${a.score} (${a.why}) — ${r}`);
    if (now < st.cooldownUntil) return skip('cooldown');
    if (mine.length >= cfg.maxOpen) return skip('maxOpen');
    if (mine.filter(p => p.sym === s).length >= cfg.maxPerSymbol) return skip('hore ayaa u furan');
    if (!a.volOk) return skip('volatility hoose');
    if (a.spike) return skip('spike candle');
    const def = defs[s], typical = (def.spr[0] + def.spr[1]) / 2 * Math.pow(10, -def.dig), spread = q.ask - q.bid;
    if (spread > cfg.maxSpreadMult * typical) return skip('spread weyn');
    if (market(new Date(now), weekendClosed).factor < cfg.sessionMinFactor) return skip('session xaglan');
    const slDist = a.atr * cfg.atrSl, buy = a.side === 'BUY', entry = buy ? q.ask : q.bid;
    const sl = buy ? entry - slDist : entry + slDist, tp = buy ? entry + slDist * cfg.rr : entry - slDist * cfg.rr, lots = sizeLots(s, slDist);
    if (lots < 0.01) return skip('lots < 0.01 (khatar/margin)');
    const r = broker.place({ sym: s, side: a.side, lots, sl, tp, magic: 'EA', comment: `EA ${a.score}/4`, meta: { r0: slDist, atr: a.atr, why: a.why } });
    if (r.ok) log('trade', s, `${a.side} ${lots} lot @ ${entry} | SL ${r.position.sl} TP ${r.position.tp} | ${a.why} (score ${a.score}/4)`);
    else log('skip', s, r.error);
  }

  /* ---- 4) maamul position (breakeven, trailing, time-stop, reverse exit) — ilbiriqsi kasta ---- */
  function manage(now) {
    for (const p of broker.view().filter(x => x.magic === 'EA')) {
      const q = getQuote(p.sym), buy = p.side === 'BUY', px = buy ? q.bid : q.ask, r0 = p.meta && p.meta.r0; if (!r0) continue;
      const prof = buy ? px - p.open : p.open - px, spread = q.ask - q.bid;
      if (prof >= cfg.breakevenR * r0 && (buy ? p.sl < p.open : p.sl > p.open || !p.sl)) { broker.modify(p.id, { sl: buy ? p.open + spread : p.open - spread }); log('manage', p.sym, `#${p.id} breakeven`) }
      if (prof >= cfg.trailStartR * r0 && !p.trail) { broker.modify(p.id, { trail: { dist: (p.meta.atr || r0 / cfg.atrSl) * cfg.trailAtr, start: 0 } }); log('manage', p.sym, `#${p.id} trailing stop`) }
      if (now - p.openTime > cfg.maxHoldBars * tfMs() && prof < 0.5 * r0) { broker.close(p.id, 'TIME'); log('manage', p.sym, `#${p.id} time-stop`) }
    }
  }

  /* ---- 5) kill-switches ---- */
  function guards(now) {
    if (halted) return false;
    const snap = broker.snapshot(), day = broker.pnlToday('EA');
    if (day <= -snap.startBalance * cfg.dailyLossPct / 100) { if (sym._dayHalt !== dayKey(now)) { sym._dayHalt = dayKey(now); log('halt', '', `Daily loss limit (${cfg.dailyLossPct}%) — gal cusub maanta ma jiro`) } return false }
    if (!peak || snap.equity > peak) peak = snap.equity;                              // peak-ka robot-ka: waxaa laga bilaabaa marka la shido
    const dd = (peak - snap.equity) / peak * 100;
    if (dd >= cfg.maxDdPct) { halted = `Max drawdown ${dd.toFixed(1)}% >= ${cfg.maxDdPct}% — robot waa la joojiyay`; cfg.enabled = false; persist(); broker.closeAll('EA', 'KILL'); log('halt', '', halted); return false }
    return true;
  }

  /* ---- ilbiriqsi kasta ---- */
  let lastGuard = 0, allowed = true, peak = 0;
  function onSecond(now = clock()) {
    if (!cfg.enabled) return;
    manage(now);
    if (now - lastGuard >= 5000) { lastGuard = now; allowed = guards(now) }
    if (!allowed) return;
    for (const s of active()) {
      const st = sym[s], b = bucket(now); if (st.lastBucket === b) continue;
      const first = st.lastBucket === 0; st.lastBucket = b;
      const candles = getCandles(s, cfg.tf, b - 400 * tfMs(), b);                       // candles xidhan kaliya (ka hor bucket-ka hadda)
      const a = analyse(s, candles); st.ind = a; if (!a.ready) continue;
      st.signal = a.side ? { side: a.side, score: a.score, why: a.why, time: a.time } : st.signal;
      if (first) continue;                                                              // marka ugu horreysa kaliya akhri, ha gelin
      const pos = broker.view().find(p => p.magic === 'EA' && p.sym === s);
      if (pos && cfg.exitOnReverse && a.side && a.side !== pos.side && pos.pnl < 0) { broker.close(pos.id, 'REVERSE'); st.cooldownUntil = now + cfg.cooldownMin * 60000; log('manage', s, `#${pos.id} reverse exit`) }
      tryEnter(s, a, now);
    }
  }

  /* cooldown ka dib khasaare */
  const onClosed = t => { if (t.magic === 'EA' && t.pnl < 0 && sym[t.sym]) sym[t.sym].cooldownUntil = clock() + cfg.cooldownMin * 60000 };
  let seen = 0;
  function watchClosed() { const l = broker.raw().closed; for (; seen < l.length; seen++) onClosed(l[seen]) }
  seen = broker.raw().closed.length;

  return {
    onSecond: n => { onSecond(n); watchClosed() },
    config: () => ({ ...cfg }), halted: () => halted,
    setConfig(p) { const wasOn = cfg.enabled; for (const k of Object.keys(DEFAULTS)) if (p[k] !== undefined) cfg[k] = typeof DEFAULTS[k] === 'number' ? +p[k] : typeof DEFAULTS[k] === 'boolean' ? !!p[k] : p[k];
      if (p.enabled === true && !wasOn) { halted = ''; peak = 0; allowed = true; lastGuard = 0 } if (!TF[cfg.tf]) cfg.tf = 'M5'; for (const s of symbols) sym[s].lastBucket = 0; persist(); log('info', '', 'Config la cusboonaysiiyay') },
    status: () => ({ enabled: cfg.enabled, halted, tf: cfg.tf, stats: broker.stats('EA'), dayPnl: +broker.pnlToday('EA').toFixed(2),
      symbols: active().map(s => ({ sym: s, ind: sym[s].ind && sym[s].ind.ready ? { trend: sym[s].ind.trend, rsi: +sym[s].ind.rsi.toFixed(1), atr: sym[s].ind.atr, score: Math.max(sym[s].ind.scoreL, sym[s].ind.scoreS), side: sym[s].ind.side, time: sym[s].ind.time } : (sym[s].ind || null),
        signal: sym[s].signal, cooldown: Math.max(0, Math.ceil((sym[s].cooldownUntil - clock()) / 60000)) })), log: logs.slice(-80).reverse() }),
    DEFAULTS
  };
}
module.exports = { createRobot, DEFAULTS };
