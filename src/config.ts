import { parse } from "yaml";
import { readFileSync } from "fs";
import { join } from "path";

export interface Holding {
  ticker: string;
  shares: number;
  cost_basis: number;
  thesis?: string; // why you own it — lets the AI judge "thesis broken vs. just drifting"
}

export interface Portfolio {
  holdings: Holding[];
  watchlist: string[];
}

const ROOT = join(import.meta.dir, "..");

export function loadPortfolio(): Portfolio {
  const raw = parse(readFileSync(join(ROOT, "config/portfolio.yaml"), "utf-8"));
  const holdings: Holding[] = (raw.holdings ?? []).map((h: any) => ({
    ticker: String(h.ticker).toUpperCase(),
    shares: Number(h.shares),
    cost_basis: Number(h.cost_basis),
    ...(h.thesis ? { thesis: String(h.thesis) } : {}),
  }));
  const watchlist: string[] = (raw.watchlist ?? []).map((t: any) => String(t).toUpperCase());
  return { holdings, watchlist };
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
