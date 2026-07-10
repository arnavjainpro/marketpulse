import { Database } from "bun:sqlite";
import { config } from "./config";

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
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_bars_ticker_ts ON bars(ticker, ts DESC);
`);

// Migration: plain-language headline on signals (added after initial schema).
try {
  db.exec(`ALTER TABLE signals ADD COLUMN plain_headline TEXT`);
} catch {}

export function getSetting(key: string, fallback: string): string {
  const row = db.query(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | null;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string) {
  db.query(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
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
