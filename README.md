# ITR Forex Terminal

A local, full-stack **simulated** forex terminal. The browser frontend is served by a separate Node.js backend that owns market simulation, demo brokerage, robot trading, candles, history, and generated data feeds.

> This project does not connect to a real broker or provide real market prices. All quotes, fills, and performance results are simulated. It is for software testing and practice only.

## Requirements

- Node.js 18 or newer
- npm

## Run locally

1. Open a terminal in this folder.
2. Run `npm install`.
3. Run `npm start` or double-click `start.bat` on Windows.
4. Open [http://localhost:4100](http://localhost:4100).

The server binds to `127.0.0.1` by default and stores generated state and history in `history/`. Keep the server process open while using the terminal.

## Project layout

```text
backend/
  admin-server.js separate authenticated admin portal service
  database.js    PostgreSQL/TimescaleDB schema, history import and timestamp queries
  server.js       HTTP API, simulated market, data feed and history services
  broker.js       Demo account, orders, positions and performance statistics
  robot.js        Configurable simulated trading robot
  market.js       Price engine, symbols, sessions and candle aggregation
  indicators.js   Technical indicators used by the robot
  backtest.js     Historical simulation runner
frontend/
  public/         Browser UI, styles and client-side API integration
admin/
  public/          Independent administrator portal application
history/          Runtime state and generated data (created on first run)
.env.example      PostgreSQL connection template; copy to .env and set local credentials
```

The backend serves static assets from `frontend/public` and exposes the JSON endpoints consumed by that UI. It creates a `public.itr_market_ticks` table in PostgreSQL and automatically uses a TimescaleDB hypertable when the extension is enabled. Both this terminal and your other project can connect to the same database and read the same tick history.

### Public market view and protected controls

The terminal pages, current simulated prices, market sessions, candles, and read-only TAQ Pro / TAS Pro / GCV feed summaries, recent rows, and bounded historical market queries are available without signing in. The public history API returns only market rows and sanitized time-block metadata; CSV exports, file listings/downloads, account/order/robot status, all mutations, configuration, and filesystem browsing require application-level authentication. The public feed status distinguishes live market generation from the PostgreSQL connection; “Database connected” is only shown when the configured database is initialized and has not reported a failed write. When `API_TOKEN` is configured, use **Admin / private access**; the server exchanges it for an expiring HttpOnly, SameSite session cookie. The standalone admin portal forwards this credential only from its server-side proxy. The browser never stores the API token.

Set a unique random `API_TOKEN` of at least 32 characters in the private `.env` file to enable private features. If it is absent, public market reads continue to work but sign-in is unavailable and private endpoints remain denied. `HOST` must remain loopback for plain HTTP; binding to a remote interface requires `API_COOKIE_SECURE=1` behind a trusted HTTPS reverse proxy. Keep Cloudflare Access enabled as an additional outer access layer; this application configuration does not change Cloudflare policy or deployment settings.

## Connect PostgreSQL / TimescaleDB

1. In this project directory, copy `.env.example` to `.env`.
2. Edit `.env` and set `PGDATABASE`, `PGUSER`, and `PGPASSWORD` to the existing PostgreSQL database and account shared with the other project. Keep `.env` private; it is excluded from the ZIP and Git.
3. Make sure PostgreSQL accepts local connections on `PGHOST` and `PGPORT`, then run `npm install` and `npm start`.
4. The app creates `public.itr_market_ticks`. The PostgreSQL user needs permission to create tables and indexes in the `public` schema. Enable TimescaleDB in pgAdmin if desired with `CREATE EXTENSION IF NOT EXISTS timescaledb;`; otherwise the table works as regular PostgreSQL.

On startup the app imports the existing TAQ, TAS, and GCV journal/archive files into PostgreSQL, then writes new live ticks there. Imports are safe to retry and do not insert duplicate ticks. Existing local files remain in place. If PostgreSQL is unavailable, live rows stay in the local outbox and the server reports the connection/sync error in its console and `/db/status`.

The other project can use the same table. The `dataset` column is `TAQ`, `TAS`, or `GCV`; `symbol` is e.g. `EURUSD`; `event_time` is the local market tick time stored as `timestamptz`; and `row_data` contains the original feed row as JSONB. For example, the last known quote for each symbol at a selected time is:

History import tolerates NUL-padded journal files, recovers valid rows, and
continues importing other blocks. If a journal has no recoverable rows, its
original file is retained and the rest of history still imports. Temporary
Windows file-lock errors on journal/outbox writes are retried; persistent
write errors are reported without terminating the market loop.

```sql
SELECT DISTINCT ON (symbol) symbol, event_time, bid, ask, direction
FROM public.itr_market_ticks
WHERE dataset = 'TAQ'
  AND event_time <= TIMESTAMPTZ '2026-10-07 15:30:00+03'
ORDER BY symbol, event_time DESC, sequence_no DESC;
```

The History page’s timestamp lookup and TAQ/TAS/GCV date-range search read from PostgreSQL after history synchronization completes.

## Features

- Live simulated quotes for six forex/metal instruments
- Responsive market watch, live and historical candle chart with date-range loading and candle replay, account summary and manual demo order ticket
- Market, limit and stop orders; position protection and trade history
- Configurable automated demo-trading robot and statistics
- Automatic repair of sparse simulated candle history after an interrupted or incomplete run
- TAQ, TAS and GCV feed generation, CSV/XLSX export, and searchable local history
- Persistent demo account and market state

The chart supports M1, M5, M15, M30, H1, H4 and D1. Each viewer's browser timezone is used for chart labels, selected date ranges and candle boundaries (including daylight-saving changes); timezone does not have to be changed on the server. When PostgreSQL history is synchronized, candles are aggregated from cached TAQ bid M1 candles; the cache is backfilled from existing ticks and updated as new TAQ history is inserted. Local M1 candle files are used when the database has no candles for the requested range. Historical chart responses are capped at 5,000 candles and display a notice when a range exceeds that cap.

## Optional configuration

Set environment variables before starting the server:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Backend bind address |
| `STATUS_PORT` | `4100` | Web UI and API port |
| `HISTORY_DIR` | `history/` | Runtime state and feed history directory |
| `PGHOST` | `127.0.0.1` | PostgreSQL server host |
| `PGPORT` | `5432` | PostgreSQL server port |
| `PGDATABASE` | `postgres` | Shared PostgreSQL database name |
| `PGUSER` | `postgres` | PostgreSQL login user |
| `PGPASSWORD` | unset | PostgreSQL password; set only in local `.env` |
| `DATABASE_URL` | unset | Optional full PostgreSQL connection string (overrides the `PG*` fields) |
| `SYMBOLS` | all supported symbols | Comma-separated enabled symbols |
| `QUOTE_RATE` | `8` | Average simulated quote ticks per second per instrument |
| `RATE_SCALE` | `1` | Multiplier for simulated quote activity |
| `WARMUP_HOURS` | `72` | Initial simulated chart history |
| `BLOCK_MINUTES` | `240` | Data-feed archive interval |
| `LIVE_XLSX_SECONDS` | `60` | Live workbook refresh interval; `0` disables it |
| `NO_OPEN` | unset | Set to `1` to avoid opening a browser automatically |
| `API_TOKEN` | unset | User-generated credential (minimum 32 characters) for private terminal, admin, config, history exports, and file endpoints |
| `API_COOKIE_SECURE` | unset | Set to `1` behind a trusted HTTPS reverse proxy; required when `HOST` is not loopback |

## Standalone administration portal

The admin portal is a separate web application and Node.js service, not part of the trader pages or navigation. On first launch, set `ADMIN_USERNAME` and a unique `ADMIN_PASSWORD` of at least 14 characters in the private `.env` file, then run `npm run start:admin` in a second terminal. Open [http://127.0.0.1:4200](http://127.0.0.1:4200). Change your username or password any time from **Profile** inside the portal; after first startup the admin account is stored in `history/.admin/admin-state.json`, and the portal uses its saved password rather than resetting it from `.env` on restart.

The portal has its own sign-in, an HttpOnly/SameSite session cookie, login-attempt limits and same-origin checks. It proxies only the terminal status, account, robot status and demo-robot configuration endpoints. Provider API keys are encrypted at rest under a key derived from the admin password; the saved secret is never returned to the browser. If you forget the admin password, the encrypted settings cannot be recovered. Back up `history/.admin/admin-state.json` securely.

The **API settings** page can securely store AI-provider and broker account configuration for later setup. At present those values are configuration only: provider/broker adapters are not installed, so saving keys does not call providers, authorize a broker or enable live trading. By default, the portal binds to loopback and is available only on its host. Remote administration requires a trusted HTTPS reverse proxy and `ADMIN_COOKIE_SECURE=1`; do not expose the standalone Node.js HTTP service directly to the public internet.

| Admin setting | Default | Purpose |
| --- | --- | --- |
| `ADMIN_HOST` | `127.0.0.1` | Admin service bind address; loopback is recommended |
| `ADMIN_PORT` | `4200` | Separate admin portal port |
| `ADMIN_USERNAME` | unset | Required admin login |
| `ADMIN_PASSWORD` | unset | Required password (minimum 14 characters) |
| `ADMIN_TERMINAL_URL` | `http://127.0.0.1:4100` | Local terminal API proxied by the admin service |
| `ADMIN_COOKIE_SECURE` | unset | Set to `1` only behind a trusted HTTPS reverse proxy |

Run a sample robot backtest with `npm run backtest`. Backtest results describe only this project's generated simulated prices and are not predictive of real trading.
