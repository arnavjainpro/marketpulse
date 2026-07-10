import { db, aiLive, setAiLive } from "../db";
import { config, loadPortfolio, allTickers, marketPhase } from "../config";
import { fetchQuote, wsStatus } from "../ingest/finnhub";
import { opusBreaker, haikuBreaker } from "../ai/breaker";
import { askAdvisor, type ChatTurn } from "../ai/advisor";
import { analyzeCandidate } from "../ai/scout";
import { getScreenerRows } from "../engine/screener";
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

// ── HTTP server ──────────────────────────────────────────────────────────────
export function startServer() {
  const server = Bun.serve({
    port: config.port,
    idleTimeout: 0,
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
        const portfolio = loadPortfolio();
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
        return Response.json({
          portfolio, events, briefing, marketPhase: marketPhase(),
          aiLive: aiLive(),
          health: {
            ws: { ...wsStatus, staleSec: wsStatus.lastMessageAt ? Math.round((Date.now() - wsStatus.lastMessageAt) / 1000) : null },
            breakers: [opusBreaker.status(), haikuBreaker.status()],
          },
        });
      }

      // Ranked screener results (pure quant — no AI cost to view)
      if (url.pathname === "/api/screener") {
        return Response.json({ rows: getScreenerRows(loadPortfolio()) });
      }

      // On-demand AI deep-dive on one candidate (user-initiated, always allowed)
      if (url.pathname === "/api/screener/analyze" && req.method === "POST") {
        try {
          const body = (await req.json()) as { ticker?: string };
          const ticker = String(body.ticker ?? "").toUpperCase().trim();
          if (!ticker) return Response.json({ ok: false, error: "no ticker" }, { status: 400 });
          const answer = await analyzeCandidate(ticker, loadPortfolio());
          return Response.json({ ok: true, ticker, answer });
        } catch (err) {
          console.error("[server] screener analyze failed:", err);
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
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
          const answer = await askAdvisor(question, body.history ?? [], loadPortfolio());
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
        const portfolio = loadPortfolio();
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
