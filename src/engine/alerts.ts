// Price / score alerts from the ticker detail panel.
//
// Crossing semantics: an alert stores the last observed value. It fires only on
// a false→true transition AFTER creation — an alert created while the condition
// is already true stays silent until the value dips out and crosses back in.
// This is why last_value is seeded at creation and persisted (survives restart).
// Fire-once: on firing, the alert deactivates (active=0); re-arm = re-create.
//
// Coverage: the detector loop (runDetectors) only fetches quotes for
// portfolio+watchlist+dynamic tickers, so the alert evaluator fetches quotes for
// ITS OWN distinct alert tickers (capped, paced). Score alerts read the screener
// table for scanned-universe tickers, and recompute off-universe tickers hourly
// through the cached /api/ticker path.
import { db } from "../db";
import { cachedQuote } from "../ingest/finnhub";
import { notifyTelegram, telegramEnabled } from "../notify/telegram";
import { notifyMac } from "../notify/macos";
import { scoreTicker } from "./ticker";

export type AlertKind = "price_above" | "price_below" | "score_gte";
export interface AlertRow {
  id: number;
  user_id: number;
  ticker: string;
  kind: AlertKind;
  threshold: number;
  last_value: number | null;
  active: number;
  created_ts: number;
  last_fired_ts: number | null;
}

export const MAX_ALERT_TICKERS = 20;
const OFF_UNIVERSE_RECOMPUTE_MS = 3_600_000; // hourly, per the eng review decision

// ── pure crossing logic (unit-tested by the self-check below) ──────────────────
export function conditionMet(kind: AlertKind, value: number, threshold: number): boolean {
  if (kind === "price_above" || kind === "score_gte") return value >= threshold;
  if (kind === "price_below") return value <= threshold;
  return false;
}
// Fire only when the condition flips false→true. A null prior (shouldn't happen
// post-seed) never fires — it just seeds on the next observation.
export function shouldFire(kind: AlertKind, prev: number | null, cur: number, threshold: number): boolean {
  if (prev == null) return false;
  return !conditionMet(kind, prev, threshold) && conditionMet(kind, cur, threshold);
}

// ── CRUD ───────────────────────────────────────────────────────────────────
function scoreFromScreener(ticker: string): number | null {
  const row = db.query(`SELECT score, long_score, short_score FROM screener WHERE ticker = ?`).get(ticker) as any;
  if (!row) return null;
  return Math.max(row.long_score ?? row.score ?? 0, row.short_score ?? 0);
}

export function listAlerts(userId: number): AlertRow[] {
  return db.query(`SELECT * FROM alerts WHERE user_id = ? ORDER BY active DESC, created_ts DESC`).all(userId) as AlertRow[];
}
export function deleteAlert(userId: number, id: number): void {
  db.query(`DELETE FROM alerts WHERE user_id = ? AND id = ?`).run(userId, id);
}
// Distinct alert tickers for one user (the per-user cap on how many they can watch).
export function activeAlertTickerCount(userId: number): number {
  return (db.query(`SELECT COUNT(DISTINCT ticker) n FROM alerts WHERE active = 1 AND user_id = ?`).get(userId) as any).n;
}

export async function createAlert(userId: number, rawTicker: string, kind: AlertKind, threshold: number): Promise<AlertRow> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!ticker) throw new Error("Ticker required");
  if (!["price_above", "price_below", "score_gte"].includes(kind)) throw new Error("Bad alert kind");
  if (!Number.isFinite(threshold)) throw new Error("Bad threshold");
  // Scores are 0-100. Without this, the UI's price-defaulted threshold box lets
  // you save "score >= 178.42", which reports success and can never fire.
  if (kind === "score_gte" && (threshold < 0 || threshold > 100)) {
    throw new Error("Score threshold must be between 0 and 100");
  }

  const isNewTicker = !(db.query(`SELECT 1 FROM alerts WHERE user_id = ? AND ticker = ? AND active = 1`).get(userId, ticker));
  if (isNewTicker && activeAlertTickerCount(userId) >= MAX_ALERT_TICKERS) {
    throw new Error(`Alert limit reached (${MAX_ALERT_TICKERS} tickers). Delete one first.`);
  }

  // Seed last_value with the current observation so an already-true condition
  // doesn't fire instantly.
  let seed: number | null = null;
  if (kind === "score_gte") seed = scoreFromScreener(ticker);
  else { try { const q = await cachedQuote(ticker); seed = q?.c ?? null; } catch { /* seed stays null */ } }

  db.query(
    `INSERT INTO alerts (user_id, ticker, kind, threshold, last_value, active, created_ts)
     VALUES (?, ?, ?, ?, ?, 1, unixepoch())
     ON CONFLICT(user_id, ticker, kind, threshold)
       DO UPDATE SET active = 1, last_value = excluded.last_value, last_fired_ts = NULL`
  ).run(userId, ticker, kind, threshold, seed);
  return db.query(`SELECT * FROM alerts WHERE user_id = ? AND ticker = ? AND kind = ? AND threshold = ?`).get(userId, ticker, kind, threshold) as AlertRow;
}

// ── evaluation (called from the detector loop) ───────────────────────────────
const lastOffUniverseEval = new Map<string, number>();

function alertMessage(a: AlertRow, cur: number): string {
  if (a.kind === "score_gte") return `📈 ${a.ticker} MarketPulse score crossed ${a.threshold} (now ${cur.toFixed(0)})`;
  const dir = a.kind === "price_above" ? "rose above" : "fell below";
  return `🔔 ${a.ticker} ${dir} $${a.threshold} (now $${cur.toFixed(2)})`;
}

async function deliver(text: string): Promise<void> {
  // Fire-and-forget from the caller's view (callers do not await). Failures are
  // logged, never thrown — a dead channel must not disarm the alert or crash the loop.
  // allSettled, not sequential awaits: a Telegram outage must not also swallow
  // the macOS notification. The alert is already deactivated by the time we get
  // here, so a lost notification is lost for good — try every channel.
  // Off macOS notifyMac shells osascript, fails, and logs [notify:mac] failed:
  // per delivery. It is NOT a silent no-op. Telegram is the real channel here.
  const results = await Promise.allSettled([
    telegramEnabled() ? notifyTelegram(text) : Promise.resolve(),
    notifyMac("MarketPulse alert", text),
  ]);
  for (const r of results) {
    if (r.status === "rejected") console.error("[alerts] notify failed:", r.reason);
  }
}

function processObservation(a: AlertRow, cur: number): void {
  if (shouldFire(a.kind, a.last_value, cur, a.threshold)) {
    db.query(`UPDATE alerts SET active = 0, last_value = ?, last_fired_ts = unixepoch() WHERE id = ?`).run(cur, a.id);
    console.log(`[alerts] FIRED #${a.id} ${a.ticker} ${a.kind} ${a.threshold} → ${cur}`);
    void deliver(alertMessage(a, cur));
  } else {
    db.query(`UPDATE alerts SET last_value = ? WHERE id = ?`).run(cur, a.id);
  }
}

export async function evaluateActiveAlerts(): Promise<void> {
  const alerts = db.query(`SELECT * FROM alerts WHERE active = 1`).all() as AlertRow[];
  if (!alerts.length) return;

  // Price alerts: fetch a quote for each distinct alert ticker (cap + 1.1s pace,
  // same Finnhub budget discipline as the detector loop).
  const priceAlerts = alerts.filter((a) => a.kind !== "score_gte");
  const priceTickers = [...new Set(priceAlerts.map((a) => a.ticker))].slice(0, MAX_ALERT_TICKERS);
  const prices = new Map<string, number>();
  for (const t of priceTickers) {
    try { const q = await cachedQuote(t); if (q && q.c > 0) prices.set(t, q.c); }
    catch (err) { console.error(`[alerts] quote ${t}:`, err); }
    await Bun.sleep(1100);
  }
  for (const a of priceAlerts) {
    const cur = prices.get(a.ticker);
    if (cur != null) processObservation(a, cur);
  }

  // Score alerts: universe rows are free (screener table); off-universe tickers
  // recompute at most hourly through the cached scoreTicker path.
  for (const a of alerts.filter((a) => a.kind === "score_gte")) {
    let score = scoreFromScreener(a.ticker);
    if (score == null) {
      const last = lastOffUniverseEval.get(a.ticker) ?? 0;
      if (Date.now() - last < OFF_UNIVERSE_RECOMPUTE_MS) continue;
      const out = await scoreTicker(a.ticker);
      // Only start the hourly clock once we actually got a score. scoreTicker
      // returns !ok for the whole scan window (~16 min every 6h), and stamping
      // before the call would skip this alert for an hour without ever checking it.
      if (!out.ok) continue;
      lastOffUniverseEval.set(a.ticker, Date.now());
      if (out.data.long_score != null) score = Math.max(out.data.long_score, out.data.short_score ?? 0);
    }
    if (score != null) processObservation(a, score);
  }
}

// ── self-check: `bun src/engine/alerts.ts` ───────────────────────────────────
if (import.meta.main) {
  const assert = (c: boolean, m: string) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };

  // crossing detection
  assert(!shouldFire("price_above", 95, 98, 100), "below→below: no fire");
  assert(shouldFire("price_above", 95, 105, 100), "cross up: fires");
  assert(!shouldFire("price_above", 105, 110, 100), "already-above: silent");
  assert(!shouldFire("price_above", null, 105, 100), "null prior: seeds, no fire");
  assert(shouldFire("price_below", 105, 95, 100), "price_below cross down: fires");
  assert(!shouldFire("price_below", 95, 90, 100), "already-below: silent");
  assert(shouldFire("score_gte", 55, 65, 60), "score cross up: fires");
  assert(!shouldFire("score_gte", 65, 70, 60), "score already-above: silent");

  // fire-once + created-while-true, over a synthetic series (mirrors processObservation state)
  const simulate = (kind: AlertKind, threshold: number, seed: number | null, series: number[]) => {
    let prev = seed, fires = 0, active = true;
    for (const cur of series) {
      if (!active) break;
      if (shouldFire(kind, prev, cur, threshold)) { fires++; active = false; }
      prev = cur;
    }
    return fires;
  };
  assert(simulate("price_above", 100, 95, [96, 98, 101, 105, 99, 102]) === 1, "fires once then deactivates");
  assert(simulate("price_above", 100, 105, [106, 108, 112]) === 0, "created-while-true stays silent");
  assert(simulate("price_above", 100, 105, [98, 96, 103]) === 1, "re-crosses after dipping out: fires");

  console.log("alerts self-check: OK");
}
