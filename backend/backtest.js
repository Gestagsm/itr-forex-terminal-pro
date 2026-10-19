'use strict';
/* backtest.js — robot-ka ku tijaabi suuqa simulated (Engine + broker + robot DHAQAN ah)
 * Isticmaal:  node backtest.js [maalmo=14] [runs=1] ['{"tf":"M15"}']     (tusaale: node backtest.js 30 3)
 * Ogow: natiijadu waxay ku saabsan tahay suuqa simulated — MA aha caddayn faa'iido suuq dhab ah. */
const os = require('os'), path = require('path'), fs = require('fs');
const M = require('./market'), { createBroker } = require('./broker'), { createRobot } = require('./robot');
const days = +process.argv[2] || 14, runs = +process.argv[3] || 1, WARM = 24 * 3600e3;
let BT_CFG = {}; try { BT_CFG = JSON.parse(process.argv[4] || '{}') } catch (e) {}      // tusaale: '{"tf":"M15","rr":2}'

function run(seed) {
  const SYMS = Object.keys(M.SYM_DEFS), eng = {}, m1 = {}, cur = {};
  for (const s of SYMS) { eng[s] = new M.Engine(M.SYM_DEFS[s], M.SYM_DEFS[s].start); m1[s] = []; cur[s] = null }
  let T = Date.now() - (days * 86400e3 + WARM); const end = Date.now(), tradeFrom = T + WARM;
  const file = path.join(os.tmpdir(), 'bt_account_' + process.pid + '.json'); try { fs.unlinkSync(file) } catch (e) {}
  const broker = createBroker({ defs: M.SYM_DEFS, getQuote: s => eng[s].quote(), file, clock: () => T, curveEvery: 600 });
  const robot = createRobot({ broker, symbols: SYMS, defs: M.SYM_DEFS, getQuote: s => eng[s].quote(), clock: () => T, store: { get: () => BT_CFG, set() {} },
    getCandles: (s, tf, from, to) => { const a = m1[s]; let lo = 0, hi = a.length; while (lo < hi) { const mid = (lo + hi) >> 1; a[mid].t < from ? lo = mid + 1 : hi = mid }
      const sl = []; for (let i = lo; i < a.length && a[i].t < to; i++) sl.push(a[i]); return M.aggregateM1(sl, M.TF[tf]) } });
  for (; T < end; T += 1000) {
    const d = new Date(T), f = M.market(d, false).factor, trading = T >= tradeFrom;
    for (const s of SYMS) {
      const n = M.poisson(8 * f), minute = Math.floor(T / 60000) * 60000;
      for (let i = 0; i < n; i++) {
        const q = eng[s].step(f), c = cur[s];
        if (c && c.t !== minute) { m1[s].push(c); cur[s] = null }
        const k = cur[s] || (cur[s] = { t: minute, o: q.bid, h: q.bid, l: q.bid, c: q.bid, v: 0, n: 0 });
        if (q.bid > k.h) k.h = q.bid; if (q.bid < k.l) k.l = q.bid; k.c = q.bid; k.v++; k.n++;
        if (trading) broker.onQuote(s, q);
      }
    }
    if (trading) { broker.onSecond();
      if (process.env.RANDOM) { for (const s of SYMS) if (Math.random() < 1 / 1800 && !broker.view().some(p => p.sym === s)) {            // DEBUG: gal random ah (null test)
        const a = M.aggregateM1(m1[s].slice(-15 * 15), 15), at = a.slice(-14).reduce((x, c) => x + (c.h - c.l), 0) / 14, r0 = 1.5 * at, q = eng[s].quote(), b = Math.random() < 0.5, e = b ? q.ask : q.bid;
        broker.place({ sym: s, side: b ? 'BUY' : 'SELL', lots: 0.1, sl: b ? e - r0 : e + r0, tp: b ? e + 2 * r0 : e - 2 * r0, magic: 'EA', meta: { r0 } }) } }
      else robot.onSecond(T) }
  }
  broker.closeAll(null, 'END');
  if (process.env.SIDES) { const ea = broker.raw().closed.filter(x => x.magic === 'EA'); for (const sd of ['BUY', 'SELL']) { const t = ea.filter(x => x.side === sd), tp = t.filter(x => x.reason === 'TP').length; console.log('   ' + sd, t.length, 'trades | TP', tp, '| net $' + t.reduce((a, x) => a + x.pnl, 0).toFixed(0)) } }
  if (process.env.DEBUG) for (const t of broker.raw().closed.filter(x => x.magic === 'EA').slice(0, 10)) console.log('   T', t.sym, t.side, 'open', t.open, 'close', t.close, 'r0', t.r0.toFixed(5), 'move/r0', ((t.side === 'BUY' ? t.close - t.open : t.open - t.close) / t.r0).toFixed(2), t.reason, 'held', ((t.closeTime - t.openTime) / 60000).toFixed(0) + 'm', '$' + t.pnl);
  return { stats: broker.stats('EA'), bal: broker.snapshot().balance, dd: broker.maxDdPct(), by: SYMS.map(s => [s, broker.raw().closed.filter(t => t.sym === s && t.magic === 'EA')]) };
}
const t0 = Date.now(); let tot = { trades: 0, net: 0, gp: 0, gl: 0, wins: 0 };
for (let r = 1; r <= runs; r++) {
  const { stats: s, bal, dd, by } = run(r);
  console.log(`\n=== RUN ${r}: ${days} maalmood | trades ${s.trades} | win ${s.winRate}% | PF ${s.profitFactor} | net $${s.net} | maxDD ${s.maxDrawdownPct}% | final balance $${bal}`);
  console.log('   avgWin $' + s.avgWin, ' avgLoss $' + s.avgLoss, ' expectancy $' + s.expectancy + '/trade');
  const rs = {}; for (const [, t] of by) for (const x of t) { const o = rs[x.reason] || (rs[x.reason] = { n: 0, p: 0 }); o.n++; o.p += x.pnl }
  console.log('   exits: ' + Object.entries(rs).map(([k, o]) => `${k} ${o.n} (avg $${(o.p / o.n).toFixed(0)})`).join(' | '));
  console.log('   ' + by.map(([sy, t]) => `${sy}: ${t.length}t $${t.reduce((a, x) => a + x.pnl, 0).toFixed(0)}`).join(' | '));
  tot.trades += s.trades; tot.net += s.net; tot.gp += s.grossProfit; tot.gl += s.grossLoss; tot.wins += s.wins;
}
console.log(`\nGUUD (${runs} run): trades ${tot.trades} | win ${(tot.wins / (tot.trades || 1) * 100).toFixed(1)}% | PF ${(tot.gp / (tot.gl || 1)).toFixed(2)} | net $${tot.net.toFixed(0)}   [${((Date.now() - t0) / 1000).toFixed(1)}s]`);
