// Daily OHLCV history via Yahoo's public chart API — free, no key.
// Used by the screener for SMA50/SMA200 cross math (Finnhub free tier has no candles).

export interface DailyCandles {
  ticker: string;
  closes: number[];   // oldest → newest
  volumes: number[];
  timestamps: number[];
}

export async function fetchDailyCandles(ticker: string): Promise<DailyCandles | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh) MarketPulse personal-use" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const result = data?.chart?.result?.[0];
    if (!result?.timestamp) return null;
    const quote = result.indicators?.quote?.[0];
    const closes: number[] = [];
    const volumes: number[] = [];
    const timestamps: number[] = [];
    for (let i = 0; i < result.timestamp.length; i++) {
      const c = quote?.close?.[i];
      if (c == null) continue; // skip holiday/null rows
      closes.push(c);
      volumes.push(quote?.volume?.[i] ?? 0);
      timestamps.push(result.timestamp[i]);
    }
    if (closes.length < 210) return null; // need enough history for SMA200
    return { ticker, closes, volumes, timestamps };
  } catch {
    return null;
  }
}
