// Conversational advisor: answers ad-hoc questions ("should I trim NVDA?",
// "what's my biggest risk right now?") grounded in the live system state —
// portfolio, technicals, recent events, and its own past signals.
import Anthropic from "@anthropic-ai/sdk";
import { config, allTickers, type Portfolio } from "../config";
import { db, recentBars } from "../db";
import { snapshot } from "../engine/technicals";
import { marketContextText } from "../engine/market";
import { accountContextText } from "../broker";
import { cachedQuote, fetchCompanyNews } from "../ingest/finnhub";
import { claudeQueue } from "./queue";
import { opusBreaker } from "./breaker";

const client = new Anthropic();

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

// Stable persona — cached; volatile market context goes in the user turn.
function advisorSystemPrompt(portfolio: Portfolio): string {
  const positions = portfolio.holdings
    .map((h) => {
      let line = `- ${h.ticker}: ${h.shares} shares @ $${h.cost_basis} cost basis`;
      if (h.thesis) line += `\n  investor's thesis: ${h.thesis}`;
      return line;
    })
    .join("\n");
  return `You are MarketPulse, a personal equity advisor for one self-directed investor. You answer their questions directly and honestly, grounded in the live market context provided with each question.

Investor's portfolio:
${positions || "(no current positions)"}
Watchlist: ${portfolio.watchlist.join(", ") || "none"}

Rules:
- Ground every claim in the context provided. If the context doesn't contain what you'd need, say so plainly rather than guessing.
- When a position has a stated investor thesis, evaluate events and questions against it: distinguish "thesis broken" (sell case) from "price drifting but thesis intact" (hold case). If a position has no stated thesis, note that once and reason from fundamentals in the context.
- Be position-aware: quantify their actual exposure, unrealized P&L vs cost basis, and concentration when relevant.
- Give a clear recommendation when asked for one, with your conviction level and what would change your mind. Don't hedge into uselessness — but don't manufacture confidence the evidence doesn't support.
- Keep answers tight: lead with the answer, then the reasoning. Use short paragraphs or bullets.
- You are decision support for a self-directed investor, not licensed financial advice; be honest about uncertainty.`;
}

// Tickers the question is actually about — so we can pull fresh news for them
// without paying for headlines across the whole book on every question.
function tickersInQuestion(question: string, portfolio: Portfolio): string[] {
  const q = question.toUpperCase();
  return allTickers(portfolio).filter((t) => new RegExp(`\\b${t}\\b`).test(q));
}

async function buildMarketContext(portfolio: Portfolio, question: string): Promise<string> {
  const lines: string[] = [];

  lines.push(marketContextText(), "", accountContextText(), "");
  lines.push("CURRENT PRICES & TECHNICALS:");
  for (const t of allTickers(portfolio)) {
    const stats = db.query(`SELECT prev_close FROM daily_stats WHERE ticker = ?`).get(t) as { prev_close: number } | null;
    const tech = snapshot(recentBars(t, 120), stats?.prev_close ?? null);
    // Bars are empty when the market is quiet (overnight/weekends) — fall back to a REST quote.
    let price = tech.price;
    let chg = tech.sessionChangePct;
    if (price == null) {
      try {
        const q = await cachedQuote(t);
        price = q.c;
        chg = q.dp;
      } catch {}
    }
    lines.push(
      `${t}: price=$${price?.toFixed(2) ?? "n/a"} chg=${chg?.toFixed(2) ?? "n/a"}% RSI14=${tech.rsi14?.toFixed(0) ?? "n/a"} MACDh=${tech.macdHistogram?.toFixed(3) ?? "n/a"} VWAP=$${tech.vwap?.toFixed(2) ?? "n/a"}`
    );
  }

  // Fresh headlines (last 7 days) for tickers named in the question — fills the
  // gap where the local events table is empty or the app wasn't running.
  const asked = tickersInQuestion(question, portfolio);
  for (const t of asked.slice(0, 3)) {
    try {
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
      const news = (await fetchCompanyNews(t, from, to)).slice(0, 6);
      if (news.length) {
        lines.push("", `RECENT HEADLINES for ${t} (last 7 days, via Finnhub):`);
        for (const n of news) {
          lines.push(`- [${new Date(n.datetime * 1000).toISOString().slice(0, 10)}] ${n.headline} (${n.source})`);
        }
      }
    } catch {}
  }

  const since = Math.floor(Date.now() / 1000) - 72 * 3600;
  const events = db
    .query(
      `SELECT e.ts, e.ticker, e.kind, e.title, e.severity, s.action, s.conviction, s.thesis
       FROM events e LEFT JOIN signals s ON s.event_id = e.id
       WHERE e.ts > ? AND e.severity IN ('critical','high') ORDER BY e.ts DESC LIMIT 20`
    )
    .all(since) as any[];
  lines.push("", "SIGNIFICANT EVENTS + SIGNALS (last 72h):");
  if (events.length === 0) lines.push("(none)");
  for (const e of events) {
    let line = `- [${new Date(e.ts * 1000).toISOString().slice(0, 16)}] (${e.severity}) ${e.title}`;
    if (e.action) line += ` → signal: ${e.action} (${e.conviction})`;
    lines.push(line);
  }

  const briefing = db.query(`SELECT ts, kind, content FROM briefings ORDER BY ts DESC LIMIT 1`).get() as
    | { ts: number; kind: string; content: string }
    | null;
  if (briefing) {
    lines.push("", `LATEST BRIEFING (${briefing.kind}, ${new Date(briefing.ts * 1000).toISOString().slice(0, 16)}):`, briefing.content.slice(0, 2000));
  }

  return lines.join("\n");
}

export async function askAdvisor(
  question: string,
  history: ChatTurn[],
  portfolio: Portfolio
): Promise<string> {
  if (!opusBreaker.allow()) {
    return "⚠️ The AI circuit breaker is tripped (unusually high call volume was detected). Reset it from the dashboard status bar or restart the app.";
  }

  const trimmedHistory = history.slice(-10); // cap context growth
  const marketContext = await buildMarketContext(portfolio, question);
  const response = await claudeQueue(() =>
    client.messages.create({
      model: config.modelDeep,
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      system: [
        {
          type: "text",
          text: advisorSystemPrompt(portfolio),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        ...trimmedHistory,
        {
          role: "user",
          content: `${marketContext}\n\n---\nQUESTION: ${question}`,
        },
      ],
    })
  );

  return response.content.find((b) => b.type === "text")?.text ?? "(no answer)";
}
