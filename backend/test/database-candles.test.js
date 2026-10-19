'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDatabase } = require('../database');

test('database candle query uses the requested dataset, range, timezone, timeframe and limit', async () => {
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('pg_extension')) return { rows: [{ available: false }] };
      if (sql.includes('SELECT EXISTS (SELECT 1 FROM itr_market_candles_m1')) return { rows: [{ available: true }] };
      if (sql.includes('WITH localized AS')) return {
        rows: [{
          t: new Date('2026-06-14T04:00:00.000Z'),
          o: '1.1', h: '1.2', l: '1.0', c: '1.15', v: 4, n: 4, total: '1'
        }]
      };
      return { rows: [], rowCount: 0 };
    },
    async end() {}
  };
  const database = createDatabase({}, pool);
  const from = new Date('2026-06-14T04:00:00.000Z');
  const to = new Date('2026-06-15T04:00:00.000Z');
  const result = await database.queryCandles('TAQ', 'EURUSD', from, to, 'America/New_York', 1440, 5000);

  assert.deepEqual(result, {
    rows: [{ t: from.getTime(), o: 1.1, h: 1.2, l: 1, c: 1.15, v: 4, n: 4 }],
    total: 1
  });
  const query = calls.find(call => call.sql.includes('WITH localized AS'));
  assert.deepEqual(query.params, ['TAQ', 'EURUSD', from, to, 'America/New_York', 1440, 5000]);
  assert.match(query.sql, /minute_time AT TIME ZONE \$5/);
  assert.match(query.sql, /date_trunc\('day', minute_time AT TIME ZONE \$5\)/);
  assert.match(query.sql, /minute_time >= \$3 AND minute_time < \$4/);
  assert.match(query.sql, /ORDER BY t DESC LIMIT \$7/);
  await database.close();
});

test('database candle query reports an empty result without a total row', async () => {
  const pool = {
    async query(sql) {
      if (sql.includes('pg_extension')) return { rows: [{ available: false }] };
      if (sql.includes('SELECT EXISTS (SELECT 1 FROM itr_market_candles_m1')) return { rows: [{ available: true }] };
      return { rows: [], rowCount: 0 };
    },
    async end() {}
  };
  const database = createDatabase({}, pool);
  const result = await database.queryCandles(
    'TAQ', 'EURUSD', new Date(0), new Date(60000), 'UTC', 1, 1
  );
  assert.deepEqual(result, { rows: [], total: 0 });
  await database.close();
});

test('an empty M1 cache is backfilled from persisted TAQ ticks during initialization', async () => {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('pg_extension')) return { rows: [{ available: false }] };
      if (sql.includes('SELECT EXISTS (SELECT 1 FROM itr_market_candles_m1')) return { rows: [{ available: false }] };
      return { rows: [], rowCount: 0 };
    },
    async end() {}
  };
  const database = createDatabase({}, pool);
  await database.initialize();
  const backfill = calls.find(sql => sql.includes('INSERT INTO itr_market_candles_m1'));

  assert.ok(backfill);
  assert.match(backfill, /WHERE dataset = 'TAQ' AND bid IS NOT NULL/);
  assert.match(backfill, /GROUP BY symbol, minute_time/);
  await database.close();
});

test('TAQ inserts update ordered M1 OHLC candles in the same transaction', async () => {
  const firstAt = new Date('2026-06-14T12:00:10.000Z');
  const lastAt = new Date('2026-06-14T12:00:20.000Z');
  const transaction = [];
  let candleValues;
  const pool = {
    async query(sql) {
      if (sql.includes('pg_extension')) return { rows: [{ available: false }] };
      if (sql.includes('SELECT EXISTS (SELECT 1 FROM itr_market_candles_m1')) return { rows: [{ available: true }] };
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return {
        async query(sql, params) {
          transaction.push(sql);
          if (sql.includes('INSERT INTO itr_market_ticks')) return {
            rowCount: 2,
            rows: [
              { event_time: lastAt, sequence_no: '2', event_id: 'later', symbol: 'EURUSD', bid: 1.2 },
              { event_time: firstAt, sequence_no: '1', event_id: 'earlier', symbol: 'EURUSD', bid: 1.1 }
            ]
          };
          if (sql.includes('INSERT INTO itr_market_candles_m1')) candleValues = params;
          return { rows: [], rowCount: 1 };
        },
        release() { transaction.push('RELEASE') }
      };
    },
    async end() {}
  };
  const database = createDatabase({}, pool);
  const inserted = await database.insert('TAQ', 'EURUSD', [
    { Timestamp: '2026-06-14 12:00:10', BID: 1.1, ASK: 1.2, _sequence: 1 },
    { Timestamp: '2026-06-14 12:00:20', BID: 1.2, ASK: 1.3, _sequence: 2 }
  ]);

  assert.equal(inserted, 2);
  assert.equal(transaction[0], 'BEGIN');
  assert.equal(transaction[transaction.length - 2], 'COMMIT');
  assert.equal(transaction[transaction.length - 1], 'RELEASE');
  assert.equal(candleValues[0], 'EURUSD');
  assert.equal(candleValues[2].toISOString(), firstAt.toISOString());
  assert.equal(candleValues[3], '1');
  assert.equal(candleValues[4], 'earlier');
  assert.equal(candleValues[5], 1.1);
  assert.equal(candleValues[6], 1.2);
  assert.equal(candleValues[7], 1.1);
  assert.equal(candleValues[8], 1.2);
  assert.equal(candleValues[9].toISOString(), lastAt.toISOString());
  assert.equal(candleValues[10], '2');
  assert.equal(candleValues[11], 'later');
  assert.equal(candleValues[12], 2);
  await database.close();
});
