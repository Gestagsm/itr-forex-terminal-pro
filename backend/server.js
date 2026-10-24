'use strict';
/* ITR Demo Forex Market + Trader Robot + Live Data Generator
 * - suuqyo forex ah (EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD, XAU/USD) oo live u dhaqma
 * - mid walba wuxuu dhalaa saddex xog oo gooni ah: TAQ, TAS, GCV (columns = sida files-kaaga)
 * - ILBIRIQSI KASTA: xogta waxaa lagu qoraa folder-ka la doortay (<folder>/<SYMBOL>/..._LIVE.csv) + database-ka ayaa loo diraa
 * - 4-saac kasta: fayl Excel (.xlsx) + archive (.gz) oo History page-ku akhriyo
 * - broker demo + robot (EA) + candles + History page  |  waxba lama lumo: journal + outbox + state + recovery
 */
const fs = require('fs'), path = require('path'), http = require('http'), zlib = require('zlib'), os = require('os'), crypto = require('crypto');
const XLSX = require('xlsx');
const { createDatabase } = require('./database');
const { appendFileWithRetry } = require('./append-file-retry');
const M = require('./market');
const { ri, pick, wpick, poisson, skew, p2, MON, fmtT, fmtDT, dayKey, SYM_DEFS, Engine, TF, cTime, cTimeInTimezone, timezoneDayStart, aggregateM1 } = M;
const { createBroker } = require('./broker'), { createRobot } = require('./robot');
const BASE = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(BASE, '.env') });
const ENV = process.env;
const DB_CONFIGURED = !!(ENV.DATABASE_URL || ENV.PGHOST || ENV.PGDATABASE || ENV.PGUSER);
const database = DB_CONFIGURED ? createDatabase({
  connectionString: ENV.DATABASE_URL,
  host: ENV.PGHOST || '127.0.0.1',
  port: +(ENV.PGPORT || 5432),
  database: ENV.PGDATABASE || 'postgres',
  user: ENV.PGUSER || 'postgres',
  password: ENV.PGPASSWORD || ''
}) : null;
const { readHistoryBlock } = require('./history-block-reader');
const dbStatus = { configured: DB_CONFIGURED, connected: false, historySynced: false, timescale: false, importedRows: 0, error: '' };

const CONFIG = {
  historyDir: ENV.HISTORY_DIR || path.join(BASE, 'history'),
  blockMinutes: +ENV.BLOCK_MINUTES || 240,
  statusPort: +ENV.STATUS_PORT || 4100, host: ENV.HOST || '127.0.0.1',
  batchSize: 1000, quoteRate: +ENV.QUOTE_RATE || 8, rateScale: +ENV.RATE_SCALE || 1,
  warmupHours: ENV.WARMUP_HOURS === undefined ? 72 : +ENV.WARMUP_HOURS,
  weekendClosed: ENV.WEEKEND_CLOSED === '1', keepCsv: ENV.KEEP_CSV === '1', liveXlsx: ENV.LIVE_XLSX_SECONDS === undefined ? 60 : +ENV.LIVE_XLSX_SECONDS, openBrowser: ENV.NO_OPEN !== '1',
  localTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
};
const API_TOKEN = ENV.API_TOKEN || '';
const API_COOKIE_SECURE = ENV.API_COOKIE_SECURE === '1';
if (API_TOKEN && API_TOKEN.length < 32) throw new Error('API_TOKEN must be at least 32 characters; generate a unique random value before starting the terminal.');
if (!['127.0.0.1', '::1', 'localhost', '[::1]'].includes(CONFIG.host) && !API_COOKIE_SECURE) {
  throw new Error('Remote terminal binding requires API_COOKIE_SECURE=1 behind a trusted HTTPS reverse proxy.');
}
const API_SESSION_COOKIE = 'itr_terminal_session', API_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const API_LOGIN_WINDOW_MS = 15 * 60 * 1000, API_LOGIN_MAX_ATTEMPTS = 8;
const apiSessions = new Map(), apiLoginAttempts = new Map();
const SYMBOLS = (ENV.SYMBOLS || Object.keys(SYM_DEFS).join(',')).split(',').map(s => s.trim().toUpperCase().replace('/', '')).filter(s => SYM_DEFS[s]);
const log = (k, m) => console.log(`[${fmtDT(new Date())}] [${k}] ${m}`);
const readLines = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

/* ---------- config.json (folders + robot) ---------- */
fs.mkdirSync(CONFIG.historyDir, { recursive: true });
const CFG_FILE = path.join(CONFIG.historyDir, '.config.json');
let cfg = { folders: {}, robot: {}, setupDone: false }; try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) } } catch (e) {}
const saveCfg = () => fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 1));

/* ---------- saddexda xog (columns = sida saddex files-kaaga) ---------- */
const DS = {
  gcv: { name: 'GCV', section: 'gcv',
    cols: ['TIMEACT NS','Tick','Last','Bid','Ask','B Size','A Size','NUM BID ORDERS 1','NUM ASK ORDERS 1','NUMBER OF ORDERS','Trd.Vol','Volume','ELIGBL TRD ACVOL','Moves','AGGRESSIVE ORD1','TRADE_ID'],
    gen(S, d, q) { const up = q.dir === '⇧', g = S.g;
      const ag = up ? wpick([['BID  ', 50], ['     ', 50]]) : wpick([['ASK  ', 70], ['     ', 30]]);
      const e = ri(1, 3); g.vol += ri(2, 9); g.elig += e; g.mv += e; g.tid += ri(20, 40);
      return { 'TIMEACT NS': fmtT(d), Tick: ' ' + q.dir, Last: up ? q.ask : q.bid, Bid: q.bid, Ask: q.ask, 'B Size': skew(26), 'A Size': skew(21),
        'NUM BID ORDERS 1': ri(0, 3), 'NUM ASK ORDERS 1': ri(0, 3), 'NUMBER OF ORDERS': ri(1, 3), 'Trd.Vol': wpick([[1, 85], [2, 10], [3, 4], [5, 1]]),
        Volume: g.vol, 'ELIGBL TRD ACVOL': g.elig, Moves: g.mv, 'AGGRESSIVE ORD1': ag, TRADE_ID: String(g.tid) } } },
  taq: { name: 'TAQ', section: 'taq-pro',
    cols: ['Timestamp','PRCTCK_1','BID','ASK','BIDSIZE','ASKSIZE','SEQNUM','RTL','QUALIFIERS'],
    gen(S, d, q) {
      return { Timestamp: fmtDT(d), PRCTCK_1: q.dir, BID: q.bid, ASK: q.ask, BIDSIZE: skew(30), ASKSIZE: skew(30), SEQNUM: skew(2200),
        RTL: pick([16, 16, 16, 32, 96, 240, 256, 384]),
        QUALIFIERS: wpick([['1[ASK_COND_N]', 33], ['0[BID_COND_N]', 32], ['0[BID_COND_N];1[ASK_COND_N]', 28], ['0E[BID_COND_N]', 2], ['1F[ASK_COND_N]', 2], ['E[BID_COND_N]', 1]]) } } },
  tas: { name: 'TAS', section: 'tas-regime',
    cols: ['Timestamp','PRCTCK_1','AGGRS_SID1','TRDPRC_1','BID','ASK','BIDSIZE','ASKSIZE','TRDVOL_1','TRADE_ID','SEQNUM','RTL','QUALIFIERS'],
    gen(S, d, q) { const buy = Math.random() < 0.52;
      return { Timestamp: fmtDT(d), PRCTCK_1: buy ? '⇧' : '⇩', AGGRS_SID1: buy ? 'BID' : 'ASK', TRDPRC_1: buy ? q.ask : q.bid, BID: q.bid, ASK: q.ask,
        BIDSIZE: skew(39), ASKSIZE: skew(31), TRDVOL_1: wpick([[1, 70], [2, 15], [3, 7], [5, 5], [20, 2], [100, 1]]), TRADE_ID: skew(700),
        SEQNUM: skew(5000), RTL: pick([48, 96, 160, 240, 528, 832]),
        QUALIFIERS: wpick([['⇩[ACT_TP_1];2[LSTSALCOND];   [LIMIT_IND]', 33], ['⇧[ACT_TP_1];2[LSTSALCOND];   [LIMIT_IND]', 33], ['[ACT_TP_1];2[LSTSALCOND];   [LIMIT_IND]', 27], ['SPL TRD[USER]', 7]]) } } }
};
const DSK = Object.keys(DS), DSN = DSK.map(k => DS[k].name);

/* ---------- folders (la doorto) + disk layout ---------- */
const rootOf = name => cfg.folders[name] || path.join(CONFIG.historyDir, name);
const dirOf = s => path.join(rootOf(s.name), s.sym);
const jdirOf = s => path.join(dirOf(s), '.journal'), adirOf = s => path.join(dirOf(s), '.archive');
const outboxOf = s => path.join(CONFIG.historyDir, '.outbox', `${s.name}_${s.sym}.ndjson`);
const cdirOf = k => path.join(CONFIG.historyDir, 'candles', k);
const hhmm = d => p2(d.getHours()) + p2(d.getMinutes());
const prep = s => { for (const d of [dirOf(s), jdirOf(s), adirOf(s)]) fs.mkdirSync(d, { recursive: true }) };
function blockOf(now) {
  const sm = Math.floor((now.getHours() * 60 + now.getMinutes()) / CONFIG.blockMinutes) * CONFIG.blockMinutes;
  const start = new Date(now); start.setHours(0, sm, 0, 0);
  return { start, end: new Date(start.getTime() + CONFIG.blockMinutes * 60000) };
}
// magaca faylasha Excel/CSV = sida kuwa aad soo gudbisay: TAQ_23Jul2026_1600_to_2000 | TAS_24Jul2026_1600_to_2000 | GCv1__2026-01-27_12-10   (suuqa = folder-ka hoose)
const outName = (s, st, en) => { st = new Date(st); en = new Date(en);
  return s.name === 'GCV' ? `GCv1__${dayKey(st)}_${p2(st.getHours())}-${p2(st.getMinutes())}` : `${s.name}_${p2(st.getDate())}${MON[st.getMonth()]}${st.getFullYear()}_${hhmm(st)}_to_${hhmm(en)}` };
const baseName = (s, b) => `${s.name}_${s.sym}_${p2(b.start.getDate())}${MON[b.start.getMonth()]}${b.start.getFullYear()}_${hhmm(b.start)}_to_${hhmm(b.end)}`;

/* ---------- Excel ---------- */
function excelSerial(s) { const m = /^(\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+)$/.exec(s); if (!m) return s;
  return Date.UTC(+m[1], m[2] - 1, +m[3]) / 864e5 + 25569 + (m[4] * 3600 + m[5] * 60 + +m[6]) / 86400 }
function timeSerial(s) { const m = /^(\d+):(\d+):(\d+)$/.exec(s); return m ? (m[1] * 3600 + m[2] * 60 + +m[3]) / 86400 : s }
function buildWorkbook(ds, rows) {
  rows = rows.slice().reverse();                                       // ugu cusub kor, sida files-kaaga
  const aoa = [ds.cols, ...rows.map(r => ds.cols.map(c => {
    if (ds.name === 'TAS' && c === 'Timestamp') return { t: 'n', v: excelSerial(r[c]), z: 'YYYY-MM-DD HH:MM:SS' };
    if (ds.name === 'GCV' && c === 'TIMEACT NS') return { t: 'n', v: timeSerial(r[c]), z: 'h:mm:ss' };
    return r[c];
  }))];
  const ws = XLSX.utils.aoa_to_sheet(aoa), wb = XLSX.utils.book_new();
  ws['!cols'] = ds.cols.map(c => ({ wch: Math.max(c.length + 2, 12) })); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1'); return wb;
}
// finalize: hal fayl mar kasta (si ticks-ku u sii socdaan). xlsx + archive.gz + tirtir journal (kaliya haddii xlsx guulaystay)
const finQueue = []; let finBusy = false;
function finalizeJournal(s, jfile) { finQueue.push([s, jfile]); if (!finBusy) { finBusy = true; setTimeout(pumpFinalize, 20) } }
function pumpFinalize() {
  const job = finQueue.shift(); if (!job) { finBusy = false; return }
  const [s, jfile] = job, name = path.basename(jfile, '.ndjson'), out = path.dirname(path.dirname(jfile)), pb = parseBlock(name), on = pb ? outName(s, pb.start, pb.end) : name;
  try {
    if (fs.existsSync(jfile)) {
      const raw = fs.readFileSync(jfile), rows = readBlock({ file: jfile, gz: false });
      if (rows.length) {
        const x = path.join(out, on + '.xlsx'); XLSX.writeFile(buildWorkbook(s.ds, rows), x + '.tmp', { bookType: 'xlsx' }); fs.renameSync(x + '.tmp', x);
        fs.mkdirSync(path.join(out, '.archive'), { recursive: true }); fs.writeFileSync(path.join(out, '.archive', name + '.ndjson.gz'), zlib.gzipSync(raw));
        s.files++; log(s.name + ':' + s.sym, `📁 ${s.sym}/${on}.xlsx (${rows.length} rows)`);
      }
      fs.unlinkSync(jfile);
      if (!CONFIG.keepCsv) try { fs.unlinkSync(path.join(out, on + '_LIVE.csv')) } catch (e) {}
    }
  } catch (e) { log(s.name + ':' + s.sym, '✖ finalize failed (journal waa la hayaa): ' + e.message); s.lastError = e.message }
  setTimeout(pumpFinalize, 50);
}

/* ---------- symbols runtime + state ---------- */
const STATE_DIR = path.join(CONFIG.historyDir, '.state'); fs.mkdirSync(STATE_DIR, { recursive: true });
const SY = {};
for (const k of SYMBOLS) {
  let st = {}; try { st = JSON.parse(fs.readFileSync(path.join(STATE_DIR, k + '.json'), 'utf8')) } catch (e) {}
  const def = SYM_DEFS[k], start = +ENV['START_' + k] || def.start;
  SY[k] = { k, def, eng: new Engine(def, start, st), g: st.g || { vol: 51580, elig: 44993, mv: 32902, tid: 133063664 }, day: st.day || null, c1: null, lastTime: null };
  fs.mkdirSync(cdirOf(k), { recursive: true });
  try { SY[k].c1 = JSON.parse(fs.readFileSync(path.join(cdirOf(k), '.open.json'), 'utf8')) } catch (e) {}
}
const saveState = () => { for (const k of SYMBOLS) { const S = SY[k], e = S.eng;
  fs.writeFileSync(path.join(STATE_DIR, k + '.json'), JSON.stringify({ bid: e.bid, sp: e.sp, drift: e.drift, lnv: e.lnv, reg: e.reg, regLeft: e.regLeft, g: S.g, day: S.day })) } broker.save() };
function dayStat(S, now, bid) {
  const dk = dayKey(now.getTime());
  if (!S.day || S.day.date !== dk) S.day = { date: dk, open: bid, high: bid, low: bid }; else { if (bid > S.day.high) S.day.high = bid; if (bid < S.day.low) S.day.low = bid }
}

/* ---------- candles ---------- */
const cfile = (k, t) => path.join(cdirOf(k), `${k}_M1_${dayKey(t)}.ndjson`);
function candleAdd(S, now, p, v, warm) {
  const t = Math.floor(now.getTime() / 60000) * 60000;
  if (S.c1 && S.c1.t !== t) { fs.appendFileSync(cfile(S.k, S.c1.t), JSON.stringify(S.c1) + '\n'); S.c1 = null }
  const c = S.c1 || (S.c1 = warm ? { t, o: p, h: p, l: p, c: p, v: 0, n: 0, w: 1 } : { t, o: p, h: p, l: p, c: p, v: 0, n: 0 });
  if (p > c.h) c.h = p; if (p < c.l) c.l = p; c.c = p; c.v += v; c.n++;
}
function queryCandles(S, tf, from, to, timezone = CONFIG.localTimezone) {
  const t = new Date(from); t.setHours(0, 0, 0, 0); t.setDate(t.getDate() - 1); const m1 = [];
  const fileEnd = new Date(to); fileEnd.setHours(0, 0, 0, 0); fileEnd.setDate(fileEnd.getDate() + 1);
  for (; t.getTime() <= fileEnd.getTime(); t.setDate(t.getDate() + 1)) { const f = cfile(S.k, t.getTime()); if (!fs.existsSync(f)) continue; for (const c of readLines(f)) if (c.t >= from && c.t < to) m1.push(c) }
  if (S.c1 && S.c1.t >= from && S.c1.t < to) m1.push({ ...S.c1 });
  const unique = new Map(m1.map(c => [c.t, c]));
  return aggregateM1([...unique.values()].sort((a, b) => a.t - b.t), TF[tf], timezone);
}
function warmup(S) {
  if (CONFIG.warmupHours <= 0) return;
  const end = Math.floor(Date.now() / 60000) * 60000;
  const from = end - Math.ceil(CONFIG.warmupHours * 60) * 60000, existing = new Map();
  for (let t = new Date(from); t.getTime() < end; t.setDate(t.getDate() + 1)) {
    const file = cfile(S.k, t.getTime());
    if (fs.existsSync(file)) for (const candle of readLines(file)) if (candle.t >= from && candle.t < end) existing.set(candle.t, candle);
  }
  if (S.c1 && S.c1.t >= from && S.c1.t < end) existing.set(S.c1.t, { ...S.c1 });

  let expected = 0;
  for (let t = from; t < end; t += 60000) if (!M.market(new Date(t), CONFIG.weekendClosed).closed) expected++;
  const recentFrom = Math.max(from, end - Math.min(6 * 60, Math.ceil(CONFIG.warmupHours * 60)) * 60000);
  let recentExpected = 0, recentExisting = 0;
  for (let t = recentFrom; t < end; t += 60000) {
    if (!M.market(new Date(t), CONFIG.weekendClosed).closed) {
      recentExpected++;
      if (existing.has(t)) recentExisting++;
    }
  }
  const missingHistory = expected > 0 && (existing.size < expected * 0.8
    || recentExpected > 0 && recentExisting < recentExpected * 0.8);
  const initialCount = existing.size;
  const generated = new Map();
  if (missingHistory) {
    const historyEngine = new Engine(S.def, S.def.start);
    for (let t = from; t < end; t += 60000) {
      const market = M.market(new Date(t), CONFIG.weekendClosed);
      if (market.closed) continue;
      const candle = { t, o: 0, h: -Infinity, l: Infinity, c: 0, v: 0, n: 0, w: 1 };
      const ticks = poisson(CONFIG.quoteRate * CONFIG.rateScale * market.factor * 60);
      for (let i = 0; i < ticks; i++) {
        const price = historyEngine.step(market.factor).bid;
        if (!candle.o) candle.o = price;
        candle.h = Math.max(candle.h, price);
        candle.l = Math.min(candle.l, price);
        candle.c = price;
        candle.v++;
        candle.n++;
      }
      if (!candle.n) candle.o = candle.h = candle.l = candle.c = historyEngine.quote().bid;
      generated.set(t, candle);
    }

    const offset = S.eng.px(S.eng.bid) - [...generated.values()].at(-1).c;
    const roundPrice = value => +value.toFixed(S.def.dig);
    for (const candle of generated.values()) {
      for (const key of ['o', 'h', 'l', 'c']) candle[key] = roundPrice(candle[key] + offset);
      if (!existing.has(candle.t)) existing.set(candle.t, candle);
    }
  }

  if (S.c1 && S.c1.t < end) existing.set(S.c1.t, { ...S.c1 });
  const byDate = new Map();
  for (const candle of existing.values()) {
    if (candle.t < from || candle.t >= end) continue;
    const date = dayKey(candle.t);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(candle);
  }
  for (const [date, candles] of byDate) {
    const file = path.join(cdirOf(S.k), `${S.k}_M1_${date}.ndjson`);
    const previous = fs.existsSync(file) ? readLines(file) : [];
    const merged = new Map(previous.map(candle => [candle.t, candle]));
    for (const candle of candles) if (!merged.has(candle.t)) merged.set(candle.t, candle);
    fs.writeFileSync(file, [...merged.values()].sort((a, b) => a.t - b.t).map(candle => JSON.stringify(candle)).join('\n') + '\n');
  }

  const quote = S.eng.quote();
  S.c1 = S.c1 && S.c1.t === end ? S.c1 : { t: end, o: quote.bid, h: quote.bid, l: quote.bid, c: quote.bid, v: 0, n: 0 };
  fs.writeFileSync(path.join(cdirOf(S.k), '.open.json'), JSON.stringify(S.c1));
  const backfilled = missingHistory ? Math.max(0, expected - initialCount) : 0;
  log(S.k, `🕯 chart history: ${existing.size} M1 candles${backfilled ? ` · ${backfilled} generated demo candles backfilled` : ''}`);
}

/* ---------- broker + robot ---------- */
const getQuote = sym => SY[sym].eng.quote();
const broker = createBroker({ defs: SYM_DEFS, getQuote, file: path.join(CONFIG.historyDir, '.broker', 'account.json') });
const robot = createRobot({ broker, symbols: SYMBOLS, defs: SYM_DEFS, getQuote, weekendClosed: CONFIG.weekendClosed,
  getCandles: (s, tf, from, to) => queryCandles(SY[s], tf, from, to), store: { get: () => cfg.robot, set: v => { cfg.robot = v; saveCfg() } } });

/* ---------- streams: 3 xog x suuq kasta (mid walba gooni: folder, journal, outbox, queue) ---------- */
const streams = {};
for (const k of SYMBOLS) for (const dk of DSK) {
  const ds = DS[dk], s = { ds, name: ds.name, sym: k, queue: [], persistedQueueCount: 0, sending: false, count: 0, sent: 0, fail: 0, files: 0, lastError: '', csvError: '', lastWrite: '', xlsxAt: '', xlsxError: '', cur: null, rows: [], recent: [] };
  streams[ds.name + ':' + k] = s; prep(s); fs.mkdirSync(path.dirname(outboxOf(s)), { recursive: true });
  if (fs.existsSync(outboxOf(s))) { s.queue = readLines(outboxOf(s)); s.persistedQueueCount = s.queue.length; if (s.queue.length) log(s.name + ':' + k, `♻ ${s.queue.length} rows oo saf ugu jiray DB-ga ayaa dib loo soo qaaday`) }
  const curName = baseName(s, blockOf(new Date()));
  for (const f of fs.readdirSync(jdirOf(s)).filter(f => f.endsWith('.ndjson') && f !== curName + '.ndjson')) finalizeJournal(s, path.join(jdirOf(s), f));
}
for (const k of SYMBOLS) warmup(SY[k]);

function ensureBlock(s, now) {
  if (s.cur && now < s.cur.end) return;
  if (s.cur) finalizeJournal(s, s.cur.journal);
  prep(s); const b = blockOf(now), name = baseName(s, b);
  const on = outName(s, b.start, b.end);
  s.cur = { ...b, journal: path.join(jdirOf(s), name + '.ndjson'), csv: path.join(dirOf(s), on + '_LIVE.csv'), xlsx: path.join(dirOf(s), on + '.xlsx') };
  try { s.rows = fs.existsSync(s.cur.journal) ? readLines(s.cur.journal) : [] } catch (e) { s.rows = [] }
}
const csvCell = v => { v = String(v); return /[",\r\n]|^\s|\s$/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v };
const MAX_CANDLES = 5000;
function push(s, rows, now) {
  rows.forEach((row, index) => { row._eventTime = now.toISOString(); row._sequence = index });
  const text = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  for (const [field, label, file] of [
    ['outboxWriteError', 'DB outbox', outboxOf(s)],
    ['journalWriteError', 'history journal', s.cur.journal],
  ]) {
    try {
      appendFileWithRetry(file, text);
      if (s[field]) log(s.name + ':' + s.sym, `${label} write recovered`);
      s[field] = '';
    } catch (e) {
      if (s[field] !== e.message) log(s.name + ':' + s.sym, `✖ ${label} write failed after retries: ${e.message}`);
      s[field] = e.message;
      s.lastError = e.message;
    }
  }
  try {                                                                                // 3) folder-ka la doortay: ILBIRIQSI KASTA (CSV, wuxuu ku furmaa Excel)
    if (!fs.existsSync(s.cur.csv)) fs.writeFileSync(s.cur.csv, '\ufeff' + s.ds.cols.join(',') + '\n');
    fs.appendFileSync(s.cur.csv, rows.map(r => s.ds.cols.map(c => csvCell(r[c])).join(',')).join('\n') + '\n'); s.lastWrite = fmtT(new Date()); s.csvError = '';
  } catch (e) { s.csvError = e.message }                                               // tusaale: Excel ayaa faylka xidhay -> journal-ka waa badbaado
  s.rows.push(...rows); s.queue.push(...rows); s.count += rows.length; s.recent.push(...rows); if (s.recent.length > 30) s.recent = s.recent.slice(-30);
}
async function send(s) {
  if (!database || !dbStatus.historySynced || s.sending || !s.queue.length || Date.now() < (s.retryAt || 0)) return; s.sending = true;
  try {
    while (s.queue.length) {
      const batch = s.queue.slice(0, CONFIG.batchSize);
      await database.insert(s.name, s.sym, batch, s.cur && s.cur.start);
      s.queue.splice(0, batch.length); s.sent += batch.length; s.lastError = ''; s.retryAt = 0;
      s.persistedQueueCount = Math.max(0, s.persistedQueueCount - batch.length);
      dbStatus.connected = true; dbStatus.error = '';
      fs.writeFileSync(outboxOf(s), s.queue.map(r => JSON.stringify(r)).join('\n') + (s.queue.length ? '\n' : ''));
    }
  } catch (e) {
    s.fail++; s.retryAt = Date.now() + 5000; dbStatus.connected = false; dbStatus.error = e.message;
    if (s.lastError !== e.message) log(s.name + ':' + s.sym, `✖ PostgreSQL: ${e.message}`);
    s.lastError = e.message;
  }
  s.sending = false;
}

/* ---------- Excel live: block-ka hadda socda waxaa la cusboonaysiiyaa (hal stream mar kasta, si ticks-ku u sii socdaan) ---------- */
let snapIdx = 0, lastSnap = 0;
function snapshotNext(nowMs) {
  const list = Object.values(streams); if (!CONFIG.liveXlsx || nowMs - lastSnap < CONFIG.liveXlsx * 1000 / list.length) return; lastSnap = nowMs;
  for (let i = 0; i < list.length; i++) { const s = list[(snapIdx++) % list.length]; if (!s.cur || !s.rows.length) continue;
    try { XLSX.writeFile(buildWorkbook(s.ds, s.rows), s.cur.xlsx + '.tmp', { bookType: 'xlsx' }); fs.renameSync(s.cur.xlsx + '.tmp', s.cur.xlsx); s.xlsxAt = fmtT(new Date()); s.xlsxError = '' }
    catch (e) { s.xlsxError = e.message } return }                                       // tusaale: Excel ayaa faylka xidhay -> mar dambe ayaa la isku dayayaa
}
/* ---------- ticker: ilbiriqsi kasta ---------- */
let timer = null, saveTimer = null;
function mainTick() {
  const now = new Date(), mk = M.market(now, CONFIG.weekendClosed);
  for (const k of SYMBOLS) {
    const S = SY[k], out = { TAQ: [], TAS: [], GCV: [] };
    if (!mk.closed) {
      const n = poisson(CONFIG.quoteRate * CONFIG.rateScale * mk.factor);
      for (let i = 0; i < n; i++) {
        const q = S.eng.step(mk.factor);
        out.TAQ.push(DS.taq.gen(S, now, q)); candleAdd(S, now, q.bid, 1); dayStat(S, now, q.bid); broker.onQuote(k, q);
        if (Math.random() < 0.18) out.TAS.push(DS.tas.gen(S, now, q));
        if (Math.random() < 0.09) out.GCV.push(DS.gcv.gen(S, now, q));
      }
      if (n) { S.lastTime = fmtDT(now); fs.writeFileSync(path.join(cdirOf(k), '.open.json'), JSON.stringify(S.c1)) }
    }
    for (const dk of DSK) { const s = streams[DS[dk].name + ':' + k]; ensureBlock(s, now); if (out[s.name].length) push(s, out[s.name], now); send(s) }
  }
  broker.onSecond(); robot.onSecond(now.getTime()); snapshotNext(now.getTime());
}
const startAll = () => { if (timer) return; timer = setInterval(mainTick, 1000); saveTimer = setInterval(saveState, 5000); log('ALL', '▶ live') };
const stopAll = () => { clearInterval(timer); clearInterval(saveTimer); timer = saveTimer = null; saveState(); log('ALL', '■ joojiyay') };

/* ---------- folders: dooro / hubi / codso ---------- */
function applyFolders(map) {
  const done = {};
  for (const name of DSN) {
    if (map[name] === undefined) continue; const raw = String(map[name] || '').trim();
    if (!raw) { delete cfg.folders[name]; done[name] = rootOf(name); continue }
    const p = path.resolve(raw); fs.mkdirSync(p, { recursive: true });
    const probe = path.join(p, '.write_test'); fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);           // hubi in la qori karo
    cfg.folders[name] = p; done[name] = p;
  }
  cfg.setupDone = true; saveCfg();
  for (const s of Object.values(streams)) if (map[s.name] !== undefined && s.cur) { finalizeJournal(s, s.cur.journal); s.cur = null }   // block-ka hadda socda wuxuu ku dhammaadaa folder-kii hore
  return done;
}
function listDir(p) {
  if (!p) { if (process.platform === 'win32') { const d = []; for (let i = 65; i <= 90; i++) { const l = String.fromCharCode(i) + ':\\'; if (fs.existsSync(l)) d.push(l) } return { path: '', parent: null, dirs: d } } p = os.homedir() }
  p = path.resolve(p); const dirs = fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('$')).map(d => d.name).sort((a, b) => a.localeCompare(b));
  const par = path.dirname(p); return { path: p, parent: par !== p ? par : (process.platform === 'win32' ? '' : null), dirs };
}

/* ---------- history (TAQ / TAS / GCV oo dhan) ---------- */
const BLK = /^(TAQ|TAS|GCV)_([A-Z]+)_(\d{2})([A-Za-z]{3})(\d{4})_(\d{2})(\d{2})_to_(\d{2})(\d{2})/;
function parseBlock(name) { const m = BLK.exec(name); if (!m) return null;
  const start = new Date(+m[5], MON.indexOf(m[4]), +m[3], +m[6], +m[7], 0, 0).getTime(); let mins = (+m[8] * 60 + +m[9]) - (+m[6] * 60 + +m[7]); if (mins <= 0) mins += 1440;
  return { start, end: start + mins * 60000 } }
function listBlocks(s) {
  const out = new Map();
  for (const [dir, ext, gz] of [[adirOf(s), '.ndjson.gz', true], [jdirOf(s), '.ndjson', false]]) {
    let files = []; try { files = fs.readdirSync(dir) } catch (e) {}
    for (const f of files.filter(f => f.endsWith(ext))) { const name = f.slice(0, -ext.length), b = parseBlock(name); if (b) out.set(name, { name, file: path.join(dir, f), gz, ...b }) }
  }
  return [...out.values()].sort((a, b) => a.start - b.start);
}
const readBlock = b => readHistoryBlock(b, message => log('History', message));
function rowTime(row, b) {
  if (row.Timestamp) return Date.parse(row.Timestamp.replace(' ', 'T'));
  const m = /^(\d+):(\d+):(\d+)/.exec(row['TIMEACT NS']); const d = new Date(b.start); d.setHours(+m[1], +m[2], +m[3], 0); return d.getTime();
}
function queryHistory(s, from, to, offset, limit) {
  let total = 0, first = null, last = null; const rows = [];
  for (const b of listBlocks(s)) {
    if (b.end <= from || b.start >= to) continue;
    for (const r of readBlock(b)) { const t = rowTime(r, b); if (t < from || t >= to) continue;
      total++; if (first === null) first = t; last = t; if (total > offset && rows.length < limit) rows.push(s.ds.cols.map(c => r[c])) }
  }
  return { cols: s.ds.cols, rows, total, first: first === null ? null : fmtDT(new Date(first)), last: last === null ? null : fmtDT(new Date(last)) };
}
const histIndex = () => Object.fromEntries(DSN.map(n => [n, Object.fromEntries(SYMBOLS.map(k => { const bl = listBlocks(streams[n + ':' + k]);
  return [k, { blocks: bl.length, dates: [...new Set(bl.map(b => dayKey(b.start)))] }] }))]));
const publicHistoryBlocks = (s, date) => listBlocks(s)
  .filter(block => !date || dayKey(block.start) === date)
  .map(block => ({ start: fmtDT(new Date(block.start)), end: fmtDT(new Date(block.end)), live: !block.gz }));

/* Blocks already imported are tracked by size+mtime; only new/changed blocks are read (inserts stay deduped by the DB). */
const IMPORT_MARK = path.join(CONFIG.historyDir, '.broker', 'db-import.json');
let importRunning = false;
async function importHistoryInBackground() {
  if (!database || importRunning) return; importRunning = true;
  let marks = {}; try { marks = JSON.parse(fs.readFileSync(IMPORT_MARK, 'utf8')) } catch (e) {}
  const saveMarks = () => { try { fs.mkdirSync(path.dirname(IMPORT_MARK), { recursive: true }); fs.writeFileSync(IMPORT_MARK + '.tmp', JSON.stringify(marks)); fs.renameSync(IMPORT_MARK + '.tmp', IMPORT_MARK) } catch (e) {} };
  let imported = 0, files = 0, skipped = 0, unreadable = 0, failed = false;
  try {
    for (const s of Object.values(streams)) {
      for (const block of listBlocks(s)) {
        let sig; try { const st = fs.statSync(block.file); sig = st.size + ':' + Math.floor(st.mtimeMs) } catch (e) { continue }
        if (marks[block.file] === sig) { skipped++; continue }
        const errorKey = `__unreadable__:${block.file}`;
        if (marks[errorKey] === sig) { unreadable++; continue }
        let rows;
        try {
          rows = readBlock(block);
        } catch (e) {
          marks[errorKey] = sig;
          unreadable++;
          log('DB', `⚠ History block kept for recovery (${path.basename(block.file)}): ${e.message}`);
          saveMarks();
          continue;
        }
        for (let offset = 0; offset < rows.length; offset += CONFIG.batchSize) {
          imported += await database.insert(s.name, s.sym, rows.slice(offset, offset + CONFIG.batchSize), block.start);
        }
        marks[block.file] = sig; delete marks[errorKey]; files++; if (files % 25 === 0) saveMarks();
        await new Promise(r => setImmediate(r));
      }
    }
  } catch (e) { failed = true; log('DB', `✖ background history import failed: ${e.message}`); setTimeout(importHistoryInBackground, 15000) }
  saveMarks(); dbStatus.importedRows += imported; importRunning = false;
  if (!failed) log('DB', `History import complete · ${files} blocks imported · ${skipped} already imported · ${imported} rows added · ${unreadable} unreadable blocks retained`);
}

let dbBootstrapRunning = false;
async function syncHistoryToDatabase() {
  if (!database || dbBootstrapRunning || dbStatus.historySynced) return;
  dbBootstrapRunning = true;
  try {
    const { timescale } = await database.initialize();
    dbStatus.connected = true; dbStatus.timescale = timescale; dbStatus.error = '';
    log('DB', `PostgreSQL connected · ${timescale ? 'TimescaleDB hypertable' : 'PostgreSQL table'}`);
    dbStatus.historySynced = true;
    dbStatus.error = '';
    for (const s of Object.values(streams)) {
      if (!s.persistedQueueCount) continue;
      s.queue.splice(0, s.persistedQueueCount);
      s.persistedQueueCount = 0;
      fs.writeFileSync(outboxOf(s), s.queue.map(row => JSON.stringify(row)).join('\n') + (s.queue.length ? '\n' : ''));
    }
    log('DB', 'PostgreSQL ready · history import running in background');
    for (const s of Object.values(streams)) send(s);
    importHistoryInBackground();
  } catch (e) {
    dbStatus.connected = false; dbStatus.historySynced = false; dbStatus.error = e.message;
    log('DB', `✖ PostgreSQL/history sync failed: ${e.message}`);
    setTimeout(syncHistoryToDatabase, 15000);
  } finally {
    dbBootstrapRunning = false;
  }
}

/* ---------- API + frontend ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const json = (s, o, code) => { if (code) s.statusCode = code; s.setHeader('Content-Type', 'application/json'); s.setHeader('Cache-Control', 'no-store'); s.end(JSON.stringify(o)) };
const historyFailure = (s, error) => {
  log('HISTORY', `Market history request failed: ${error.message}`);
  return json(s, { error: 'Market history is temporarily unavailable.' }, 503);
};
const readBody = q => new Promise(res => { let b = ''; q.on('data', c => { b += c; if (b.length > 1e6) q.destroy() }); q.on('end', () => { try { res(JSON.parse(b || '{}')) } catch (e) { res({}) } }) });
const PUBLIC_READS = new Set([
  '/prices', '/market', '/candles', '/public/status', '/public/recent',
  '/history/index', '/history/at', '/history/query', '/public/history/blocks'
]);
const PUBLIC_ASSETS = new Set(['/', '/index.html', '/data.html', '/history.html', '/common.js', '/folders.js', '/trader.js', '/data.js', '/history.js', '/ui.css', '/trader.css']);
const digest = value => crypto.createHash('sha256').update(String(value)).digest();
const secretMatches = (left, right) => crypto.timingSafeEqual(digest(left), digest(right));
function terminalSession(q) {
  const cookie = q.headers.cookie || '';
  for (const field of cookie.split(';')) {
    const separator = field.indexOf('=');
    if (separator < 0 || field.slice(0, separator).trim() !== API_SESSION_COOKIE) continue;
    const id = field.slice(separator + 1).trim(), session = apiSessions.get(id);
    if (!session || session.expiresAt <= Date.now()) { apiSessions.delete(id); return false }
    return true;
  }
  return false;
}
function authorized(q) {
  if (!API_TOKEN) return false;
  const authorization = q.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return Boolean(match && secretMatches(match[1], API_TOKEN)) || terminalSession(q);
}
function apiCookie(value, maxAge) {
  return `${API_SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${API_COOKIE_SECURE ? '; Secure' : ''}`;
}
function originMatches(q) {
  if (!q.headers.origin || !q.headers.host) return false;
  try {
    const origin = new URL(q.headers.origin);
    return origin.host.toLowerCase() === q.headers.host.toLowerCase()
      && (origin.protocol === 'http:' || origin.protocol === 'https:');
  } catch { return false }
}
function allowApiLogin(address) {
  const now = Date.now(), attempts = (apiLoginAttempts.get(address) || []).filter(at => now - at < API_LOGIN_WINDOW_MS);
  apiLoginAttempts.set(address, attempts);
  return attempts.length < API_LOGIN_MAX_ATTEMPTS;
}
function denyApiAccess(s) {
  s.setHeader('WWW-Authenticate', 'Bearer realm="ITR Terminal"');
  return json(s, { error: 'Authentication is required for this endpoint.' }, 401);
}
const prices = () => Object.fromEntries(SYMBOLS.map(k => { const S = SY[k], q = S.eng.quote(), d = S.day || { open: q.bid, high: q.bid, low: q.bid };
  return [k, { label: S.def.label, dig: S.def.dig, bid: q.bid, ask: q.ask, spread: S.eng.sp, dir: q.dir, open: d.open, high: d.high, low: d.low, size: S.def.size, time: S.lastTime }] }));
const publicStatus = () => ({
  connected: Boolean(database && dbStatus.connected && dbStatus.historySynced),
  marketRunning: Boolean(timer),
  feeds: DSN.map(ds => {
    const latest = SYMBOLS.map(sym => streams[ds + ':' + sym].recent.at(-1))
      .filter(Boolean).map(row => row._eventTime).sort().pop() || null;
    const age = latest ? Date.now() - Date.parse(latest) : Infinity;
    return {
      ds,
      freshness: !timer ? 'paused' : age <= 10000 ? 'fresh' : latest ? 'stale' : 'waiting',
      updatedAt: latest
    };
  })
});
const statusAll = () => ({ running: !!timer, symbols: SYMBOLS, datasets: DSN, streams: Object.values(streams).map(s => ({ ds: s.name, sym: s.sym, section: s.ds.section, generated: s.count, sent: s.sent, failed: s.fail,
  queued: s.queue.length, files: s.files, block: s.cur ? baseName(s, s.cur) : '-', lastWrite: s.lastWrite, csvError: s.csvError, xlsxAt: s.xlsxAt, xlsxError: s.xlsxError, lastError: s.lastError, folder: dirOf(s) })), database: dbStatus });
const cfgView = () => ({ setupDone: !!cfg.setupDone, folders: Object.fromEntries(DSN.map(n => [n, { path: rootOf(n), custom: !!cfg.folders[n] }])), platform: process.platform, keepCsv: CONFIG.keepCsv, blockMinutes: CONFIG.blockMinutes });
const listFiles = () => Object.fromEntries(DSN.map(n => [n, Object.fromEntries(SYMBOLS.map(k => { const dir = dirOf(streams[n + ':' + k]); let fl = []; try { fl = fs.readdirSync(dir) } catch (e) {}
  return [k, fl.filter(f => f.endsWith('.xlsx') || f.endsWith('_LIVE.csv')).map(f => { const st = fs.statSync(path.join(dir, f)); return { name: f, size: st.size, time: st.mtime } }).sort((x, y) => y.time - x.time)] }))]));
const pt = x => (/^\d+$/.test(x) ? +x : Date.parse(x));
const stream = (ds, sym) => streams[String(ds || '').toUpperCase() + ':' + String(sym || '').toUpperCase()];

http.createServer(async (q, s) => {
  try {
    s.setHeader('Cache-Control', 'no-store');
    const url = new URL(q.url, 'http://x'), u = decodeURIComponent(url.pathname), p = url.searchParams, post = q.method === 'POST';
    const address = q.socket.remoteAddress || 'unknown';
    if (q.method === 'GET' && u === '/auth/session') return json(s, { authenticated: terminalSession(q), configured: Boolean(API_TOKEN) });
    if (post && u === '/auth/login') {
      if (!originMatches(q)) return json(s, { error: 'Request origin was not accepted.' }, 403);
      if ((q.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        return json(s, { error: 'Content-Type must be application/json.' }, 415);
      }
      if (!API_TOKEN) return json(s, { error: 'Set API_TOKEN on the terminal server before signing in.' }, 503);
      if (!allowApiLogin(address)) return json(s, { error: 'Too many sign-in attempts. Wait 15 minutes and try again.' }, 429);
      apiLoginAttempts.get(address).push(Date.now());
      const body = await readBody(q);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(s, { error: 'Request must contain a JSON object.' }, 400);
      if (!secretMatches(body.token || '', API_TOKEN)) return json(s, { error: 'Access credential is incorrect.' }, 401);
      apiLoginAttempts.delete(address);
      for (const [id, session] of apiSessions) if (session.expiresAt <= Date.now()) apiSessions.delete(id);
      const id = crypto.randomBytes(32).toString('base64url');
      apiSessions.set(id, { expiresAt: Date.now() + API_SESSION_TTL_MS });
      s.setHeader('Set-Cookie', apiCookie(id, Math.floor(API_SESSION_TTL_MS / 1000)));
      return json(s, { authenticated: true });
    }
    if (post && u === '/auth/logout') {
      if (!authorized(q)) return denyApiAccess(s);
      const cookie = q.headers.cookie || '';
      for (const field of cookie.split(';')) {
        const separator = field.indexOf('=');
        if (separator >= 0 && field.slice(0, separator).trim() === API_SESSION_COOKIE) apiSessions.delete(field.slice(separator + 1).trim());
      }
      s.setHeader('Set-Cookie', apiCookie('', 0));
      return json(s, { authenticated: false });
    }
    const publicGet = q.method === 'GET' && (PUBLIC_ASSETS.has(u)
      || PUBLIC_READS.has(u) && !(u === '/history/query' && p.get('format') === 'csv'));
    if (!publicGet && !authorized(q)) return denyApiAccess(s);
    if (q.method !== 'GET' && !post) return json(s, { error: 'Method not allowed.' }, 405);
    const body = post ? await readBody(q) : {};
    if (post) {
      if (u === '/start') { startAll(); return s.end('ok') } if (u === '/stop') { stopAll(); return s.end('ok') }
      if (u === '/order') return json(s, broker.place({ ...body, sym: String(body.symbol || body.sym || '').toUpperCase(), magic: 'MANUAL' }));
      if (u === '/close') return json(s, broker.close(body.id, 'MANUAL', body.lots));
      if (u === '/closeall') return json(s, (broker.closeAll(body.magic || null, 'MANUAL'), { ok: true }));
      if (u === '/modify') return json(s, broker.modify(body.id, body));
      if (u === '/cancel') return json(s, broker.cancelOrder(body.id));
      if (u === '/account/reset') return json(s, (broker.reset(+body.balance || 10000), { ok: true }));
      if (u === '/robot/config') return json(s, (robot.setConfig(body), robot.status()));
      if (u === '/config/setup-done') { cfg.setupDone = true; saveCfg(); return json(s, cfgView()) }
      if (u === '/config/folders') { try { applyFolders(body); return json(s, cfgView()) } catch (e) { return json(s, { error: e.message }, 400) } }
    }
    if (q.method !== 'GET') return json(s, { error: 'Method not allowed.' }, 405);
    if (u === '/status') return json(s, statusAll());
    if (u === '/public/status') return json(s, publicStatus());
    if (u === '/public/recent') {
      const st = stream(p.get('ds'), p.get('symbol'));
      if (!st) return json(s, { error: 'ds + symbol' }, 400);
      const rows = st.recent.slice(-30).reverse().map(row => Object.fromEntries(st.ds.cols.map(column => [column, row[column]])));
      return json(s, { ds: st.name, symbol: st.sym, cols: st.ds.cols, rows });
    }
    if (u === '/db/status') return json(s, { ...dbStatus, table: 'public.itr_market_ticks' });
    if (u === '/prices') return json(s, prices());
    if (u === '/market') return json(s, M.market(new Date(), CONFIG.weekendClosed));
    if (u === '/files') return json(s, listFiles());
    if (u === '/config') return json(s, cfgView());
    if (u === '/fs/list') { try { return json(s, listDir(p.get('path') || '')) } catch (e) { return json(s, { error: e.message }, 400) } }
    if (u === '/account') return json(s, { ...broker.snapshot(), positions: broker.view(), orders: broker.orders(), stats: broker.stats(), pnlToday: +broker.pnlToday().toFixed(2), maxDdPct: +broker.maxDdPct().toFixed(2) });
    if (u === '/trades') return json(s, broker.closedList(+p.get('limit') || 200));
    if (u === '/curve') return json(s, broker.curve());
    if (u === '/robot') return json(s, { ...robot.status(), config: robot.config(), defaults: robot.DEFAULTS });
    if (u === '/recent') { const st = stream(p.get('ds'), p.get('symbol')); if (!st) return json(s, { error: 'ds + symbol' }, 400); return json(s, { cols: st.ds.cols, rows: st.recent.slice().reverse() }) }
    if (u === '/public/history/blocks') {
      const st = stream(p.get('ds'), p.get('symbol'));
      if (!st) return json(s, { error: 'ds + symbol' }, 400);
      return json(s, publicHistoryBlocks(st, p.get('date')));
    }
    if (u === '/history/index') {
      try {
        return json(s, dbStatus.historySynced
          ? await database.historyIndex(SYMBOLS, CONFIG.localTimezone)
          : histIndex());
      } catch (error) { return historyFailure(s, error) }
    }
    if (u === '/history/blocks') {                                      // ?ds=TAQ&symbol=EURUSD&date=YYYY-MM-DD
      const st = stream(p.get('ds'), p.get('symbol')); if (!st) return json(s, { error: 'ds + symbol' }, 400);
      return json(s, listBlocks(st).filter(b => !p.get('date') || dayKey(b.start) === p.get('date')).map(b => ({ name: b.name, start: fmtDT(new Date(b.start)), end: fmtDT(new Date(b.end)), live: !b.gz, size: fs.statSync(b.file).size, xlsx: fs.existsSync(path.join(dirOf(st), outName(st, b.start, b.end) + '.xlsx')) ? outName(st, b.start, b.end) + '.xlsx' : null })));
    }
    if (u === '/history/at') {                                          // ?time=<epoch|YYYY-MM-DDTHH:MM:SS>  -> rate-ka suuq kasta waqtigaas (quote-kii u dambeeyay <= time)
      try {
        const requestedTime = p.get('time'), t = requestedTime ? pt(requestedTime) : Date.now(), out = {};
        if (!Number.isFinite(t)) return json(s, { error: 'time ma saxna' }, 400);
        if (dbStatus.historySynced) {
          const quotes = await database.latestQuotesAt(new Date(t), SYMBOLS);
          for (const k of SYMBOLS) {
            const quote = quotes[k];
            out[k] = quote ? { time: fmtDT(new Date(quote.time)), bid: quote.bid, ask: quote.ask, dir: quote.dir, label: SYM_DEFS[k].label, dig: SYM_DEFS[k].dig } : null;
          }
          return json(s, { time: fmtDT(new Date(t)), source: 'postgresql', rates: out });
        }
        for (const k of SYMBOLS) { const st = streams['TAQ:' + k]; out[k] = null;
          for (const b of listBlocks(st).filter(x => x.start <= t).reverse().slice(0, 3)) { let hit = null;
            for (const r of readBlock(b)) { if (rowTime(r, b) <= t) hit = r; else break }
            if (hit) { out[k] = { time: hit.Timestamp, bid: hit.BID, ask: hit.ASK, dir: hit.PRCTCK_1, label: SYM_DEFS[k].label, dig: SYM_DEFS[k].dig }; break } } }
        return json(s, { time: fmtDT(new Date(t)), source: 'local-history', rates: out });
      } catch (error) { return historyFailure(s, error) }
    }
    if (u === '/history/query') {                                       // ?ds&symbol&from&to&offset&limit&format=csv
      try {
        const st = stream(p.get('ds'), p.get('symbol')); if (!st) return json(s, { error: 'ds + symbol' }, 400);
        const from = p.has('from') ? pt(p.get('from')) : 0, to = p.has('to') ? pt(p.get('to')) : Date.now() + 86400e3;
        const csv = p.get('format') === 'csv';
        const offset = p.has('offset') ? Number(p.get('offset')) : 0;
        const requestedLimit = p.has('limit') ? Number(p.get('limit')) : 200;
        if (!Number.isFinite(from) || !Number.isFinite(to) || !(from < to)
          || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000
          || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
          return json(s, { error: 'from/to/offset/limit ma saxna' }, 400);
        }
        const limit = Math.min(requestedLimit, 2000);
        let r, source;
        if (dbStatus.historySynced) {
          const result = await database.queryHistory(st.name, st.sym, new Date(from), new Date(to), csv ? 0 : offset, csv ? 1e6 : limit);
          r = { cols: st.ds.cols, rows: result.rows.map(row => st.ds.cols.map(column => row[column])), total: result.total,
            first: result.first ? fmtDT(new Date(result.first)) : null, last: result.last ? fmtDT(new Date(result.last)) : null };
          source = 'postgresql';
        } else {
          r = queryHistory(st, from, to, csv ? 0 : offset, csv ? 1e6 : limit);
          source = 'local-history';
        }
        if (csv) { const esc = v => { v = String(v); return /[",\n]|^\s|\s$/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v };
          s.setHeader('Content-Type', 'text/csv; charset=utf-8'); s.setHeader('Content-Disposition', `attachment; filename="${st.name}_${st.sym}_history.csv"`);
          return s.end('\ufeff' + r.cols.join(',') + '\n' + r.rows.map(x => x.map(esc).join(',')).join('\n')) }
        return json(s, { ...r, source });
      } catch (error) { return historyFailure(s, error) }
    }
    if (u === '/candles') {                                             // ?symbol&tf&limit | &from&to | &format=csv
      const S = SY[(p.get('symbol') || '').toUpperCase()], tf = (p.get('tf') || 'M1').toUpperCase();
      if (!S || !TF[tf]) return json(s, { error: 'symbol=' + SYMBOLS.join('|') + ' tf=' + Object.keys(TF).join('|') }, 400);
      const timezone = p.get('timezone') || CONFIG.localTimezone;
      try {
        if (timezone.length > 100) throw new RangeError('Timezone name is too long');
        new Intl.DateTimeFormat('en', { timeZone: timezone });
      } catch (e) { return json(s, { error: `timezone aan sax ahayn: ${timezone}` }, 400) }
      const fromDate = p.get('fromDate'), toDate = p.get('toDate'), lim = +p.get('limit') || 0;
      let from, to;
      if (fromDate || toDate) {
        const start = timezoneDayStart(fromDate, timezone), end = timezoneDayStart(toDate, timezone);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return json(s, { error: 'fromDate/toDate waa inay noqdaan taariikho sax ah (YYYY-MM-DD)' }, 400);
        const endExclusive = new Date(end); endExclusive.setDate(endExclusive.getDate() + 1);
        from = start; to = endExclusive.getTime();
      } else {
        to = p.get('to') ? pt(p.get('to')) : Date.now() + 60000;
        from = p.get('from') ? pt(p.get('from')) : to - (lim || 150) * TF[tf] * 60000;
      }
      if (!Number.isFinite(from) || !Number.isFinite(to) || !(from < to)) return json(s, { error: 'from/to ma saxna' }, 400);
      const requestedLimit = Math.max(1, Math.min(MAX_CANDLES, lim || MAX_CANDLES));
      let c, total = 0, source = 'local-history';
      if (dbStatus.historySynced) {
        const result = await database.queryCandles('TAQ', S.k, new Date(from), new Date(to), timezone, TF[tf], requestedLimit);
        c = result.rows;
        total = result.total;
        source = 'postgresql';
      }
      if (!c || !c.length) {
        c = queryCandles(S, tf, from, to, timezone);
        total = c.length;
        source = 'local-history';
        if (c.length > requestedLimit) c = c.slice(-requestedLimit);
      }
      if (lim && !p.get('from')) c = c.slice(-requestedLimit);
      c = c.map(x => ({ ...x, time: cTimeInTimezone(x.t, timezone) }));
      const truncated = total > c.length;
      if (p.get('format') === 'csv') { s.setHeader('Content-Type', 'text/csv'); s.setHeader('Content-Disposition', `attachment; filename="${S.k}_${tf}.csv"`);
        return s.end('time,open,high,low,close,volume,ticks\n' + c.map(x => [x.time, x.o, x.h, x.l, x.c, x.v, x.n].join(',')).join('\n')) }
      return json(s, { symbol: S.k, tf, digits: S.def.dig, timezone, from: cTimeInTimezone(from, timezone), to: cTimeInTimezone(to, timezone),
        count: c.length, total, truncated, maxCandles: MAX_CANDLES, source, candles: c });
    }
    if (u.startsWith('/export/')) {                                     // /export/TAQ/EURUSD?format=xlsx|csv -> block-ka hadda socda
      const [, , dsn, sym] = u.split('/'), st = stream(dsn, sym), fmt = p.get('format') || 'xlsx';
      if (!st || !st.cur || !fs.existsSync(st.cur.journal)) { s.statusCode = 404; return s.end('weli xog ma jirto') }
      const rows = readLines(st.cur.journal), nm = `${baseName(st, st.cur)}_live_${hhmm(new Date())}`;
      if (fmt === 'csv') { s.setHeader('Content-Type', 'text/csv; charset=utf-8'); s.setHeader('Content-Disposition', `attachment; filename="${nm}.csv"`);
        return s.end('\ufeff' + st.ds.cols.join(',') + '\n' + rows.slice().reverse().map(r => st.ds.cols.map(c => csvCell(r[c])).join(',')).join('\n')) }
      s.setHeader('Content-Type', MIME['.xlsx']); s.setHeader('Content-Disposition', `attachment; filename="${nm}.xlsx"`);
      return s.end(XLSX.write(buildWorkbook(st.ds, rows), { type: 'buffer', bookType: 'xlsx' }));
    }
    let file;
    if (u.startsWith('/download/')) {                                   // /download/TAQ/EURUSD/<file>
      const [, , dsn, sym, f] = u.split('/'), st = stream(dsn, sym);
      if (!st || !f || f !== path.basename(f)) { s.statusCode = 400; return s.end('bad request') }
      file = path.join(dirOf(st), f); s.setHeader('Content-Disposition', `attachment; filename="${f}"`);
    } else {
      if (!PUBLIC_ASSETS.has(u)) { s.statusCode = 404; return s.end('not found') }
      file = path.join(BASE, 'frontend', 'public', u === '/' ? 'index.html' : path.basename(u));
    }
    fs.readFile(file, (e, buf) => { if (e) { s.statusCode = 404; return s.end('not found') }
      s.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream'); s.end(buf) });
  } catch (e) { json(s, { error: e.message }, 500) }
}).listen(CONFIG.statusPort, CONFIG.host, () => {
  const url = `http://localhost:${CONFIG.statusPort}`;
  console.log(`\n====================================================\n ITR FOREX TERMINAL waa socdaa  ->  ${url}\n History: ${url}/history.html   Feed: ${url}/data.html\n Database: ${DB_CONFIGURED ? 'PostgreSQL / TimescaleDB' : 'aan weli la dejin — eeg .env.example'}\n Folders (xogta ilbiriqsi kasta halkan ayay ku dhacaysaa):\n${DSN.map(n => '   ' + n + '  ->  ' + rootOf(n)).join('\n')}\n====================================================\n`);
  if (CONFIG.openBrowser && (process.platform === 'win32' || process.platform === 'darwin')) require('child_process').exec(process.platform === 'win32' ? `start "" ${url}` : `open ${url}`);
  if (database) syncHistoryToDatabase().finally(startAll);
  else { dbStatus.error = 'PostgreSQL lama dejin. Samee .env adigoo ka bilaabaya .env.example.'; log('DB', `✖ ${dbStatus.error}`); startAll() }
}).on('error', e => { console.error(e.code === 'EADDRINUSE' ? `\nPort ${CONFIG.statusPort} waa la isticmaalayaa — barnaamijka hore xidh (ama STATUS_PORT=4200)\n` : e.message); process.exit(1) });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { stopAll(); await Promise.all(Object.values(streams).map(send)); if (database) await database.close(); process.exit(0) });
