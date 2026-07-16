// Trade-outcome journal: the trader logs how each closed trade actually went
// (win/loss, what went wrong, in their own words) and relevant history is fed
// back into future AI analysis as PROMPT CONTEXT — retrieval-augmented, not
// fine-tuning (Anthropic exposes no fine-tuning API for Claude, and at this
// scale a compact text block outperforms one anyway). Same "compact text block
// for AI prompts" pattern as accountContextText()/optionsContextText().
import { db } from "../db";

export interface TradeOutcome {
  id: number;
  ticker: string;
  direction: "long" | "short";
  idea_id: number | null;
  entry_price: number | null;
  exit_price: number | null;
  outcome: "win" | "loss" | "breakeven";
  pnl_pct: number | null;
  notes: string;
  closed_at: number;
}

export function logOutcome(
  userId: number,
  o: {
    ticker: string;
    direction: "long" | "short";
    outcome: "win" | "loss" | "breakeven";
    idea_id?: number | null;
    entry_price?: number | null;
    exit_price?: number | null;
    pnl_pct?: number | null;
    notes?: string;
    closed_at?: number;
  }
): number {
  const res = db
    .query(
      `INSERT INTO trade_outcomes (user_id, ticker, direction, idea_id, entry_price, exit_price, outcome, pnl_pct, notes, closed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch()) RETURNING id`
    )
    .get(
      userId, o.ticker.toUpperCase().trim(), o.direction, o.idea_id ?? null,
      o.entry_price ?? null, o.exit_price ?? null, o.outcome, o.pnl_pct ?? null,
      (o.notes ?? "").trim(), o.closed_at ?? Math.floor(Date.now() / 1000)
    ) as { id: number };
  return res.id;
}

export function listOutcomes(userId: number, limit = 50): TradeOutcome[] {
  return db
    .query(`SELECT id, ticker, direction, idea_id, entry_price, exit_price, outcome, pnl_pct, notes, closed_at FROM trade_outcomes WHERE user_id = ? ORDER BY closed_at DESC LIMIT ?`)
    .all(userId, limit) as TradeOutcome[];
}

export function deleteOutcome(userId: number, id: number): boolean {
  return db.query(`DELETE FROM trade_outcomes WHERE user_id = ? AND id = ?`).run(userId, id).changes > 0;
}

// Compact prompt block: the trader's last few outcomes overall plus every
// outcome on the specific ticker being analyzed ("I've lost on this exact name
// twice the same way" is the highest-value context). Capped small — roughly ten
// bullets — so it never bloats the prompt.
export function journalContextText(userId: number, ticker?: string): string {
  const recent = db
    .query(`SELECT * FROM trade_outcomes WHERE user_id = ? ORDER BY closed_at DESC LIMIT 5`)
    .all(userId) as TradeOutcome[];
  const forTicker = ticker
    ? (db
        .query(`SELECT * FROM trade_outcomes WHERE user_id = ? AND ticker = ? ORDER BY closed_at DESC LIMIT 5`)
        .all(userId, ticker.toUpperCase().trim()) as TradeOutcome[])
    : [];
  const seen = new Set<number>();
  const rows = [...forTicker, ...recent].filter((r) => !seen.has(r.id) && seen.add(r.id)).slice(0, 10);
  if (!rows.length) return "";

  const line = (r: TradeOutcome) => {
    const date = new Date(r.closed_at * 1000).toISOString().slice(0, 10);
    const pnl = r.pnl_pct != null ? ` (${r.pnl_pct >= 0 ? "+" : ""}${r.pnl_pct.toFixed(1)}%)` : "";
    const px = r.entry_price != null && r.exit_price != null ? ` $${r.entry_price}→$${r.exit_price}` : "";
    return `- ${r.ticker} ${r.direction}, closed ${date}: ${r.outcome.toUpperCase()}${pnl}${px}${r.notes ? `. Trader's notes: "${r.notes}"` : ""}`;
  };
  return [
    `TRADER'S PAST-TRADE JOURNAL (their own logged outcomes — real history, weigh it):`,
    ...rows.map(line),
  ].join("\n");
}
