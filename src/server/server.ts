import { db, aiLive, setAiLive, getSetting } from "../db";
import { config, marketPhase, nextMarketTransition } from "../config";
import { fetchQuote, wsStatus } from "../ingest/finnhub";
import { opusBreaker, haikuBreaker } from "../ai/breaker";
import { askAdvisor, type ChatTurn } from "../ai/advisor";
import { validateIdea, pickCandidates, recentIdeas, type IdeaReport } from "../ai/validator";
import { analyzeIntraday, manageTrade, type IntradayRequest, type FollowupRequest } from "../ai/intraday";
import { parseStrategy } from "../ai/strategy";
import { runBacktest, stressBacktest, walkForward, type StrategySpec } from "../engine/backtest";
import { fetchDailyCandles } from "../ingest/yahoo";
import { getScreenerRows, sectorBoards } from "../engine/screener";
import { getMarketSnapshot } from "../engine/market";
import { currentPortfolio, brokerSnapshot, refreshBroker } from "../broker";
import { saveImport, clearImport, type ImportPayload } from "../broker/manual";
import { allTickers } from "../config";
import { join } from "path";

// ── SSE hub ──────────────────────────────────────────────────────────────────
type SSEClient = { controller: ReadableStreamDefaultController; id: number };
const clients = new Map<number, SSEClient>();
let nextClientId = 1;

export function broadcast(type: string, payload: object) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const [id, c] of clients) {
    try {
      c.controller.enqueue(new TextEncoder().encode(msg));
    } catch {
      clients.delete(id);
    }
  }
}

// Hook for dev-only test event injection; wired up by index.ts.
export let onTestEvent: ((body: any) => Promise<void>) | null = null;
export function setTestEventHandler(fn: (body: any) => Promise<void>) {
  onTestEvent = fn;
}

// Hook for on-demand briefing generation; wired up by index.ts.
let onBriefingRequest: (() => Promise<string>) | null = null;
export function setBriefingHandler(fn: () => Promise<string>) {
  onBriefingRequest = fn;
}
let briefingInFlight = false;
let generateInFlight = false;

// ── HTTP server ──────────────────────────────────────────────────────────────
export function startServer() {
  const server = Bun.serve({
    port: config.port,
    idleTimeout: 0,
    maxRequestBodySize: 16 * 1024 * 1024, // chart screenshots
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(Bun.file(join(import.meta.dir, "public/index.html")));
      }

      if (url.pathname === "/api/stream") {
        const id = nextClientId++;
        const stream = new ReadableStream({
          start(controller) {
            clients.set(id, { controller, id });
            controller.enqueue(new TextEncoder().encode(`event: hello\ndata: {}\n\n`));
          },
          cancel() {
            clients.delete(id);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      if (url.pathname === "/api/state") {
        const portfolio = currentPortfolio();
        const events = db
          .query(
            `SELECT e.*, s.action, s.conviction, s.plain_headline, s.thesis, s.invalidation, s.portfolio_impact
             FROM events e LEFT JOIN signals s ON s.event_id = e.id
             ORDER BY e.ts DESC LIMIT 100`
          )
          .all();
        const briefing = db
          .query(`SELECT * FROM briefings ORDER BY ts DESC LIMIT 1`)
          .get();
        const broker = brokerSnapshot();
        return Response.json({
          portfolio, events, briefing, marketPhase: marketPhase(), marketClock: nextMarketTransition(),
          aiLive: aiLive(),
          broker: broker
            ? { source: broker.source, asOf: broker.asOf, account: broker.account, openOrders: broker.openOrders }
            : null,
          health: {
            ws: { ...wsStatus, staleSec: wsStatus.lastMessageAt ? Math.round((Date.now() - wsStatus.lastMessageAt) / 1000) : null },
            breakers: [opusBreaker.status(), haikuBreaker.status()],
          },
        });
      }

      // Ranked screener results (pure quant — no AI cost to view)
      if (url.pathname === "/api/screener") {
        return Response.json({ rows: getScreenerRows(currentPortfolio()) });
      }

      // Market regime + sector rotation + per-sector setup boards
      if (url.pathname === "/api/market") {
        return Response.json({
          snapshot: getMarketSnapshot(),
          boards: sectorBoards(currentPortfolio()),
        });
      }

      // Recent validated ideas (structured reports)
      if (url.pathname === "/api/ideas") {
        return Response.json({ ideas: recentIdeas(20) });
      }

      // Validate one idea — long, short, or auto (user-initiated, always allowed)
      if (url.pathname === "/api/ideas/validate" && req.method === "POST") {
        try {
          const body = (await req.json()) as { ticker?: string; direction?: string; notes?: string; options?: boolean };
          const ticker = String(body.ticker ?? "").toUpperCase().trim();
          if (!ticker) return Response.json({ ok: false, error: "no ticker" }, { status: 400 });
          const direction = body.direction === "long" || body.direction === "short" ? body.direction : "auto";
          const report = await validateIdea(ticker, direction, currentPortfolio(), {
            notes: body.notes, options: !!body.options, source: "validate",
          });
          if ("error" in report) return Response.json({ ok: false, error: report.error }, { status: 422 });
          return Response.json({ ok: true, report });
        } catch (err) {
          console.error("[server] validate failed:", err);
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      }

      // Batch idea generation: strongest confluences across sectors, both
      // directions, validated one by one (capped — this is the expensive path).
      if (url.pathname === "/api/ideas/generate" && req.method === "POST") {
        if (generateInFlight) return Response.json({ ok: false, error: "already generating" }, { status: 429 });
        generateInFlight = true;
        try {
          const body = (await req.json().catch(() => ({}))) as { count?: number };
          const count = Math.min(Math.max(Number(body.count ?? 4), 1), 6);
          const portfolio = currentPortfolio();
          const candidates = pickCandidates(portfolio, count);
          if (!candidates.length) {
            return Response.json({ ok: true, reports: [], note: "No setup-grade candidates in the latest scan (nothing scored ≥68 with a clear direction). That is a valid answer — don't force trades." });
          }
          const reports: IdeaReport[] = [];
          for (const c of candidates) {
            const r = await validateIdea(c.ticker, c.direction, portfolio, { source: "generate" });
            if (!("error" in r)) reports.push(r);
          }
          return Response.json({ ok: true, reports });
        } catch (err) {
          console.error("[server] generate failed:", err);
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        } finally {
          generateInFlight = false;
        }
      }

      // Intraday analyzer: ticker and/or chart screenshot → structured plan
      if (url.pathname === "/api/intraday/analyze" && req.method === "POST") {
        try {
          const body = (await req.json()) as IntradayRequest;
          const plan = await analyzeIntraday(body, currentPortfolio());
          if ("error" in plan) return Response.json({ ok: false, error: plan.error }, { status: 422 });
          return Response.json({ ok: true, plan });
        } catch (err) {
          console.error("[server] intraday failed:", err);
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      }

      // Backtest / walk-forward. Parses a described strategy (or reuses a spec
      // for free re-runs) then runs the deterministic engine — the AI never
      // computes results, only translates intent.
      if (url.pathname === "/api/backtest" && req.method === "POST") {
        try {
          const body = (await req.json()) as { ticker?: string; description?: string; spec?: StrategySpec; image?: string; walkForward?: boolean };
          const ticker = String(body.ticker ?? body.spec?.ticker ?? "").toUpperCase().trim();
          if (!ticker) return Response.json({ ok: false, error: "provide a ticker" }, { status: 400 });
          let spec = body.spec;
          if (!spec) {
            const parsed = await parseStrategy(ticker, body.description ?? "", body.image);
            if (parsed.error) return Response.json({ ok: false, error: parsed.error }, { status: 422 });
            if (parsed.clarification) return Response.json({ ok: true, clarification: parsed.clarification });
            spec = parsed.spec!;
          }
          spec.ticker = ticker;
          const candles = await fetchDailyCandles(ticker, "max", 250);
          if (!candles) return Response.json({ ok: false, error: `Not enough price history for ${ticker} (need ~1y+ of daily bars).` }, { status: 422 });
          const result = runBacktest(spec, candles);
          const stress = stressBacktest(result, candles);
          const years = (candles.timestamps.at(-1)! - candles.timestamps[0]) / (365.25 * 86400);
          let walkForwardResult = null, walkForwardError: string | null = null;
          if (body.walkForward) {
            if (years < 5) walkForwardError = `Walk-forward needs ~5y of history; ${ticker} has ${years.toFixed(1)}y. Showing the single-pass backtest only.`;
            else walkForwardResult = walkForward(spec, candles);
          }
          return Response.json({ ok: true, spec, result, stress, walkForward: walkForwardResult, walkForwardError, years: Math.round(years * 10) / 10 });
        } catch (err) {
          console.error("[server] backtest failed:", err);
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      }

      // In-trade management follow-up: prior plan + new screenshots + question
      if (url.pathname === "/api/intraday/followup" && req.method === "POST") {
        try {
          const body = (await req.json()) as FollowupRequest;
          const out = await manageTrade(body, currentPortfolio());
          if ("error" in out) return Response.json({ ok: false, error: out.error }, { status: 422 });
          return Response.json({ ok: true, answer: out.answer });
        } catch (err) {
          console.error("[server] followup failed:", err);
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      }

      // Broker status / refresh / manual import fallback
      if (url.pathname === "/api/broker/status") {
        const s = brokerSnapshot();
        return Response.json({
          snapshot: s ? { source: s.source, asOf: s.asOf, positions: s.holdings.length, watchlist: s.watchlist.length, openOrders: s.openOrders, account: s.account } : null,
          robinhoodLinked: !!getSetting("robinhood_auth", ""),
        });
      }
      if (url.pathname === "/api/broker/refresh" && req.method === "POST") {
        const snap = await refreshBroker();
        return Response.json({ ok: true, source: snap.source, positions: snap.holdings.length });
      }
      if (url.pathname === "/api/broker/import" && req.method === "POST") {
        try {
          const payload = (await req.json()) as ImportPayload;
          saveImport(payload);
          const snap = await refreshBroker();
          return Response.json({ ok: true, source: snap.source, positions: snap.holdings.length });
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 400 });
        }
      }
      if (url.pathname === "/api/broker/import/clear" && req.method === "POST") {
        clearImport();
        const snap = await refreshBroker();
        return Response.json({ ok: true, source: snap.source });
      }

      // Master switch for automatic AI spend (triage/analysis/scheduled briefings)
      if (url.pathname === "/api/ai-live" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { on?: boolean };
        setAiLive(!!body.on);
        console.log(`[ai] live updates ${body.on ? "ENABLED" : "PAUSED"} by user`);
        return Response.json({ ok: true, aiLive: aiLive() });
      }

      // Conversational advisor
      if (url.pathname === "/api/ask" && req.method === "POST") {
        try {
          const body = (await req.json()) as { question?: string; history?: ChatTurn[] };
          const question = String(body.question ?? "").trim();
          if (!question) return Response.json({ ok: false, error: "empty question" }, { status: 400 });
          const answer = await askAdvisor(question, body.history ?? [], currentPortfolio());
          return Response.json({ ok: true, answer });
        } catch (err) {
          console.error("[server] /api/ask failed:", err);
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      }

      // Reset a tripped circuit breaker
      if (url.pathname === "/api/breaker/reset" && req.method === "POST") {
        opusBreaker.reset();
        haikuBreaker.reset();
        return Response.json({ ok: true });
      }

      if (url.pathname === "/api/quotes") {
        const portfolio = currentPortfolio();
        const out: Record<string, any> = {};
        await Promise.all(
          allTickers(portfolio).map(async (t) => {
            try {
              out[t] = await fetchQuote(t);
            } catch {}
          })
        );
        return Response.json(out);
      }

      // On-demand briefing (also generated automatically at 9:00 / 16:15 ET).
      if (url.pathname === "/api/briefing" && req.method === "POST") {
        if (!onBriefingRequest) return new Response("pipeline not ready", { status: 503 });
        if (briefingInFlight) return Response.json({ ok: false, error: "already generating" }, { status: 429 });
        briefingInFlight = true;
        try {
          const content = await onBriefingRequest();
          return Response.json({ ok: true, content });
        } catch (err) {
          console.error("[server] briefing failed:", err);
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        } finally {
          briefingInFlight = false;
        }
      }

      // Dev-only: inject a synthetic event to exercise the full pipeline.
      if (url.pathname === "/api/test-event" && req.method === "POST") {
        if (!onTestEvent) return new Response("pipeline not ready", { status: 503 });
        const body = await req.json().catch(() => ({}));
        await onTestEvent(body);
        return Response.json({ ok: true });
      }

      return new Response("not found", { status: 404 });
    },
  });
  console.log(`[server] dashboard at http://localhost:${server.port}`);
  return server;
}
