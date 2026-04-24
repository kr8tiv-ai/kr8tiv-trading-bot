-- @kr8tiv/executor Phase 2 schema. All DDL is idempotent; safe to re-apply.
-- Phase 5 (ledger + reconciler) extends with ledger_events + reconcile_log.

CREATE TABLE IF NOT EXISTS orders (
  client_order_id TEXT PRIMARY KEY,
  exchange_order_id TEXT,
  pair TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  type TEXT NOT NULL CHECK (type IN ('market', 'limit')),
  qty_base REAL,
  qty_quote REAL,
  status TEXT NOT NULL CHECK (status IN ('submitted', 'accepted', 'partially_filled', 'filled', 'cancelled', 'rejected')),
  raw_response TEXT,
  signal_id TEXT,
  approval_ts_ms INTEGER,
  submitted_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_submitted_at ON orders(submitted_at_ms);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS orders_pair_status ON orders(pair, status);

CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_order_id TEXT NOT NULL REFERENCES orders(client_order_id),
  fill_id TEXT,
  qty_base REAL NOT NULL,
  price REAL NOT NULL,
  fee REAL NOT NULL,
  fee_currency TEXT NOT NULL,
  filled_at_ms INTEGER NOT NULL,
  raw_response TEXT
);
CREATE INDEX IF NOT EXISTS fills_client_order_id ON fills(client_order_id);
CREATE INDEX IF NOT EXISTS fills_filled_at ON fills(filled_at_ms);

CREATE TABLE IF NOT EXISTS realized_pnl (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  close_fill_id INTEGER NOT NULL REFERENCES fills(id),
  entry_fill_id INTEGER REFERENCES fills(id),
  realized_usd REAL NOT NULL,
  closed_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS realized_pnl_closed_at ON realized_pnl(closed_at_ms);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venue TEXT NOT NULL,
  market TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  price REAL NOT NULL,
  size REAL NOT NULL,
  quote_notional REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  fee_currency TEXT NOT NULL DEFAULT 'USDT',
  executed_at_ms INTEGER NOT NULL,
  source_trade_id TEXT NOT NULL,
  source_order_id TEXT,
  leverage REAL,
  risk_mode TEXT CHECK (risk_mode IS NULL OR risk_mode IN ('sniper', 'core')),
  thesis TEXT,
  journal_note TEXT,
  raw_response TEXT,
  imported_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE (venue, market, source_trade_id)
);
CREATE INDEX IF NOT EXISTS trades_symbol_executed_at ON trades(symbol, executed_at_ms);
CREATE INDEX IF NOT EXISTS trades_market_executed_at ON trades(market, executed_at_ms);

CREATE TABLE IF NOT EXISTS executor_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE VIEW IF NOT EXISTS positions AS
SELECT
  o.pair,
  SUM(CASE WHEN f.qty_base IS NOT NULL AND o.side = 'buy' THEN f.qty_base ELSE 0 END)
    - SUM(CASE WHEN f.qty_base IS NOT NULL AND o.side = 'sell' THEN f.qty_base ELSE 0 END) AS net_qty_base
FROM fills f
JOIN orders o ON o.client_order_id = f.client_order_id
GROUP BY o.pair;
