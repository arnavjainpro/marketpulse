// Full-market universe: every listed US stock with sector/industry/market-cap
// metadata from NASDAQ's screener feed (one request, ~7000 rows), filtered to a
// liquid, scannable subset. Replaces the old S&P-500-only universe: the scan now
// spans large/mid/small caps ranked by dollar volume, and every ticker carries a
// sector so ideas can be grouped and compared within their sector.
import { parse } from "yaml";
import { readFileSync } from "fs";
import { join } from "path";
import { db } from "../db";
import { loadUniverseFilters, allTickers, type Portfolio } from "../config";

export interface UniverseRow {
  ticker: string;
  name: string;
  sector: string;      // "Technology", "Finance", ... "Unknown" when the feed has none
  industry: string;
  marketCap: number;
  lastPrice: number;
  dayVolume: number;
  sp500: boolean;
  inScan: boolean;
}

// NASDAQ sector taxonomy → SPDR sector ETF used for relative-strength and rotation.
export const SECTOR_ETF: Record<string, string> = {
  Technology: "XLK",
  "Health Care": "XLV",
  Finance: "XLF",
  Energy: "XLE",
  Utilities: "XLU",
  "Basic Materials": "XLB",
  Industrials: "XLI",
  "Consumer Discretionary": "XLY",
  "Consumer Staples": "XLP",
  "Real Estate": "XLRE",
  Telecommunications: "XLC",
};
export const sectorEtf = (sector: string | null | undefined) => SECTOR_ETF[sector ?? ""] ?? "SPY";

const num = (s: any) => {
  const n = Number(String(s ?? "").replace(/[$,%]/g, "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

async function fetchNasdaqScreener(): Promise<UniverseRow[]> {
  const res = await fetch("https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=0&download=true", {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh) MarketPulse personal-use", Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`nasdaq screener ${res.status}`);
  const data = (await res.json()) as any;
  const rows: any[] = data?.data?.rows ?? [];
  return rows
    .filter((r) => /^[A-Z]{1,5}$/.test(r.symbol ?? "")) // plain common stock symbols; skips units/warrants/^/. classes
    .map((r) => ({
      ticker: r.symbol as string,
      name: String(r.name ?? "").replace(/ (Common|Class [A-Z]|Ordinary).*$/i, ""),
      sector: r.sector?.trim() || "Unknown",
      industry: r.industry?.trim() || "Unknown",
      marketCap: num(r.marketCap),
      lastPrice: num(r.lastsale),
      dayVolume: num(r.volume),
      sp500: false,
      inScan: false,
    }));
}

// Current S&P 500 constituents from a maintained public dataset. Yahoo uses
// dashes where the index uses dots (BRK.B → BRK-B).
export async function fetchSP500(): Promise<string[]> {
  try {
    const res = await fetch(
      "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv"
    );
    if (!res.ok) return [];
    const csv = await res.text();
    return csv
      .split("\n")
      .slice(1)
      .map((l) => l.split(",")[0]?.trim().toUpperCase() ?? "")
      .filter((t) => /^[A-Z.\-]{1,6}$/.test(t))
      .map((t) => t.replace(/\./g, "-"));
  } catch {
    return [];
  }
}

function extraTickersFromConfig(): string[] {
  try {
    const raw = parse(readFileSync(join(import.meta.dir, "../../config/screener.yaml"), "utf-8"));
    return (raw?.universe ?? []).map((t: any) => String(t).toUpperCase());
  } catch {
    return [];
  }
}

// Rebuild the universe table. Returns the active scan list (tickers).
// Selection: pass liquidity filters OR be an S&P 500 name OR be held/watched/config-listed;
// then rank by dollar volume and cap at max_stocks (protected names always kept).
export async function refreshUniverse(portfolio: Portfolio): Promise<string[]> {
  const filters = loadUniverseFilters();
  const [sp500, extras] = [await fetchSP500(), extraTickersFromConfig()];
  const protectedSet = new Set([...sp500, ...extras, ...allTickers(portfolio)]);

  let all: UniverseRow[] = [];
  try {
    all = await fetchNasdaqScreener();
    console.log(`[universe] NASDAQ feed: ${all.length} listed stocks`);
  } catch (err) {
    console.warn("[universe] NASDAQ feed failed — falling back to S&P 500 + config:", err);
  }

  const bySymbol = new Map(all.map((r) => [r.ticker, r]));
  // Protected names missing from the feed (dots→dashes classes etc.) still scan.
  for (const t of protectedSet) {
    if (!bySymbol.has(t)) {
      bySymbol.set(t, {
        ticker: t, name: t, sector: "Unknown", industry: "Unknown",
        marketCap: 0, lastPrice: 0, dayVolume: 0, sp500: false, inScan: false,
      });
    }
  }
  for (const t of sp500) {
    const r = bySymbol.get(t);
    if (r) r.sp500 = true;
  }

  const rows = [...bySymbol.values()];
  const passes = (r: UniverseRow) =>
    r.marketCap >= filters.min_market_cap &&
    r.lastPrice >= filters.min_price &&
    r.dayVolume >= filters.min_volume;

  const candidates = rows
    .filter((r) => protectedSet.has(r.ticker) || passes(r))
    .sort((a, b) => b.lastPrice * b.dayVolume - a.lastPrice * a.dayVolume);

  const scan = new Set<string>();
  for (const r of candidates) {
    if (scan.size >= filters.max_stocks && !protectedSet.has(r.ticker)) continue;
    scan.add(r.ticker);
  }
  for (const r of rows) r.inScan = scan.has(r.ticker);

  const upsert = db.query(
    `INSERT INTO universe (ticker, name, sector, industry, market_cap, last_price, day_volume, sp500, in_scan, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(ticker) DO UPDATE SET name=excluded.name, sector=excluded.sector, industry=excluded.industry,
       market_cap=excluded.market_cap, last_price=excluded.last_price, day_volume=excluded.day_volume,
       sp500=excluded.sp500, in_scan=excluded.in_scan, updated_at=excluded.updated_at`
  );
  const tx = db.transaction((items: UniverseRow[]) => {
    for (const r of items)
      upsert.run(r.ticker, r.name, r.sector, r.industry, r.marketCap, r.lastPrice, r.dayVolume, r.sp500 ? 1 : 0, r.inScan ? 1 : 0);
  });
  tx(rows);

  console.log(`[universe] scan universe: ${scan.size} tickers (filters: cap≥$${(filters.min_market_cap / 1e6).toFixed(0)}M, px≥$${filters.min_price}, vol≥${filters.min_volume / 1000}k, max ${filters.max_stocks})`);
  return [...scan];
}

export function scanUniverse(): string[] {
  return (db.query(`SELECT ticker FROM universe WHERE in_scan = 1`).all() as { ticker: string }[]).map((r) => r.ticker);
}

export function universeMeta(ticker: string): { name: string; sector: string; industry: string; marketCap: number } | null {
  const r = db.query(`SELECT name, sector, industry, market_cap FROM universe WHERE ticker = ?`).get(ticker) as any;
  return r ? { name: r.name, sector: r.sector ?? "Unknown", industry: r.industry ?? "Unknown", marketCap: r.market_cap ?? 0 } : null;
}

// ticker → sector for a set of tickers (screener rows join).
export function sectorMap(): Map<string, string> {
  const rows = db.query(`SELECT ticker, sector FROM universe`).all() as { ticker: string; sector: string | null }[];
  return new Map(rows.map((r) => [r.ticker, r.sector ?? "Unknown"]));
}
