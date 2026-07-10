// Market-open and market-close portfolio briefings (Opus 4.8).
import Anthropic from "@anthropic-ai/sdk";
import type { Portfolio } from "../config";
import { db } from "../db";
import { fetchQuote } from "../ingest/finnhub";
import { allTickers } from "../config";
import { claudeQueue } from "./queue";

const client = new Anthropic();

export async function generateBriefing(kind: "open" | "close", portfolio: Portfolio): Promise<string> {
  // Gather current quotes + today's events/signals as raw material.
  const tickers = allTickers(portfolio);
  const quotes: string[] = [];
  for (const t of tickers) {
    try {
      const q = await fetchQuote(t);
      quotes.push(`${t}: $${q.c} (${q.dp >= 0 ? "+" : ""}${q.dp.toFixed(2)}% today)`);
    } catch {}
  }

  const since = Math.floor(Date.now() / 1000) - 24 * 3600;
  const events = db
    .query(`SELECT ticker, kind, title, severity FROM events WHERE ts > ? AND severity IN ('critical','high') ORDER BY ts DESC LIMIT 25`)
    .all(since) as { ticker: string; kind: string; title: string; severity: string }[];
  const signals = db
    .query(`SELECT ticker, action, conviction, thesis FROM signals WHERE ts > ? ORDER BY ts DESC LIMIT 10`)
    .all(since) as { ticker: string; action: string; conviction: string; thesis: string }[];

  const positions = portfolio.holdings
    .map((h) => `- ${h.ticker}: ${h.shares} shares @ $${h.cost_basis}`)
    .join("\n");

  const response = await claudeQueue(() => client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system: [
      {
        type: "text",
        text: `You write a concise ${kind === "open" ? "pre-market" : "end-of-day"} briefing for one self-directed investor. Lead with what matters most to their actual positions. Format as short markdown: a 2-3 sentence overview, then per-ticker bullets only where there is something worth saying, then "What to watch ${kind === "open" ? "today" : "tomorrow"}". No filler, no generic market commentary without a position link. This is decision support, not licensed financial advice.`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          `Portfolio:\n${positions || "(none)"}`,
          `Watchlist: ${portfolio.watchlist.join(", ") || "none"}`,
          ``,
          `Live quotes:\n${quotes.join("\n") || "unavailable"}`,
          ``,
          `Significant events (last 24h):\n${events.map((e) => `[${e.severity}] ${e.title}`).join("\n") || "none"}`,
          ``,
          `Recent AI signals:\n${signals.map((s) => `${s.ticker} ${s.action} (${s.conviction}): ${s.thesis}`).join("\n") || "none"}`,
        ].join("\n"),
      },
    ],
  }));

  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  db.query(`INSERT INTO briefings (ts, kind, content) VALUES (unixepoch(), ?, ?)`).run(kind, text);
  return text;
}
