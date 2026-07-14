import { parse } from "yaml";
import { readFileSync } from "fs";
import { join } from "path";

export interface Holding {
  ticker: string;
  shares: number;       // shares; contracts for options; coin qty for crypto
  cost_basis: number;
  thesis?: string;      // why you own it — lets the AI judge "thesis broken vs. just drifting"
  asset_class?: "equity" | "option" | "crypto"; // default equity
  market_value?: number; // broker-provided current value — options/crypto can't be quoted by ticker
  option?: { type: "call" | "put"; strike: number; expiry: string; underlying: string };
}

export interface Portfolio {
  holdings: Holding[];
  watchlist: string[];
}

// Risk-management knobs (portfolio.yaml `risk:` section). account_equity is a
// fallback used for position sizing when no brokerage account is linked.
export interface RiskConfig {
  account_equity: number | null;
  max_risk_per_trade_pct: number; // % of equity risked between entry and stop
  max_position_pct: number;       // % of equity in any single position
}

const ROOT = join(import.meta.dir, "..");

function readPortfolioYaml(): any {
  return parse(readFileSync(join(ROOT, "config/portfolio.yaml"), "utf-8"));
}

export function loadPortfolio(): Portfolio {
  const raw = readPortfolioYaml();
  const holdings: Holding[] = (raw.holdings ?? []).map((h: any) => ({
    ticker: String(h.ticker).toUpperCase(),
    shares: Number(h.shares),
    cost_basis: Number(h.cost_basis),
    ...(h.thesis ? { thesis: String(h.thesis) } : {}),
  }));
  const watchlist: string[] = (raw.watchlist ?? []).map((t: any) => String(t).toUpperCase());
  return { holdings, watchlist };
}

export function loadRiskConfig(): RiskConfig {
  let raw: any = {};
  try {
    raw = readPortfolioYaml().risk ?? {};
  } catch {}
  return {
    account_equity: raw.account_equity != null ? Number(raw.account_equity) : null,
    max_risk_per_trade_pct: Number(raw.max_risk_per_trade_pct ?? 1),
    max_position_pct: Number(raw.max_position_pct ?? 20),
  };
}

// Universe filters (screener.yaml `filters:` section, env-overridable for tests).
export interface UniverseFilters {
  min_market_cap: number;
  min_price: number;
  min_volume: number;   // most recent session share volume
  max_stocks: number;   // cap, ranked by dollar volume (S&P 500 + portfolio always kept)
}

export function loadUniverseFilters(): UniverseFilters {
  let raw: any = {};
  try {
    raw = parse(readFileSync(join(ROOT, "config/screener.yaml"), "utf-8"))?.filters ?? {};
  } catch {}
  return {
    min_market_cap: Number(process.env.UNIVERSE_MIN_MCAP ?? raw.min_market_cap ?? 300_000_000),
    min_price: Number(process.env.UNIVERSE_MIN_PRICE ?? raw.min_price ?? 3),
    min_volume: Number(process.env.UNIVERSE_MIN_VOLUME ?? raw.min_volume ?? 300_000),
    max_stocks: Number(process.env.UNIVERSE_MAX_STOCKS ?? raw.max_stocks ?? 1500),
  };
}

export function allTickers(p: Portfolio): string[] {
  return [...new Set([...p.holdings.map((h) => h.ticker), ...p.watchlist])];
}

export const config = {
  finnhubKey: process.env.FINNHUB_API_KEY ?? "",
  port: Number(process.env.PORT ?? 3000),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? "",
  dbPath: join(ROOT, "data/marketpulse.db"),
  // Deep-reasoning model (analysis, validation, chat) and fast triage model.
  // Sonnet 5 is ~40% cheaper than Opus 4.8 ($3/$15 vs $5/$25 per 1M tokens) and
  // near-Opus quality on this kind of analysis. Override with MARKETPULSE_MODEL_DEEP.
  modelDeep: process.env.MARKETPULSE_MODEL_DEEP ?? "claude-sonnet-5",
  modelFast: process.env.MARKETPULSE_MODEL_FAST ?? "claude-haiku-4-5",
};

// Current Eastern Time components, extracted directly from Intl parts —
// no round-trip through a locale-string Date parse.
const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour12: false,
  weekday: "short",
  hour: "numeric",
  minute: "numeric",
});
const DAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function etNow(now = new Date()): { mins: number; day: number } {
  const parts = Object.fromEntries(
    ET_FMT.formatToParts(now).map((p) => [p.type, p.value])
  ) as Record<string, string>;
  // Intl may render midnight as "24" with hour12:false
  const hour = Number(parts.hour) % 24;
  return { mins: hour * 60 + Number(parts.minute), day: DAY_INDEX[parts.weekday] ?? 0 };
}

// US market hours in ET. Returns "open" | "extended" | "closed".
export function marketPhase(now = new Date()): "open" | "extended" | "closed" {
  const { mins, day } = etNow(now);
  if (day === 0 || day === 6) return "closed";
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "open";
  if (mins >= 4 * 60 && mins < 20 * 60) return "extended";
  return "closed";
}

// Next regular-session open/close as an absolute epoch (seconds). Boundaries are
// ET (9:30/16:00); the returned instant lets the client show them in local time.
// ponytail: delta off the ET wall clock, so it's off by an hour on the two
// DST-switch weekends per year — cosmetic label only.
export function nextMarketTransition(now = new Date()): { ts: number; kind: "open" | "close" } {
  const { mins, day } = etNow(now);
  const OPEN = 9 * 60 + 30, CLOSE = 16 * 60, DAY = 24 * 60;
  const nowSec = Math.floor(now.getTime() / 1000);
  if (day >= 1 && day <= 5 && mins >= OPEN && mins < CLOSE) {
    return { ts: nowSec + (CLOSE - mins) * 60, kind: "close" };
  }
  // Walk day-by-day to the next weekday open (skips evenings + weekends).
  let delta = 0, d = day, m = mins;
  for (let i = 0; i < 8; i++) {
    if (d >= 1 && d <= 5 && m <= OPEN) { delta += OPEN - m; break; }
    delta += DAY - m; // to next midnight ET
    m = 0;
    d = (d + 1) % 7;
  }
  return { ts: nowSec + delta * 60, kind: "open" };
}

if (import.meta.main) {
  // Self-check: transition kind + rough ordering at known ET wall-clock moments.
  const at = (iso: string) => nextMarketTransition(new Date(iso));
  const wed_open = at("2026-07-15T14:00:00Z"); // 10:00 ET Wed → in session
  const wed_pre = at("2026-07-15T12:00:00Z");  // 08:00 ET Wed → before open
  const fri_post = at("2026-07-17T21:00:00Z"); // 17:00 ET Fri → next open is Monday
  console.assert(wed_open.kind === "close", "in-session → close");
  console.assert(wed_pre.kind === "open", "pre-market → open");
  console.assert(fri_post.kind === "open" && fri_post.ts - Math.floor(Date.parse("2026-07-17T21:00:00Z") / 1000) > 2 * 86400, "fri post-close → Monday open (>2 days out)");
  console.log("nextMarketTransition self-check passed", { wed_open, wed_pre, fri_post });
}
