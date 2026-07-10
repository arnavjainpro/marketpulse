// On-demand deep-dive on a screener candidate: fuses the quantitative factors
// with recent news into a buy-worthiness assessment. User-initiated only —
// runs regardless of the live-updates toggle.
import Anthropic from "@anthropic-ai/sdk";
import type { Portfolio } from "../config";
import { db } from "../db";
import { fetchCompanyNews } from "../ingest/finnhub";
import { claudeQueue } from "./queue";
import { opusBreaker } from "./breaker";

const client = new Anthropic();

export async function analyzeCandidate(ticker: string, portfolio: Portfolio): Promise<string> {
  if (!opusBreaker.allow()) {
    return "⚠️ AI circuit breaker is tripped — reset it from the status bar.";
  }

  const row = db.query(`SELECT * FROM screener WHERE ticker = ?`).get(ticker) as any;
  if (!row) return `${ticker} is not in the screener universe — add it to config/screener.yaml and rescan.`;
  const ind = JSON.parse(row.indicators);

  const held = portfolio.holdings.find((h) => h.ticker === ticker);
  let headlines = "(news unavailable)";
  try {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
    const news = (await fetchCompanyNews(ticker, from, to)).slice(0, 8);
    headlines = news.map((n) => `- [${new Date(n.datetime * 1000).toISOString().slice(0, 10)}] ${n.headline} (${n.source})`).join("\n") || "(none in last 14 days)";
  } catch {}

  const positions = portfolio.holdings.map((h) => `${h.ticker} (${h.shares} sh)`).join(", ");

  const response = await claudeQueue(() =>
    client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      system: [
        {
          type: "text",
          text: `You are an equity scout evaluating whether a screened stock is genuinely worth buying for one self-directed investor. You receive quantitative factors (computed from real daily price history) and recent headlines. Weigh the factors against each other — a golden cross in a downtrend-recovery context differs from one at extended highs; momentum with expanding volume differs from momentum on fading volume. Verdict format (markdown): a one-line verdict (BUY CANDIDATE / WATCH / PASS + conviction), the 2-3 factors that matter most here, what the bear case is, a sensible entry approach if buy-worthy, and fit vs their existing portfolio (${positions || "no positions"}). Be honest about what quantitative screens cannot see (valuation, fundamentals beyond price). Decision support, not licensed financial advice.`,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            `CANDIDATE: ${ticker} — composite score ${row.score}/100`,
            ``,
            `QUANT FACTORS (from 1y of daily closes):`,
            `price=$${ind.price.toFixed(2)}  SMA50=$${ind.sma50.toFixed(2)}  SMA200=$${ind.sma200.toFixed(2)}  (${ind.pctVs200.toFixed(1)}% vs SMA200)`,
            `cross: ${ind.crossStatus} — ${ind.crossDetail || "no recent cross"}`,
            `RSI14(daily)=${ind.rsi14?.toFixed(0) ?? "n/a"}  MACD-hist=${ind.macdHist?.toFixed(3) ?? "n/a"}`,
            `momentum: 3m ${ind.mom3m.toFixed(1)}%  6m ${ind.mom6m.toFixed(1)}%`,
            `52-week position: ${ind.pct52w.toFixed(0)}/100  volume trend (20d/60d): ${ind.volTrend.toFixed(2)}x`,
            ``,
            `RECENT HEADLINES (14d):`,
            headlines,
            ``,
            held ? `NOTE: investor already holds ${held.shares} shares @ $${held.cost_basis}.` : `Investor does not currently hold ${ticker}.`,
          ].join("\n"),
        },
      ],
    })
  );

  return response.content.find((b) => b.type === "text")?.text ?? "(no answer)";
}
