'use strict';

const { createHash } = require('crypto');
const { Pool } = require('pg');

const TABLE = 'itr_market_ticks';
const TABLE_ID = `public.${TABLE}`;
const CANDLE_TABLE = 'itr_market_candles_m1';
const cleanRow = row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== '_eventTime' && key !== '_sequence'));
const eventTime = (dataset, row, blockStart) => {
  if (dataset !== 'GCV') {
    const value = row.Timestamp;
    const parsed = value && new Date(value.replace(' ', 'T'));
    if (parsed && !Number.isNaN(parsed.getTime())) return parsed;
  }

  const supplied = row._eventTime && new Date(row._eventTime);
  const source = supplied && !Number.isNaN(supplied.getTime())
    ? supplied
    : blockStart === undefined ? new Date() : new Date(blockStart);

  if (dataset !== 'GCV') return source;
  const match = /^(\d{1,2}):(\d{2}):(\d{2})/.exec(String(row['TIMEACT NS'] || ''));
  if (!match) return source;

  source.setHours(+match[1], +match[2], +match[3], 0);
  return source;
};
const numberOrNull = value => value === undefined || value === null || value === '' || !Number.isFinite(+value) ? null : +value;

function createDatabase(config, poolOverride) {
  const pool = poolOverride || new Pool(config.connectionString
    ? { connectionString: config.connectionString, max: 8, connectionTimeoutMillis: 3000 }
    : {
      host: config.host, port: config.port, database: config.database, user: config.user, password: config.password,
      max: 8, connectionTimeoutMillis: 3000
    });
  let initialized = false;
  let initializing = null;
  let timescale = false;

  async function initialize() {
    if (initialized) return { timescale };
    if (!initializing) {
      initializing = (async () => {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS ${TABLE} (
            event_time TIMESTAMPTZ NOT NULL,
            sequence_no BIGINT NOT NULL DEFAULT 0,
            event_id TEXT NOT NULL,
            dataset TEXT NOT NULL CHECK (dataset IN ('TAQ', 'TAS', 'GCV')),
            symbol TEXT NOT NULL,
            bid DOUBLE PRECISION,
            ask DOUBLE PRECISION,
            trade_price DOUBLE PRECISION,
            direction TEXT,
            volume DOUBLE PRECISION,
            row_data JSONB NOT NULL,
            PRIMARY KEY (event_time, event_id)
          )
        `);

        const extension = await pool.query(`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') AS available`);
        if (extension.rows[0].available) {
          await pool.query(
            `SELECT create_hypertable($1::regclass, 'event_time', if_not_exists => TRUE, migrate_data => TRUE)`,
            [TABLE_ID]
          );
          timescale = true;
        }

        await pool.query(`CREATE INDEX IF NOT EXISTS itr_market_ticks_lookup ON ${TABLE} (dataset, symbol, event_time DESC, sequence_no DESC)`);
        await pool.query(`
          CREATE TABLE IF NOT EXISTS ${CANDLE_TABLE} (
            symbol TEXT NOT NULL,
            minute_time TIMESTAMPTZ NOT NULL,
            first_time TIMESTAMPTZ NOT NULL,
            first_sequence BIGINT NOT NULL,
            first_event_id TEXT NOT NULL,
            open DOUBLE PRECISION NOT NULL,
            high DOUBLE PRECISION NOT NULL,
            low DOUBLE PRECISION NOT NULL,
            close DOUBLE PRECISION NOT NULL,
            last_time TIMESTAMPTZ NOT NULL,
            last_sequence BIGINT NOT NULL,
            last_event_id TEXT NOT NULL,
            ticks BIGINT NOT NULL,
            PRIMARY KEY (symbol, minute_time)
          )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS itr_market_candles_m1_lookup ON ${CANDLE_TABLE} (symbol, minute_time DESC)`);
        const candleState = await pool.query(`SELECT EXISTS (SELECT 1 FROM ${CANDLE_TABLE} LIMIT 1) AS available`);
        if (!candleState.rows[0].available) {
          await pool.query(`
            WITH source AS (
              SELECT symbol, event_time, sequence_no, event_id, bid,
                to_timestamp(floor(extract(epoch FROM event_time) / 60) * 60) AS minute_time
              FROM ${TABLE}
              WHERE dataset = 'TAQ' AND bid IS NOT NULL
            ), grouped AS (
              SELECT symbol, minute_time,
                (array_agg(event_time ORDER BY event_time, sequence_no, event_id))[1] AS first_time,
                (array_agg(sequence_no ORDER BY event_time, sequence_no, event_id))[1] AS first_sequence,
                (array_agg(event_id ORDER BY event_time, sequence_no, event_id))[1] AS first_event_id,
                (array_agg(bid ORDER BY event_time, sequence_no, event_id))[1] AS open,
                MAX(bid) AS high,
                MIN(bid) AS low,
                (array_agg(event_time ORDER BY event_time DESC, sequence_no DESC, event_id DESC))[1] AS last_time,
                (array_agg(sequence_no ORDER BY event_time DESC, sequence_no DESC, event_id DESC))[1] AS last_sequence,
                (array_agg(event_id ORDER BY event_time DESC, sequence_no DESC, event_id DESC))[1] AS last_event_id,
                (array_agg(bid ORDER BY event_time DESC, sequence_no DESC, event_id DESC))[1] AS close,
                COUNT(*) AS ticks
              FROM source
              GROUP BY symbol, minute_time
            )
            INSERT INTO ${CANDLE_TABLE}
              (symbol, minute_time, first_time, first_sequence, first_event_id, open, high, low, close,
               last_time, last_sequence, last_event_id, ticks)
            SELECT symbol, minute_time, first_time, first_sequence, first_event_id, open, high, low, close,
              last_time, last_sequence, last_event_id, ticks
            FROM grouped
            ON CONFLICT (symbol, minute_time) DO NOTHING
          `);
        }
        initialized = true;
        return { timescale };
      })();
      initializing.catch(() => { initializing = null });
    }
    return initializing;
  }

  async function insert(dataset, symbol, rows, blockStart) {
    if (!rows.length) return 0;
    await initialize();
    const clean = rows.map((row, index) => {
      const data = cleanRow(row);
      const at = eventTime(dataset, row, blockStart);
      if (Number.isNaN(at.getTime())) throw new Error(`Invalid ${dataset} timestamp for ${symbol}`);
      const iso = at.toISOString();
      const sequence = numberOrNull(row._sequence) ?? index;
      const eventId = createHash('sha256').update(JSON.stringify([dataset, symbol, iso, sequence, data])).digest('hex');
      const bid = numberOrNull(data.BID ?? data.Bid);
      const ask = numberOrNull(data.ASK ?? data.Ask);
      const price = numberOrNull(data.TRDPRC_1 ?? data.Last ?? (bid !== null && ask !== null ? (bid + ask) / 2 : null));
      const volume = numberOrNull(data.TRDVOL_1 ?? data.Volume ?? data['Trd.Vol']);
      const direction = data.PRCTCK_1 ?? data.Tick ?? null;
      return { at: iso, sequence, eventId, dataset, symbol, bid, ask, price, direction, volume, data };
    });

    let inserted = 0;
    for (let offset = 0; offset < clean.length; offset += 350) {
      const chunk = clean.slice(offset, offset + 350);
      const values = [];
      const tuples = chunk.map((row, index) => {
        const start = index * 11;
        values.push(row.at, row.sequence, row.eventId, row.dataset, row.symbol, row.bid, row.ask, row.price, row.direction, row.volume, JSON.stringify(row.data));
        return `(${Array.from({ length: 11 }, (_, column) => `$${start + column + 1}`).join(', ')})`;
      });
      const client = dataset === 'TAQ' ? await pool.connect() : pool;
      try {
        if (dataset === 'TAQ') await client.query('BEGIN');
        const result = await client.query(
          `INSERT INTO ${TABLE} (event_time, sequence_no, event_id, dataset, symbol, bid, ask, trade_price, direction, volume, row_data)
           VALUES ${tuples.join(', ')}
           ON CONFLICT (event_time, event_id) DO NOTHING
           ${dataset === 'TAQ' ? 'RETURNING event_time, sequence_no, event_id, symbol, bid' : ''}`,
          values
        );
        if (dataset === 'TAQ' && result.rows.length) await upsertMinuteCandles(result.rows, client);
        if (dataset === 'TAQ') await client.query('COMMIT');
        inserted += result.rowCount;
      } catch (error) {
        if (dataset === 'TAQ') {
          try { await client.query('ROLLBACK') }
          catch (rollbackError) { error.message += `; rollback failed: ${rollbackError.message}` }
        }
        throw error;
      } finally {
        if (dataset === 'TAQ') client.release();
      }
    }
    return inserted;
  }

  async function upsertMinuteCandles(ticks, executor) {
    const groups = new Map();
    for (const tick of ticks) {
      if (tick.bid === null) continue;
      const minute = Math.floor(new Date(tick.event_time).getTime() / 60000) * 60000;
      const key = `${tick.symbol}:${minute}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(tick);
    }
    if (!groups.size) return;

    const compare = (a, b) => {
      const timeDiff = new Date(a.event_time) - new Date(b.event_time);
      if (timeDiff) return timeDiff;
      const aSequence = BigInt(a.sequence_no), bSequence = BigInt(b.sequence_no);
      if (aSequence !== bSequence) return aSequence < bSequence ? -1 : 1;
      return a.event_id.localeCompare(b.event_id);
    };
    const candles = [...groups.values()].map(rows => {
      rows.sort(compare);
      const first = rows[0], last = rows[rows.length - 1];
      return {
        symbol: first.symbol,
        minute: new Date(Math.floor(new Date(first.event_time).getTime() / 60000) * 60000).toISOString(),
        first, last,
        high: Math.max(...rows.map(row => row.bid)),
        low: Math.min(...rows.map(row => row.bid)),
        ticks: rows.length
      };
    });
    for (let offset = 0; offset < candles.length; offset += 350) {
      const chunk = candles.slice(offset, offset + 350), values = [];
      const tuples = chunk.map((candle, index) => {
        const start = index * 13;
        values.push(candle.symbol, candle.minute, candle.first.event_time, candle.first.sequence_no, candle.first.event_id,
          candle.first.bid, candle.high, candle.low, candle.last.bid, candle.last.event_time,
          candle.last.sequence_no, candle.last.event_id, candle.ticks);
        return `(${Array.from({ length: 13 }, (_, column) => `$${start + column + 1}`).join(', ')})`;
      });
      await executor.query(`
        INSERT INTO ${CANDLE_TABLE} AS existing
          (symbol, minute_time, first_time, first_sequence, first_event_id, open, high, low, close,
           last_time, last_sequence, last_event_id, ticks)
        VALUES ${tuples.join(', ')}
        ON CONFLICT (symbol, minute_time) DO UPDATE SET
          first_time = CASE WHEN (EXCLUDED.first_time, EXCLUDED.first_sequence, EXCLUDED.first_event_id)
            < (existing.first_time, existing.first_sequence, existing.first_event_id) THEN EXCLUDED.first_time ELSE existing.first_time END,
          first_sequence = CASE WHEN (EXCLUDED.first_time, EXCLUDED.first_sequence, EXCLUDED.first_event_id)
            < (existing.first_time, existing.first_sequence, existing.first_event_id) THEN EXCLUDED.first_sequence ELSE existing.first_sequence END,
          first_event_id = CASE WHEN (EXCLUDED.first_time, EXCLUDED.first_sequence, EXCLUDED.first_event_id)
            < (existing.first_time, existing.first_sequence, existing.first_event_id) THEN EXCLUDED.first_event_id ELSE existing.first_event_id END,
          open = CASE WHEN (EXCLUDED.first_time, EXCLUDED.first_sequence, EXCLUDED.first_event_id)
            < (existing.first_time, existing.first_sequence, existing.first_event_id) THEN EXCLUDED.open ELSE existing.open END,
          high = GREATEST(existing.high, EXCLUDED.high),
          low = LEAST(existing.low, EXCLUDED.low),
          last_time = CASE WHEN (EXCLUDED.last_time, EXCLUDED.last_sequence, EXCLUDED.last_event_id)
            > (existing.last_time, existing.last_sequence, existing.last_event_id) THEN EXCLUDED.last_time ELSE existing.last_time END,
          last_sequence = CASE WHEN (EXCLUDED.last_time, EXCLUDED.last_sequence, EXCLUDED.last_event_id)
            > (existing.last_time, existing.last_sequence, existing.last_event_id) THEN EXCLUDED.last_sequence ELSE existing.last_sequence END,
          last_event_id = CASE WHEN (EXCLUDED.last_time, EXCLUDED.last_sequence, EXCLUDED.last_event_id)
            > (existing.last_time, existing.last_sequence, existing.last_event_id) THEN EXCLUDED.last_event_id ELSE existing.last_event_id END,
          close = CASE WHEN (EXCLUDED.last_time, EXCLUDED.last_sequence, EXCLUDED.last_event_id)
            > (existing.last_time, existing.last_sequence, existing.last_event_id) THEN EXCLUDED.close ELSE existing.close END,
          ticks = existing.ticks + EXCLUDED.ticks
      `, values);
    }
  }

  async function latestQuotesAt(at, symbols) {
    await initialize();
    const result = await pool.query(`
      SELECT DISTINCT ON (symbol) symbol, event_time, bid, ask, direction
      FROM ${TABLE}
      WHERE dataset = 'TAQ' AND event_time <= $1 AND symbol = ANY($2::text[])
      ORDER BY symbol, event_time DESC, sequence_no DESC
    `, [at, symbols]);
    return Object.fromEntries(result.rows.map(row => [row.symbol, {
      time: row.event_time, bid: row.bid, ask: row.ask, dir: row.direction
    }]));
  }

  async function historyIndex(symbols, timezone) {
    await initialize();
    const result = await pool.query(`
      SELECT dataset, symbol,
        COUNT(DISTINCT (event_time AT TIME ZONE $2)::date)::integer AS blocks,
        ARRAY_AGG(DISTINCT to_char(event_time AT TIME ZONE $2, 'YYYY-MM-DD')) AS dates
      FROM ${TABLE}
      WHERE symbol = ANY($1::text[])
      GROUP BY dataset, symbol
    `, [symbols, timezone]);
    const index = Object.fromEntries(['TAQ', 'TAS', 'GCV'].map(dataset => [dataset, {}]));
    for (const row of result.rows) index[row.dataset][row.symbol] = { blocks: row.blocks, dates: row.dates.sort() };
    for (const dataset of Object.keys(index)) for (const symbol of symbols) {
      if (!index[dataset][symbol]) index[dataset][symbol] = { blocks: 0, dates: [] };
    }
    return index;
  }

  async function queryHistory(dataset, symbol, from, to, offset, limit) {
    await initialize();
    const count = await pool.query(
      `SELECT COUNT(*)::bigint AS total, MIN(event_time) AS first, MAX(event_time) AS last
       FROM ${TABLE} WHERE dataset = $1 AND symbol = $2 AND event_time >= $3 AND event_time < $4`,
      [dataset, symbol, from, to]
    );
    const page = await pool.query(
      `SELECT row_data FROM ${TABLE}
       WHERE dataset = $1 AND symbol = $2 AND event_time >= $3 AND event_time < $4
       ORDER BY event_time, sequence_no, event_id OFFSET $5 LIMIT $6`,
      [dataset, symbol, from, to, offset, limit]
    );
    const row = count.rows[0];
    return {
      rows: page.rows.map(item => item.row_data),
      total: Number(row.total),
      first: row.first,
      last: row.last
    };
  }

  async function queryCandles(dataset, symbol, from, to, timezone, timeframe, limit) {
    await initialize();
    const result = await pool.query(`
      WITH localized AS (
        SELECT minute_time, open, high, low, close, ticks,
          minute_time AT TIME ZONE $5 AS local_time,
          date_trunc('day', minute_time AT TIME ZONE $5) AS local_day
        FROM ${CANDLE_TABLE}
        WHERE $1::text = 'TAQ' AND symbol = $2 AND minute_time >= $3 AND minute_time < $4
      ), bucketed AS (
        SELECT minute_time, open, high, low, close, ticks,
          (local_day + floor(extract(epoch FROM (local_time - local_day)) / ($6::int * 60))::int
            * ($6::int * interval '1 minute')) AT TIME ZONE $5 AS bucket_time
        FROM localized
      ), grouped AS (
        SELECT bucket_time AS t,
          (array_agg(open ORDER BY minute_time))[1] AS o,
          MAX(high) AS h,
          MIN(low) AS l,
          (array_agg(close ORDER BY minute_time DESC))[1] AS c,
          SUM(ticks)::bigint AS v,
          SUM(ticks)::bigint AS n
        FROM bucketed
        GROUP BY bucket_time
      ), counted AS (
        SELECT *, COUNT(*) OVER() AS total FROM grouped
      )
      SELECT * FROM (
        SELECT * FROM counted ORDER BY t DESC LIMIT $7
      ) recent ORDER BY t ASC
    `, [dataset, symbol, from, to, timezone, timeframe, limit]);
    const total = result.rows.length ? Number(result.rows[0].total) : 0;
    return {
      rows: result.rows.map(row => ({
        t: new Date(row.t).getTime(),
        o: Number(row.o), h: Number(row.h), l: Number(row.l), c: Number(row.c),
        v: Number(row.v), n: Number(row.n)
      })),
      total
    };
  }

  async function close() {
    await pool.end();
  }

  return { initialize, insert, latestQuotesAt, historyIndex, queryHistory, queryCandles, close, get timescale() { return timescale } };
}

module.exports = { createDatabase };
