'use strict';
/* market.js — wadaagga: helpers, suuqyada (symbols), sessions, price Engine, candle aggregation */
const rnd = (a, b) => a + Math.random() * (b - a), ri = (a, b) => Math.floor(rnd(a, b + 1));
const pick = a => a[Math.floor(Math.random() * a.length)];
const wpick = pairs => { let t = pairs.reduce((s, p) => s + p[1], 0), r = Math.random() * t; for (const [p, w] of pairs) { if ((r -= w) < 0) return p } return pairs[0][0] };
const poisson = l => { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= Math.random() } while (p > L); return k - 1 };
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) };
const skew = max => Math.min(max, Math.floor(Math.exp(Math.random() * Math.log(max))));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const p2 = n => String(n).padStart(2, '0');
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtT = d => `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
const fmtDT = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${fmtT(d)}`;
const dayKey = t => { const x = new Date(t); return `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())}` };

// sigma = dhaqdhaqaaqa celceliska quote kasta (ticks); spr = spread [min,max] (ticks). Qiimaha bilowga waa demo (START_<SYMBOL> ayaa beddeli kara)
const SYM_DEFS = {
  EURUSD: { label: 'EUR/USD', base: 'EUR', quote: 'USD', start: 1.1318, dig: 5, sigma: 1.05, spr: [6, 12], size: 100000 },
  GBPUSD: { label: 'GBP/USD', base: 'GBP', quote: 'USD', start: 1.3252, dig: 5, sigma: 1.35, spr: [8, 16], size: 100000 },
  USDJPY: { label: 'USD/JPY', base: 'USD', quote: 'JPY', start: 158.300, dig: 3, sigma: 1.3, spr: [5, 10], size: 100000 },
  AUDUSD: { label: 'AUD/USD', base: 'AUD', quote: 'USD', start: 0.6980, dig: 5, sigma: 0.95, spr: [7, 14], size: 100000 },
  USDCAD: { label: 'USD/CAD', base: 'USD', quote: 'CAD', start: 1.3950, dig: 5, sigma: 1.1, spr: [10, 18], size: 100000 },
  XAUUSD: { label: 'XAU/USD', base: 'XAU', quote: 'USD', start: 4300.00, dig: 2, sigma: 6.5, spr: [20, 40], size: 100 }
};

/* sessions (UTC) -> factor = tirada quote-yada iyo kacsanaanta */
const SESSIONS = [{ n: 'Sydney', o: 22, c: 7, w: 0.5 }, { n: 'Tokyo', o: 0, c: 9, w: 0.8 }, { n: 'London', o: 8, c: 17, w: 1.5 }, { n: 'New York', o: 13, c: 22, w: 1.5 }];
function market(now, weekendClosed) {
  const h = now.getUTCHours() + now.getUTCMinutes() / 60, day = now.getUTCDay();
  const sessions = SESSIONS.map(s => ({ name: s.n, open: s.o < s.c ? h >= s.o && h < s.c : (h >= s.o || h < s.c), w: s.w }));
  const closed = !!weekendClosed && (day === 6 || (day === 5 && h >= 22) || (day === 0 && h < 22));
  const f = sessions.filter(s => s.open).reduce((a, s) => a + s.w, 0);
  return { closed, sessions: sessions.map(({ name, open }) => ({ name, open })), factor: closed ? 0 : Math.max(0.3, f / 2) };
}

/* price engine: random walk + trend (momentum) + volatility clustering + spread + news spikes */
class Engine {
  constructor(def, start, st) {
    st = st || {};
    this.def = def; this.tick = Math.pow(10, -def.dig); this.anchor = Math.round(start / this.tick);
    this.bid = st.bid !== undefined ? st.bid : this.anchor; this.sp = st.sp || Math.round((def.spr[0] + def.spr[1]) / 2);
    this.drift = st.drift || 0; this.lnv = st.lnv || 0; this.reg = st.reg || 0; this.regLeft = st.regLeft || 0; this.dir = '⇧';
  }
  px(n) { return +(n * this.tick).toFixed(this.def.dig) }
  quote() { return { bid: this.px(this.bid), ask: this.px(this.bid + this.sp), dir: this.dir } }
  step(factor) {
    const d = this.def;
    this.lnv = this.lnv * 0.999 + gauss() * 0.02;
    const v = Math.sqrt(factor) * Math.exp(this.lnv);
    this.drift = clamp(this.drift * 0.9995 + gauss() * 0.0002 + (this.anchor - this.bid) / this.anchor * 0.00005, -0.1, 0.1);
    if (--this.regLeft <= 0) { this.reg = Math.random() < 0.45 ? (Math.random() < 0.5 ? -1 : 1) * rnd(0.006, 0.012) : 0; this.regLeft = ri(8000, 40000) }   // regime: trend (saacado) ama range
    let mv = Math.round((gauss() + this.drift + this.reg) * d.sigma * v);
    if (Math.random() < 1 / 20000) mv += (Math.random() < 0.5 ? -1 : 1) * Math.round(d.sigma * rnd(6, 12));
    if (mv) this.dir = mv > 0 ? '⇧' : '⇩';
    this.bid += mv;
    const target = (d.spr[0] + d.spr[1]) / 2 / Math.sqrt(factor);
    this.sp = Math.round(clamp(this.sp + (target - this.sp) * 0.05 + gauss() * 0.8, d.spr[0], d.spr[1] * 1.6));
    return this.quote();
  }
}

/* candles */
const TF = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 };
const cTime = t => fmtDT(new Date(t)).slice(0, 16);
const timezoneFormatters = new Map();
function timezoneFormatter(timezone) {
  if (!timezoneFormatters.has(timezone)) timezoneFormatters.set(timezone,
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }));
  return timezoneFormatters.get(timezone);
}
function timezoneParts(timestamp, timezone) {
  const parts = Object.fromEntries(timezoneFormatter(timezone).formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute, second: +parts.second };
}
function timezoneOffset(timestamp, timezone) {
  const parts = timezoneParts(timestamp, timezone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    - Math.floor(timestamp / 1000) * 1000;
}
function timezoneBoundary(parts, timezone, preferredOffset) {
  const wallTime = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0);
  if (preferredOffset !== undefined) return wallTime - preferredOffset;
  let result = wallTime - timezoneOffset(wallTime, timezone);
  for (let i = 0; i < 4; i++) {
    const next = wallTime - timezoneOffset(result, timezone);
    if (next === result) break;
    result = next;
  }
  return result;
}
function cTimeInTimezone(timestamp, timezone) {
  const p = timezoneParts(timestamp, timezone);
  return `${p.year}-${p2(p.month)}-${p2(p.day)} ${p2(p.hour)}:${p2(p.minute)}`;
}
function timezoneDayStart(value, timezone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) return NaN;
  const parts = { year: +match[1], month: +match[2], day: +match[3] };
  const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (check.getUTCFullYear() !== parts.year || check.getUTCMonth() + 1 !== parts.month || check.getUTCDate() !== parts.day) return NaN;
  return timezoneBoundary(parts, timezone);
}
function candleBucketTime(timestamp, tfMin, timezone) {
  if (!timezone) {
    const date = new Date(timestamp);
    date.setHours(0, Math.floor((date.getHours() * 60 + date.getMinutes()) / tfMin) * tfMin, 0, 0);
    return date.getTime();
  }
  const parts = timezoneParts(timestamp, timezone);
  const minuteOfDay = parts.hour * 60 + parts.minute;
  const bucketMinute = Math.floor(minuteOfDay / tfMin) * tfMin;
  parts.hour = Math.floor(bucketMinute / 60);
  parts.minute = bucketMinute % 60;
  return tfMin === 1440
    ? timezoneBoundary(parts, timezone)
    : timezoneBoundary(parts, timezone, timezoneOffset(timestamp, timezone));
}
function aggregateM1(m1, tfMin, timezone) {            // M1 -> tf, aligned to local midnight and timezone offsets
  if (!Number.isInteger(tfMin) || tfMin < 1 || tfMin > 1440 || 1440 % tfMin !== 0) return [];
  const ordered = [...m1].filter(c => c && Number.isFinite(Number(c.t))).sort((a, b) => a.t - b.t);
  const out = new Map();
  for (const c of ordered) {
    const key = candleBucketTime(c.t, tfMin, timezone), g = out.get(key);
    if (!g) out.set(key, { t: key, time: cTime(key), o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, n: c.n });
    else { if (c.h > g.h) g.h = c.h; if (c.l < g.l) g.l = c.l; g.c = c.c; g.v += c.v; g.n += c.n }
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}
module.exports = { rnd, ri, pick, wpick, poisson, gauss, skew, clamp, p2, MON, fmtT, fmtDT, dayKey, SYM_DEFS, SESSIONS, market, Engine, TF, cTime, cTimeInTimezone, timezoneDayStart, aggregateM1 };
