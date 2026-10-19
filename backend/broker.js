'use strict';
/* broker.js — demo broker: account, margin, market/pending orders, SL/TP/trailing, stop-out, history, stats (persisted) */
const fs = require('fs'), path = require('path');
const { dayKey } = require('./market');

function createBroker({ defs, getQuote, file, clock = Date.now, startBalance = 10000, leverage = 100, stopOutPct = 50, curveEvery = 10 }) {
  const fresh = () => ({ balance: startBalance, startBalance, leverage, nextId: 1001, positions: [], orders: [], closed: [], curve: [], curveEvery, peak: startBalance, maxDdPct: 0 });
  let st = null, dirty = false, lastCurve = 0;
  try { st = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) {}
  st = st || fresh();
  const r2 = x => Math.round(x * 100) / 100;
  const rpx = (sym, x) => +(+x).toFixed(defs[sym].dig);
  const mid = sym => { const q = getQuote(sym); return (q.bid + q.ask) / 2 };
  const usdPerQuote = sym => { const q = defs[sym].quote; if (q === 'USD') return 1;
    const ref = q === 'JPY' ? 'USDJPY' : 'USDCAD'; let m; try { m = mid(ref) } catch (e) { m = defs[ref].start } return 1 / m };
  const dir = p => (p.side === 'BUY' ? 1 : -1);
  const closePx = p => { const q = getQuote(p.sym); return p.side === 'BUY' ? q.bid : q.ask };
  const pnlAt = (p, px, lots) => dir(p) * (px - p.open) * (lots ?? p.lots) * defs[p.sym].size * usdPerQuote(p.sym);
  const marginFor = (sym, lots) => { const d = defs[sym]; return lots * d.size * (d.base === 'USD' ? 1 : mid(sym)) / st.leverage };

  function snapshot() {
    let floating = 0, margin = 0;
    for (const p of st.positions) { floating += pnlAt(p, closePx(p)); margin += marginFor(p.sym, p.lots) }
    const equity = st.balance + floating;
    return { balance: r2(st.balance), equity: r2(equity), floating: r2(floating), margin: r2(margin), free: r2(equity - margin), level: margin > 0 ? r2(equity / margin * 100) : null, leverage: st.leverage, startBalance: st.startBalance };
  }
  const err = error => ({ ok: false, error });

  function place({ sym, side, lots, sl = 0, tp = 0, type = 'MARKET', price = 0, comment = '', magic = 'MANUAL', meta = null }) {
    const d = defs[sym]; if (!d) return err('Symbol ma jiro');
    side = String(side).toUpperCase(); if (side !== 'BUY' && side !== 'SELL') return err('side = BUY | SELL');
    lots = Math.round(+lots * 100) / 100; if (!(lots >= 0.01 && lots <= 100)) return err('Lots waa inuu u dhexeeyaa 0.01 iyo 100');
    sl = +sl || 0; tp = +tp || 0; price = +price || 0; type = String(type).toUpperCase();
    const q = getQuote(sym), entry = type === 'MARKET' ? (side === 'BUY' ? q.ask : q.bid) : price;
    if (type !== 'MARKET') {
      if (!(price > 0)) return err('Price geli');
      const ok = (side === 'BUY' && type === 'LIMIT' && price < q.ask) || (side === 'BUY' && type === 'STOP' && price > q.ask) ||
                 (side === 'SELL' && type === 'LIMIT' && price > q.bid) || (side === 'SELL' && type === 'STOP' && price < q.bid);
      if (!ok) return err(`${side} ${type} price ma saxna (bid ${q.bid} / ask ${q.ask})`);
    }
    if (side === 'BUY' ? ((sl && sl >= entry) || (tp && tp <= entry)) : ((sl && sl <= entry) || (tp && tp >= entry))) return err('SL/TP ma saxna (meel xun ayay ku jirtaa)');
    const snap = snapshot(), need = marginFor(sym, lots);
    if (need > snap.free) return err(`Margin ma filna (loo baahan yahay $${r2(need)}, free $${snap.free})`);
    const id = st.nextId++;
    if (type === 'MARKET') {
      const pos = { id, sym, side, lots, open: entry, openTime: clock(), sl: sl ? rpx(sym, sl) : 0, tp: tp ? rpx(sym, tp) : 0, trail: null, comment, magic, meta };
      st.positions.push(pos); dirty = true; return { ok: true, position: pos };
    }
    const o = { id, sym, side, lots, type, price: rpx(sym, price), sl: sl ? rpx(sym, sl) : 0, tp: tp ? rpx(sym, tp) : 0, comment, magic, meta, time: clock() };
    st.orders.push(o); dirty = true; return { ok: true, order: o };
  }

  function close(id, reason = 'MANUAL', lots, atPx) {
    const i = st.positions.findIndex(p => p.id === +id); if (i < 0) return err('Position ma jirto');
    const p = st.positions[i], n = lots && +lots < p.lots ? Math.round(+lots * 100) / 100 : p.lots, px = atPx ?? closePx(p), pnl = pnlAt(p, px, n);
    st.balance += pnl;
    st.closed.push({ id: p.id, sym: p.sym, side: p.side, lots: n, open: p.open, close: rpx(p.sym, px), openTime: p.openTime, closeTime: clock(), pnl: r2(pnl), reason, magic: p.magic, comment: p.comment, r0: p.meta && p.meta.r0 || 0 });
    if (st.closed.length > 5000) st.closed.splice(0, st.closed.length - 5000);
    if (n >= p.lots - 1e-9) st.positions.splice(i, 1); else p.lots = Math.round((p.lots - n) * 100) / 100;
    dirty = true; return { ok: true, pnl: r2(pnl) };
  }
  const closeAll = (magic, reason = 'MANUAL') => st.positions.filter(p => !magic || p.magic === magic).map(p => p.id).forEach(id => close(id, reason));
  function modify(id, { sl, tp, trail }) {
    const p = st.positions.find(x => x.id === +id); if (!p) return err('Position ma jirto');
    const q = getQuote(p.sym), px = p.side === 'BUY' ? q.bid : q.ask;
    if (sl !== undefined) { sl = +sl || 0; if (sl && (p.side === 'BUY' ? sl >= px : sl <= px)) return err('SL ma saxna'); p.sl = sl ? rpx(p.sym, sl) : 0 }
    if (tp !== undefined) { tp = +tp || 0; if (tp && (p.side === 'BUY' ? tp <= px : tp >= px)) return err('TP ma saxna'); p.tp = tp ? rpx(p.sym, tp) : 0 }
    if (trail !== undefined) p.trail = trail && +trail.dist > 0 ? { dist: +trail.dist, start: +trail.start || 0 } : null;
    dirty = true; return { ok: true, position: p };
  }
  const cancelOrder = id => { const i = st.orders.findIndex(o => o.id === +id); if (i < 0) return err('Order ma jiro'); st.orders.splice(i, 1); dirty = true; return { ok: true } };

  function onQuote(sym, q) {                                // wac quote kasta: SL / TP / trailing / pending
    for (const p of st.positions.filter(x => x.sym === sym)) {
      const buy = p.side === 'BUY', px = buy ? q.bid : q.ask;
      if (p.trail && (buy ? px - p.open : p.open - px) >= p.trail.start) {
        const ns = rpx(sym, buy ? px - p.trail.dist : px + p.trail.dist);
        if (buy ? ns > (p.sl || -Infinity) : ns < (p.sl || Infinity)) { p.sl = ns; dirty = true }
      }
      if (p.sl && (buy ? q.bid <= p.sl : q.ask >= p.sl)) { close(p.id, 'SL', null, px); continue }
      if (p.tp && (buy ? q.bid >= p.tp : q.ask <= p.tp)) close(p.id, 'TP', null, p.tp);
    }
    for (const o of st.orders.filter(x => x.sym === sym)) {
      const hit = (o.side === 'BUY' && o.type === 'LIMIT' && q.ask <= o.price) || (o.side === 'BUY' && o.type === 'STOP' && q.ask >= o.price) ||
                  (o.side === 'SELL' && o.type === 'LIMIT' && q.bid >= o.price) || (o.side === 'SELL' && o.type === 'STOP' && q.bid <= o.price);
      if (!hit) continue;
      st.orders.splice(st.orders.indexOf(o), 1);
      const r = place({ sym, side: o.side, lots: o.lots, sl: o.sl, tp: o.tp, comment: o.comment, magic: o.magic, meta: o.meta }); dirty = true;
      if (!r.ok) st.closed.push({ id: o.id, sym, side: o.side, lots: o.lots, open: o.price, close: o.price, openTime: o.time, closeTime: clock(), pnl: 0, reason: 'CANCEL: ' + r.error, magic: o.magic, comment: o.comment, r0: 0 });
    }
  }

  function onSecond() {                                     // stop-out + equity curve + peak/drawdown
    const s = snapshot();
    if (s.level !== null && s.level < stopOutPct && st.positions.length) {
      const worst = st.positions.map(p => [p, pnlAt(p, closePx(p))]).sort((a, b) => a[1] - b[1])[0][0]; close(worst.id, 'STOPOUT');
    }
    if (s.equity > st.peak) st.peak = s.equity;
    const dd = st.peak > 0 ? (st.peak - s.equity) / st.peak * 100 : 0; if (dd > st.maxDdPct) st.maxDdPct = dd;
    const t = clock();
    if (t - lastCurve >= st.curveEvery * 1000) {
      lastCurve = t; st.curve.push([t, s.equity, s.balance]);
      if (st.curve.length > 4000) { st.curve = st.curve.filter((_, i) => i % 2 === 0); st.curveEvery *= 2 }
      dirty = true;
    }
  }

  function stats(magic) {
    const c = st.closed.filter(t => !magic || t.magic === magic).filter(t => !/^CANCEL/.test(t.reason));
    const w = c.filter(t => t.pnl > 0), l = c.filter(t => t.pnl < 0), gp = w.reduce((a, t) => a + t.pnl, 0), gl = -l.reduce((a, t) => a + t.pnl, 0);
    let cum = 0, pk = 0, dd = 0; for (const t of c) { cum += t.pnl; pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum) }
    return { trades: c.length, wins: w.length, losses: l.length, winRate: c.length ? r2(w.length / c.length * 100) : 0, net: r2(gp - gl), grossProfit: r2(gp), grossLoss: r2(gl) + 0,
      profitFactor: gl > 0 ? r2(gp / gl) : (gp > 0 ? 99 : 0), avgWin: w.length ? r2(gp / w.length) : 0, avgLoss: l.length ? r2(-gl / l.length) : 0,
      expectancy: c.length ? r2((gp - gl) / c.length) : 0, maxDrawdown: r2(dd), maxDrawdownPct: r2(dd / st.startBalance * 100),
      best: c.length ? Math.max(...c.map(t => t.pnl)) : 0, worst: c.length ? Math.min(...c.map(t => t.pnl)) : 0 };
  }
  function pnlToday(magic) {
    const k = dayKey(clock()); let v = st.closed.filter(t => (!magic || t.magic === magic) && dayKey(t.closeTime) === k).reduce((a, t) => a + t.pnl, 0);
    for (const p of st.positions) if (!magic || p.magic === magic) v += pnlAt(p, closePx(p));
    return v;
  }
  const view = () => st.positions.map(p => { const px = closePx(p); return { ...p, price: px, pnl: r2(pnlAt(p, px)), margin: r2(marginFor(p.sym, p.lots)) } });
  const save = () => { if (!dirty) return; dirty = false; try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(st)); fs.renameSync(file + '.tmp', file) } catch (e) {} };
  function reset(balance) { st = fresh(); if (balance > 0) { st.balance = st.startBalance = st.peak = +balance } dirty = true; save() }
  return { snapshot, place, close, closeAll, modify, cancelOrder, onQuote, onSecond, stats, pnlToday, view, save, reset,
    orders: () => st.orders, closedList: n => st.closed.slice(-(n || 200)).reverse(), curve: () => st.curve, peak: () => st.peak, maxDdPct: () => st.maxDdPct, raw: () => st };
}
module.exports = { createBroker };
