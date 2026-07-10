import { config, marketPhase } from "../config";
import { upsertBar, db } from "../db";

const BASE = "https://finnhub.io/api/v1";

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams({ ...params, token: config.finnhubKey });
  const res = await fetch(`${BASE}${path}?${qs}`);
  if (!res.ok) throw new Error(`Finnhub ${path} ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface Quote {
  c: number; // current
  d: number; // change
  dp: number; // percent change
  h: number; l: number; o: number;
  pc: number; // prev close
  t: number;
}

export const fetchQuote = (ticker: string) => get<Quote>("/quote", { symbol: ticker });

export interface NewsItem {
  id: number;
  datetime: number;
  headline: string;
  source: string;
  summary: string;
  url: string;
}

export function fetchCompanyNews(ticker: string, fromISO: string, toISO: string) {
  return get<NewsItem[]>("/company-news", { symbol: ticker, from: fromISO, to: toISO });
}

export interface EarningsEntry {
  date: string;
  symbol: string;
  epsActual: number | null;
  epsEstimate: number | null;
  revenueActual: number | null;
  revenueEstimate: number | null;
  hour: string;
}

export async function fetchEarningsCalendar(fromISO: string, toISO: string) {
  const res = await get<{ earningsCalendar: EarningsEntry[] }>("/calendar/earnings", {
    from: fromISO,
    to: toISO,
  });
  return res.earningsCalendar ?? [];
}

// Refresh per-ticker daily stats (prev close, 20d avg volume, 52wk range) from quote + stored bars.
export async function refreshDailyStats(ticker: string) {
  const q = await fetchQuote(ticker);
  const vol = db
    .query(
      `SELECT AVG(day_vol) as av FROM (
         SELECT SUM(volume) as day_vol FROM bars WHERE ticker = ?
         GROUP BY date(ts, 'unixepoch') ORDER BY date(ts, 'unixepoch') DESC LIMIT 20)`
    )
    .get(ticker) as { av: number | null };
  const existing = db
    .query(`SELECT week52_high, week52_low FROM daily_stats WHERE ticker = ?`)
    .get(ticker) as { week52_high: number; week52_low: number } | null;
  const hi = Math.max(existing?.week52_high ?? q.h, q.h);
  const lo = Math.min(existing?.week52_low ?? q.l, q.l);
  db.query(
    `INSERT INTO daily_stats (ticker, avg_volume_20d, prev_close, week52_high, week52_low, updated_at)
     VALUES (?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(ticker) DO UPDATE SET avg_volume_20d=excluded.avg_volume_20d,
       prev_close=excluded.prev_close, week52_high=excluded.week52_high,
       week52_low=excluded.week52_low, updated_at=excluded.updated_at`
  ).run(ticker, vol.av ?? 0, q.pc, hi, lo);
  return q;
}

// Live websocket health — exposed on /api/state so silent stalls become visible.
export const wsStatus = {
  connected: false,
  lastMessageAt: 0, // any inbound frame, including Finnhub's {"type":"ping"}
  reconnects: 0,
};

// Live trades websocket → aggregated into 1-minute bars.
// Resilience: exponential-backoff reconnect (5s → 120s cap) + a watchdog that
// force-recycles the socket if no frames arrive while the market is open —
// otherwise a silently-dead socket would leave SQLite bars stale and Opus
// analyzing news against stale technicals.
export function startTradeStream(tickers: string[], onTrade?: (t: { s: string; p: number; v: number; t: number }) => void) {
  let ws: WebSocket | null = null;
  let closedByUs = false;
  let backoffAttempt = 0;

  function connect() {
    ws = new WebSocket(`wss://ws.finnhub.io?token=${config.finnhubKey}`);
    ws.onopen = () => {
      wsStatus.connected = true;
      wsStatus.lastMessageAt = Date.now();
      console.log(`[finnhub] websocket connected, subscribing to ${tickers.length} tickers`);
      for (const t of tickers) ws!.send(JSON.stringify({ type: "subscribe", symbol: t }));
    };
    ws.onmessage = (msg) => {
      wsStatus.lastMessageAt = Date.now();
      backoffAttempt = 0; // stable traffic → reset backoff
      try {
        const data = JSON.parse(String(msg.data));
        if (data.type !== "trade") return; // pings etc. still count as liveness above
        for (const tr of data.data as { s: string; p: number; v: number; t: number }[]) {
          const tsMin = Math.floor(tr.t / 1000 / 60) * 60;
          upsertBar(tr.s, tsMin, tr.p, tr.p, tr.p, tr.p, tr.v);
          onTrade?.(tr);
        }
      } catch {}
    };
    ws.onclose = () => {
      wsStatus.connected = false;
      if (closedByUs) return;
      const delay = Math.min(5000 * 2 ** backoffAttempt, 120_000);
      backoffAttempt++;
      wsStatus.reconnects++;
      console.warn(`[finnhub] websocket closed, reconnecting in ${delay / 1000}s (attempt ${backoffAttempt})`);
      setTimeout(connect, delay);
    };
    ws.onerror = () => ws?.close();
  }

  // Watchdog: checks every 15s; if the socket claims to be open but nothing has
  // arrived for 60s during market hours (Finnhub pings every ~15-30s even when
  // trades are quiet), the connection is dead — force-close to trigger reconnect.
  // Skipped when the market is closed, where silence is normal.
  const watchdog = setInterval(() => {
    if (!wsStatus.connected || marketPhase() === "closed") return;
    if (Date.now() - wsStatus.lastMessageAt > 60_000) {
      console.warn("[finnhub] watchdog: no frames for 60s during market hours — recycling socket");
      ws?.close();
    }
  }, 15_000);

  connect();
  return () => {
    closedByUs = true;
    clearInterval(watchdog);
    ws?.close();
  };
}
