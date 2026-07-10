// Classic indicators computed over 1-minute bars. Used as context for AI analysis.

export interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function macd(closes: number[]): { macd: number; signal: number; histogram: number } | null {
  if (closes.length < 35) return null;
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const macdLine = fast.map((v, i) => v - slow[i]);
  const signalLine = ema(macdLine.slice(25), 9);
  const m = macdLine[macdLine.length - 1];
  const s = signalLine[signalLine.length - 1];
  return { macd: m, signal: s, histogram: m - s };
}

export function vwap(bars: Bar[]): number | null {
  let pv = 0, vol = 0;
  for (const b of bars) {
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * b.volume;
    vol += b.volume;
  }
  return vol > 0 ? pv / vol : null;
}

// Rolling stats of 1-min returns for z-score anomaly detection.
export function returnStats(closes: number[]): { mean: number; std: number } | null {
  if (closes.length < 30) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return { mean, std: Math.sqrt(variance) };
}

export interface TechnicalSnapshot {
  price: number | null;
  rsi14: number | null;
  macdHistogram: number | null;
  sma20: number | null;
  vwap: number | null;
  sessionChangePct: number | null;
}

export function snapshot(bars: Bar[], prevClose: number | null): TechnicalSnapshot {
  const closes = bars.map((b) => b.close);
  const price = closes.at(-1) ?? null;
  const m = macd(closes);
  return {
    price,
    rsi14: rsi(closes),
    macdHistogram: m?.histogram ?? null,
    sma20: sma(closes, 20),
    vwap: vwap(bars),
    sessionChangePct:
      price != null && prevClose ? ((price - prevClose) / prevClose) * 100 : null,
  };
}
