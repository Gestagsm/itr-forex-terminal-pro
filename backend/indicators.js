'use strict';
/* indicators.js — EMA, SMA, RSI, ATR, MACD, Donchian (dhammaan waa arrays, qiimaha ugu dambeeyay = index ugu dambeeya) */
const ema = (v, n) => { const k = 2 / (n + 1), o = []; let e = v[0]; for (let i = 0; i < v.length; i++) { e = i === 0 ? v[0] : v[i] * k + e * (1 - k); o.push(e) } return o };
const sma = (v, n) => v.map((_, i) => i < n - 1 ? NaN : v.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n);
function rsi(c, n = 14) {                                   // Wilder
  const o = new Array(c.length).fill(NaN); if (c.length <= n) return o;
  let g = 0, l = 0; for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; d >= 0 ? g += d : l -= d } g /= n; l /= n;
  o[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l) }
  return o;
}
function atr(h, l, c, n = 14) {                             // Wilder
  const tr = c.map((_, i) => i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  const o = new Array(c.length).fill(NaN); if (c.length < n) return o;
  let a = tr.slice(0, n).reduce((x, y) => x + y, 0) / n; o[n - 1] = a;
  for (let i = n; i < c.length; i++) { a = (a * (n - 1) + tr[i]) / n; o[i] = a } return o;
}
function macd(c, f = 12, s = 26, sg = 9) { const ef = ema(c, f), es = ema(c, s), line = ef.map((x, i) => x - es[i]), sig = ema(line, sg); return { line, signal: sig, hist: line.map((x, i) => x - sig[i]) } }
const highest = (v, n, end = v.length) => Math.max(...v.slice(Math.max(0, end - n), end));
const lowest = (v, n, end = v.length) => Math.min(...v.slice(Math.max(0, end - n), end));
module.exports = { ema, sma, rsi, atr, macd, highest, lowest };
