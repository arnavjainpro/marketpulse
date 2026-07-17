import { Database } from "bun:sqlite";
import { existsSync, renameSync } from "fs";
import { join, dirname } from "path";
import { config } from "./config";

// One-time rename from the pre-rebrand filename. `new Database(..., {create:true})`
// would otherwise silently open a fresh EMPTY database at the new path — every
// existing user's accounts, sessions, alerts, broker links, and journal would
// look like they vanished, with no error. Only runs if the new path doesn't
// already exist, so it's a no-op after the first boot post-upgrade.
{
  const legacyPath = join(dirname(config.dbPath), "marketpulse.db");
  if (!existsSync(config.dbPath) && existsSync(legacyPath)) {
    renameSync(legacyPath, config.dbPath);
    console.log(`[db] migrated ${legacyPath} → ${config.dbPath}`);
  }
}

export const db = new Database(config.dbPath, { create: true });

db.exec(`
CREATE TABLE IF NOT EXISTS bars (
  ticker TEXT NOT NULL,
  ts INTEGER NOT NULL,           -- unix seconds, minute-aligned
  open REAL, high REAL, low REAL, close REAL, volume REAL,
  PRIMARY KEY (ticker, ts)
);

CREATE TABLE IF NOT EXISTS daily_stats (
  ticker TEXT PRIMARY KEY,
  avg_volume_20d REAL,
  prev_close REAL,
  week52_high REAL,
  week52_low REAL,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  kind TEXT NOT NULL,            -- price_move | volume_spike | gap | week52 | news | filing | earnings
  title TEXT NOT NULL,
  detail TEXT,                   -- JSON payload from the detector
  dedupe_key TEXT UNIQUE,        -- prevents re-alerting the same underlying event
  severity TEXT,                 -- set by triage: critical | high | info
  triage_rationale TEXT
);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER REFERENCES events(id),
  ts INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  action TEXT NOT NULL,          -- buy | sell | trim | add | hold | watch
  conviction TEXT NOT NULL,      -- high | medium | low
  thesis TEXT NOT NULL,
  invalidation TEXT,
  portfolio_impact TEXT
);

CREATE TABLE IF NOT EXISTS briefings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,            -- open | close
  content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS screener (
  ticker TEXT PRIMARY KEY,
  score REAL NOT NULL,
  cross_status TEXT NOT NULL,    -- golden_formed | golden_soon | death_formed | none
  indicators TEXT NOT NULL,      -- JSON blob of computed factors
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  user_id INTEGER NOT NULL DEFAULT 0,  -- 0 = global (background pipeline switches, not per-user)
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS broker_links (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  provider TEXT NOT NULL,
  auth_json TEXT NOT NULL,
  linked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trade_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  ticker TEXT NOT NULL,
  direction TEXT NOT NULL,            -- long | short
  idea_id INTEGER REFERENCES ideas(id),
  entry_price REAL,
  exit_price REAL,
  outcome TEXT NOT NULL,              -- win | loss | breakeven
  pnl_pct REAL,
  notes TEXT,                         -- what went right/wrong, in the trader's words
  closed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outcomes_user_ticker ON trade_outcomes(user_id, ticker);
CREATE INDEX IF NOT EXISTS idx_outcomes_user_closed ON trade_outcomes(user_id, closed_at DESC);

CREATE TABLE IF NOT EXISTS risk_prefs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  account_equity REAL,
  max_risk_per_trade_pct REAL NOT NULL DEFAULT 1,
  max_position_pct REAL NOT NULL DEFAULT 20,
  target_rr_ratio REAL NOT NULL DEFAULT 2
);

CREATE TABLE IF NOT EXISTS universe (
  ticker TEXT PRIMARY KEY,
  name TEXT,
  sector TEXT,                   -- NASDAQ sector taxonomy (Technology, Finance, ...)
  industry TEXT,
  market_cap REAL,               -- USD
  last_price REAL,
  day_volume REAL,               -- most recent session share volume
  sp500 INTEGER DEFAULT 0,       -- 1 = current S&P 500 constituent
  in_scan INTEGER DEFAULT 0,     -- 1 = inside the active screener universe
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS market_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- single-row current snapshot
  ts INTEGER NOT NULL,
  regime TEXT NOT NULL,          -- JSON: trend/volatility/breadth/riskOff/label
  sectors TEXT NOT NULL,         -- JSON: per-sector rotation stats
  benchmarks TEXT NOT NULL       -- JSON: SPY/QQQ/IWM/VIX quick stats
);

CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  direction TEXT NOT NULL,       -- long | short
  rating TEXT NOT NULL,          -- strong | moderate | weak | reject
  confidence TEXT NOT NULL,      -- high | medium | low
  source TEXT NOT NULL,          -- validate | generate | intraday
  report TEXT NOT NULL           -- full JSON IdeaReport
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,  -- owner; the global evaluator fires them all to the shared notify channel
  ticker TEXT NOT NULL,
  kind TEXT NOT NULL,            -- price_above | price_below | score_gte
  threshold REAL NOT NULL,
  last_value REAL,              -- last observed value; seeds crossing detection
  active INTEGER NOT NULL DEFAULT 1,
  created_ts INTEGER NOT NULL,
  last_fired_ts INTEGER,
  UNIQUE(user_id, ticker, kind, threshold)   -- double-click "create alert" = one row, not two
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_bars_ticker_ts ON bars(ticker, ts DESC);
CREATE INDEX IF NOT EXISTS idx_ideas_ts ON ideas(ts DESC);
`);

// Migration: plain-language headline on signals (added after initial schema).
try {
  db.exec(`ALTER TABLE signals ADD COLUMN plain_headline TEXT`);
} catch {}
// Migration: directional scores + sector on screener rows (long/short framework).
for (const col of ["long_score REAL", "short_score REAL", "direction TEXT", "sector TEXT"]) {
  try {
    db.exec(`ALTER TABLE screener ADD COLUMN ${col}`);
  } catch {}
}
// Migration: alerts become per-user (owner scoping for the ⌘K alert manager).
// Only matters for a DB that ran the pre-merge global-alerts build; a fresh
// alerts table is already created with user_id above. Existing rows adopt user 1.
try {
  db.exec(`ALTER TABLE alerts ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`);
} catch {}
// A pre-multi-user alerts table was created with UNIQUE(ticker, kind, threshold)
// — no user_id — so createAlert's ON CONFLICT(user_id, ticker, kind, threshold)
// errors ("does not match any PRIMARY KEY or UNIQUE constraint"), and the 3-col
// constraint would also stop two users from setting the same alert. Table
// constraints can't be altered in place, so rebuild into the canonical shape.
{
  const idx = db.query(`PRAGMA index_list(alerts)`).all() as { name: string; unique: number }[];
  const uniqueCols = (name: string) =>
    (db.query(`PRAGMA index_info(${JSON.stringify(name)})`).all() as { name: string }[]).map((c) => c.name).sort().join(",");
  const legacy = idx.some((i) => i.unique && uniqueCols(i.name) === "kind,threshold,ticker");
  if (legacy) {
    // Wrapped in a transaction: exec() runs each `;`-separated statement
    // independently with no implicit transaction, so a mid-sequence failure
    // (e.g. after the RENAME but before CREATE TABLE) would otherwise leave
    // the DB with no `alerts` table at all until manually repaired.
    const rebuild = db.transaction(() => {
      db.exec(`DROP INDEX IF EXISTS idx_alerts_dedupe`);
      db.exec(`ALTER TABLE alerts RENAME TO alerts_old`);
      db.exec(`
        CREATE TABLE alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL DEFAULT 1,
          ticker TEXT NOT NULL,
          kind TEXT NOT NULL,
          threshold REAL NOT NULL,
          last_value REAL,
          active INTEGER NOT NULL DEFAULT 1,
          created_ts INTEGER NOT NULL,
          last_fired_ts INTEGER,
          UNIQUE(user_id, ticker, kind, threshold)
        )
      `);
      db.exec(`
        INSERT INTO alerts (id, user_id, ticker, kind, threshold, last_value, active, created_ts, last_fired_ts)
          SELECT id, user_id, ticker, kind, threshold, last_value, active, created_ts, last_fired_ts FROM alerts_old
      `);
      db.exec(`DROP TABLE alerts_old`);
    });
    rebuild();
    console.log("[db] rebuilt alerts table with per-user unique constraint");
  }
}
// Migration: recurring alerts (re-arm after firing instead of retiring).
try {
  db.exec(`ALTER TABLE alerts ADD COLUMN recurring INTEGER NOT NULL DEFAULT 0`);
} catch {}
// Migration: settings becomes per-user (composite user_id+key PK). Pre-existing
// rows (all global before multi-user existed) are kept under user_id=0.
{
  const cols = db.query(`PRAGMA table_info(settings)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "user_id")) {
    db.exec(`ALTER TABLE settings RENAME TO settings_old`);
    db.exec(`CREATE TABLE settings (
      user_id INTEGER NOT NULL DEFAULT 0,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    )`);
    db.exec(`INSERT INTO settings (user_id, key, value) SELECT 0, key, value FROM settings_old`);
    db.exec(`DROP TABLE settings_old`);
  }
}
// Migration: ideas become per-user. Pre-existing rows adopt the bootstrap
// owner (user id 1 — whoever signs up first inherits the original single-user data).
try {
  db.exec(`ALTER TABLE ideas ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`);
} catch {}
db.exec(`CREATE INDEX IF NOT EXISTS idx_ideas_user_ts ON ideas(user_id, ts DESC)`);
// Migration: trader-chosen minimum risk/reward for a "strong" rating.
try {
  db.exec(`ALTER TABLE risk_prefs ADD COLUMN target_rr_ratio REAL NOT NULL DEFAULT 2`);
} catch {}
// Migration: optional profile fields (Settings → Profile card).
try {
  db.exec(`ALTER TABLE users ADD COLUMN full_name TEXT`);
} catch {}
try {
  db.exec(`ALTER TABLE users ADD COLUMN phone TEXT`);
} catch {}

export function getSetting(key: string, fallback: string): string {
  const row = db.query(`SELECT value FROM settings WHERE user_id = 0 AND key = ?`).get(key) as { value: string } | null;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string) {
  db.query(`INSERT INTO settings (user_id, key, value) VALUES (0, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`).run(key, value);
}

// Per-user settings (e.g. broker JSON import blob).
export function getSettingFor(userId: number, key: string, fallback: string): string {
  const row = db.query(`SELECT value FROM settings WHERE user_id = ? AND key = ?`).get(userId, key) as { value: string } | null;
  return row?.value ?? fallback;
}

export function setSettingFor(userId: number, key: string, value: string) {
  db.query(`INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`).run(userId, key, value);
}

export interface RiskPrefs {
  account_equity: number | null;
  max_risk_per_trade_pct: number;
  max_position_pct: number;
  target_rr_ratio: number; // minimum R:R for a "strong" rating in idea validation
}

export function getRiskPrefs(userId: number): RiskPrefs | null {
  return db.query(`SELECT account_equity, max_risk_per_trade_pct, max_position_pct, target_rr_ratio FROM risk_prefs WHERE user_id = ?`).get(userId) as RiskPrefs | null;
}

export function setRiskPrefs(userId: number, prefs: RiskPrefs) {
  db.query(
    `INSERT INTO risk_prefs (user_id, account_equity, max_risk_per_trade_pct, max_position_pct, target_rr_ratio) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET account_equity = excluded.account_equity,
       max_risk_per_trade_pct = excluded.max_risk_per_trade_pct, max_position_pct = excluded.max_position_pct,
       target_rr_ratio = excluded.target_rr_ratio`
  ).run(userId, prefs.account_equity, prefs.max_risk_per_trade_pct, prefs.max_position_pct, prefs.target_rr_ratio);
}

export interface BrokerLink {
  provider: string;
  auth_json: string;
}

export function getBrokerLink(userId: number): BrokerLink | null {
  return db.query(`SELECT provider, auth_json FROM broker_links WHERE user_id = ?`).get(userId) as BrokerLink | null;
}

export function setBrokerLink(userId: number, provider: string, authJson: string) {
  db.query(
    `INSERT INTO broker_links (user_id, provider, auth_json, linked_at) VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(user_id) DO UPDATE SET provider = excluded.provider, auth_json = excluded.auth_json, linked_at = excluded.linked_at`
  ).run(userId, provider, authJson);
}

export function clearBrokerLink(userId: number) {
  db.query(`DELETE FROM broker_links WHERE user_id = ?`).run(userId);
}

// Master switch for automatic AI calls (triage, analysis, scheduled briefings).
// User-initiated actions (chat, manual briefing, screener deep-dive) always work.
export const aiLive = () => getSetting("ai_live", "1") === "1";
export const setAiLive = (on: boolean) => setSetting("ai_live", on ? "1" : "0");

export interface EventRow {
  id: number;
  ts: number;
  ticker: string;
  kind: string;
  title: string;
  detail: string | null;
  severity: string | null;
  triage_rationale: string | null;
}

export function insertEvent(e: {
  ts: number;
  ticker: string;
  kind: string;
  title: string;
  detail?: object;
  dedupeKey: string;
}): number | null {
  const res = db
    .query(
      `INSERT INTO events (ts, ticker, kind, title, detail, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`
    )
    .get(e.ts, e.ticker, e.kind, e.title, JSON.stringify(e.detail ?? {}), e.dedupeKey) as
    | { id: number }
    | null;
  return res?.id ?? null;
}

export function setTriage(eventId: number, severity: string, rationale: string) {
  db.query(`UPDATE events SET severity = ?, triage_rationale = ? WHERE id = ?`).run(
    severity,
    rationale,
    eventId
  );
}

export function insertSignal(s: {
  event_id: number;
  ticker: string;
  action: string;
  conviction: string;
  plain_headline: string;
  thesis: string;
  invalidation: string;
  portfolio_impact: string;
}): number {
  const res = db
    .query(
      `INSERT INTO signals (event_id, ts, ticker, action, conviction, plain_headline, thesis, invalidation, portfolio_impact)
       VALUES (?, unixepoch(), ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(s.event_id, s.ticker, s.action, s.conviction, s.plain_headline, s.thesis, s.invalidation, s.portfolio_impact) as { id: number };
  return res.id;
}

export function upsertBar(ticker: string, ts: number, o: number, h: number, l: number, c: number, v: number) {
  db.query(
    `INSERT INTO bars (ticker, ts, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ticker, ts) DO UPDATE SET high=max(high,excluded.high), low=min(low,excluded.low),
       close=excluded.close, volume=volume+excluded.volume`
  ).run(ticker, ts, o, h, l, c, v);
}

export function recentBars(ticker: string, limit = 120): { ts: number; open: number; high: number; low: number; close: number; volume: number }[] {
  return db
    .query(`SELECT ts, open, high, low, close, volume FROM bars WHERE ticker = ? ORDER BY ts DESC LIMIT ?`)
    .all(ticker, limit)
    .reverse() as any;
}
