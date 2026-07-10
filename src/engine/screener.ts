// Market screener: scans a configurable universe for buy setups using daily
// candles. Pure math — no AI tokens. Emits events into the pipeline only when
// a meaningful setup forms (golden cross formed/approaching, strong composite).
import { parse } from "yaml";
import { readFileSync } from "fs";
import { join } from "path";
import { db, insertEvent } from "../db";
import { fetchDailyCandles } from "../ingest/yahoo";
import { rsi, macd } from "./technicals";
import type { Portfolio } from "../config";
import { allTickers } from "../config";
import type { RawEvent } from "./detectors";

export interface Indicators {
  price: number;
  sma50: number;
  sma200: number;
  pctVs200: number;      // % above/below SMA200
  crossStatus: "golden_formed" | "golden_soon" | "death_formed" | "none";
  crossDetail: string;
  rsi14: number | null;
  macdHist: number | null;
  mom3m: number;         // % return over ~63 trading days
  mom6m: number;         // % return over ~126 trading days
  pct52w: number;        // 0 = at 52wk low, 100 = at 52wk high
  volTrend: number;      // 20d avg volume / 60d avg volume
  spark: number[];       // ~30 downsampled closes from the last 90 sessions (for UI line charts)
}

function downsample(values: number[], points: number): number[] {
  if (values.length <= points) return values.map((v) => Number(v.toFixed(2)));
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    out.push(Number(values[Math.floor((i / (points - 1)) * (values.length - 1))].toFixed(2)));
  }
  return out;
}

function smaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function computeIndicators(closes: number[], volumes: number[]): Indicators | null {
  const n = closes.length;
  if (n < 210) return null;
  const s50 = smaSeries(closes, 50);
  const s200 = smaSeries(closes, 200);
  const price = closes[n - 1];
  const sma50 = s50[n - 1]!;
  const sma200 = s200[n - 1]!;

  // Cross detection over the last 10 sessions
  let crossStatus: Indicators["crossStatus"] = "none";
  let crossDetail = "";
  for (let i = n - 10; i < n; i++) {
    if (s50[i - 1] == null || s200[i - 1] == null) continue;
    if (s50[i - 1]! <= s200[i - 1]! && s50[i]! > s200[i]!) {
      crossStatus = "golden_formed";
      crossDetail = `SMA50 crossed above SMA200 ${n - 1 - i} sessions ago`;
    } else if (s50[i - 1]! >= s200[i - 1]! && s50[i]! < s200[i]!) {
      crossStatus = "death_formed";
      crossDetail = `SMA50 crossed below SMA200 ${n - 1 - i} sessions ago`;
    }
  }
  // Approaching golden cross: SMA50 below but within 2% of SMA200 AND the gap
  // has been shrinking — linear extrapolation gives an ETA.
  if (crossStatus === "none" && sma50 < sma200) {
    const gapNow = (sma200 - sma50) / sma200;
    const gapPrev = (s200[n - 11]! - s50[n - 11]!) / s200[n - 11]!;
    if (gapNow > 0 && gapNow < 0.02 && gapPrev > gapNow) {
      const closingPerDay = (gapPrev - gapNow) / 10;
      const eta = Math.ceil(gapNow / closingPerDay);
      if (eta <= 20) {
        crossStatus = "golden_soon";
        crossDetail = `SMA50 is ${(gapNow * 100).toFixed(2)}% below SMA200, converging — est. cross in ~${eta} sessions`;
      }
    }
  }

  const hi52 = Math.max(...closes.slice(-252));
  const lo52 = Math.min(...closes.slice(-252));
  const vol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const vol60 = volumes.slice(-60).reduce((a, b) => a + b, 0) / 60;
  const m = macd(closes);

  return {
    price,
    sma50,
    sma200,
    pctVs200: ((price - sma200) / sma200) * 100,
    crossStatus,
    crossDetail,
    rsi14: rsi(closes),
    macdHist: m?.histogram ?? null,
    mom3m: ((price - closes[n - 64]) / closes[n - 64]) * 100,
    mom6m: ((price - closes[n - 127]) / closes[n - 127]) * 100,
    pct52w: hi52 > lo52 ? ((price - lo52) / (hi52 - lo52)) * 100 : 50,
    volTrend: vol60 > 0 ? vol20 / vol60 : 1,
    spark: downsample(closes.slice(-90), 30),
  };
}

// Composite 0–100: trend + cross + momentum + RSI regime + MACD + volume + 52wk position.
export function scoreIndicators(ind: Indicators): number {
  let s = 0;
  if (ind.price > ind.sma200) s += 15;
  if (ind.sma50 > ind.sma200) s += 12;
  if (ind.crossStatus === "golden_formed") s += 15;
  else if (ind.crossStatus === "golden_soon") s += 10;
  else if (ind.crossStatus === "death_formed") s -= 15;
  s += Math.max(-8, Math.min(12, ind.mom3m * 0.4));
  s += Math.max(-5, Math.min(8, ind.mom6m * 0.15));
  if (ind.rsi14 != null) {
    if (ind.rsi14 >= 45 && ind.rsi14 <= 65) s += 10;       // healthy uptrend regime
    else if (ind.rsi14 > 75) s -= 8;                        // overbought
    else if (ind.rsi14 < 30) s += 3;                        // washed out, mild contrarian credit
  }
  if (ind.macdHist != null && ind.macdHist > 0) s += 8;
  if (ind.volTrend > 1.15) s += 8;                          // volume expanding
  if (ind.pct52w > 85) s += 7;                              // strength near highs
  else if (ind.pct52w < 15) s -= 4;
  return Math.max(0, Math.min(100, Math.round(s + 25)));    // rebased so neutral ≈ 25-40
}

// Current S&P 500 constituents from a maintained public dataset. Yahoo uses
// dashes where the index uses dots (BRK.B → BRK-B).
async function fetchSP500(): Promise<string[]> {
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

export async function loadUniverse(portfolio: Portfolio): Promise<string[]> {
  let extras: string[] = [];
  try {
    const raw = parse(readFileSync(join(import.meta.dir, "../../config/screener.yaml"), "utf-8"));
    extras = (raw.universe ?? []).map((t: any) => String(t).toUpperCase());
  } catch (err) {
    console.error("[screener] failed to load config/screener.yaml:", err);
  }
  const sp500 = await fetchSP500();
  if (sp500.length) console.log(`[screener] S&P 500 constituents loaded: ${sp500.length}`);
  else console.warn("[screener] S&P 500 fetch failed — falling back to config universe only");
  return [...new Set([...sp500, ...extras, ...allTickers(portfolio)])];
}

export interface ScreenRow {
  ticker: string;
  score: number;
  cross_status: string;
  indicators: Indicators;
  updated_at: number;
  held: boolean;
}

export function getScreenerRows(portfolio: Portfolio): ScreenRow[] {
  const heldSet = new Set(portfolio.holdings.map((h) => h.ticker));
  const rows = db.query(`SELECT * FROM screener ORDER BY score DESC`).all() as any[];
  return rows.map((r) => ({
    ticker: r.ticker,
    score: r.score,
    cross_status: r.cross_status,
    indicators: JSON.parse(r.indicators),
    updated_at: r.updated_at,
    held: heldSet.has(r.ticker),
  }));
}

// Full universe scan. Returns pipeline events for newly-formed setups.
export async function runScan(portfolio: Portfolio): Promise<RawEvent[]> {
  const tickers = await loadUniverse(portfolio);
  const heldSet = new Set(portfolio.holdings.map((h) => h.ticker));
  console.log(`[screener] scanning ${tickers.length} tickers (~${Math.round((tickers.length * 0.4) / 60)} min)`);
  const events: RawEvent[] = [];
  let scanned = 0;

  for (const t of tickers) {
    const candles = await fetchDailyCandles(t);
    await Bun.sleep(180); // be polite to Yahoo
    if (scanned > 0 && scanned % 100 === 0) console.log(`[screener] progress: ${scanned}/${tickers.length}`);
    if (!candles) continue;
    const ind = computeIndicators(candles.closes, candles.volumes);
    if (!ind) continue;
    const score = scoreIndicators(ind);
    scanned++;

    db.query(
      `INSERT INTO screener (ticker, score, cross_status, indicators, updated_at)
       VALUES (?, ?, ?, ?, unixepoch())
       ON CONFLICT(ticker) DO UPDATE SET score=excluded.score, cross_status=excluded.cross_status,
         indicators=excluded.indicators, updated_at=excluded.updated_at`
    ).run(t, score, ind.crossStatus, JSON.stringify(ind));

    // Emit pipeline events for actionable setups (dedupe = one alert per state per week)
    const week = new Date().toISOString().slice(0, 10).slice(0, 8) + String(Math.ceil(new Date().getDate() / 7));
    const now = Math.floor(Date.now() / 1000);
    const emit = (kind: string, title: string, key: string) => {
      const id = insertEvent({ ts: now, ticker: t, kind, title, detail: { ...ind, score }, dedupeKey: key });
      if (id) events.push({ id, ts: now, ticker: t, kind, title, detail: { ...ind, score } });
    };
    if (ind.crossStatus === "golden_formed" && score >= 55) {
      emit("golden_cross", `${t} golden cross formed — ${ind.crossDetail} (score ${score})`, `gx:${t}:${week}`);
    } else if (ind.crossStatus === "golden_soon" && score >= 60) {
      emit("golden_cross", `${t} golden cross approaching — ${ind.crossDetail} (score ${score})`, `gxsoon:${t}:${week}`);
    } else if (ind.crossStatus === "death_formed" && heldSet.has(t)) {
      emit("death_cross", `${t} DEATH CROSS on a held position — ${ind.crossDetail}`, `dx:${t}:${week}`);
    }
    // With a ~500-stock universe, only the strongest composites become events.
    if (score >= 88) {
      emit("screener_pick", `${t} strong multi-factor buy setup (score ${score}/100)`, `pick:${t}:${week}`);
    }
  }
  console.log(`[screener] scan complete: ${scanned}/${tickers.length} scored, ${events.length} new setups`);
  return events;
}
