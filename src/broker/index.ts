// Broker resolution + cached snapshot. Priority: linked brokerage (Robinhood) >
// one-shot JSON import > portfolio.yaml. YAML theses are merged onto broker
// positions by ticker either way, so "why you own it" survives auto-linking.
import { loadPortfolio, loadRiskConfig, type Portfolio, type RiskConfig } from "../config";
import { getRiskPrefs } from "../db";
import { yamlProvider, importProvider } from "./manual";
import { robinhoodProvider } from "./robinhood";
import type { BrokerSnapshot } from "./types";

// Priority: linked Robinhood > one-shot import > portfolio.yaml.
const providers = [robinhoodProvider, importProvider, yamlProvider];

// Per-user cache — each signed-in user may have their own linked broker/import.
const cached = new Map<number, BrokerSnapshot>();
const inFlight = new Map<number, Promise<BrokerSnapshot>>();

export async function refreshBroker(userId: number): Promise<BrokerSnapshot> {
  // Collapse concurrent refreshes per user (interval timer + user clicking Refresh).
  const existing = inFlight.get(userId);
  if (existing) return existing;
  const p = doRefresh(userId).finally(() => { inFlight.delete(userId); });
  inFlight.set(userId, p);
  return p;
}

async function doRefresh(userId: number): Promise<BrokerSnapshot> {
  for (const p of providers) {
    if (!p.available(userId)) continue;
    try {
      const snap = await p.fetchSnapshot(userId);
      // Merge YAML context: theses onto positions, watchlist union, equity fallback.
      if (p.name !== "manual") {
        const yaml = loadPortfolio();
        const theses = new Map(yaml.holdings.filter((h) => h.thesis).map((h) => [h.ticker, h.thesis!]));
        for (const h of snap.holdings) {
          const t = theses.get(h.ticker);
          if (t) h.thesis = t;
        }
        snap.watchlist = [...new Set([...snap.watchlist, ...yaml.watchlist])];
        if (snap.account.equity == null) snap.account.equity = loadRiskConfigFor(userId).account_equity;
      }
      cached.set(userId, snap);
      console.log(
        `[broker] snapshot via ${snap.source} (user ${userId}): ${snap.holdings.length} positions, ${snap.watchlist.length} watched, ` +
        `${snap.openOrders.length} open orders${snap.account.equity != null ? `, equity $${snap.account.equity.toLocaleString()}` : ""}`
      );
      return snap;
    } catch (err) {
      console.error(`[broker] ${p.name} failed for user ${userId}, trying next provider:`, err);
    }
  }
  // yamlProvider never throws, but keep a hard fallback anyway.
  const snap = await yamlProvider.fetchSnapshot(userId);
  cached.set(userId, snap);
  return snap;
}

export function brokerSnapshot(userId: number): BrokerSnapshot | null {
  return cached.get(userId) ?? null;
}

// Sync portfolio view for everything that previously called loadPortfolio().
export function currentPortfolio(userId: number): Portfolio {
  const snap = cached.get(userId);
  if (snap) return { holdings: snap.holdings, watchlist: snap.watchlist };
  return loadPortfolio();
}

// Per-user risk settings (target R:R etc. layer on in a later phase), falling
// back to the shared portfolio.yaml risk: block until a user sets their own.
export function loadRiskConfigFor(userId: number): RiskConfig {
  const row = getRiskPrefs(userId);
  if (row) return row;
  return loadRiskConfig();
}

export interface SizingPlan {
  accountEquity: number | null;
  riskPct: number;            // max risk per trade, % of equity
  riskDollars: number | null; // dollars at risk between entry and stop
  shares: number | null;      // suggested share count
  notional: number | null;    // suggested position value
  cappedByPositionLimit: boolean;
  note: string;
}

// Risk-first position sizing: risk a fixed % of equity between entry and stop,
// capped by the max single-position share of the account.
export function positionSizing(userId: number, entry: number, stop: number): SizingPlan {
  const risk = loadRiskConfigFor(userId);
  const equity = cached.get(userId)?.account.equity ?? risk.account_equity;
  const perShareRisk = Math.abs(entry - stop);
  if (!equity || !perShareRisk || !Number.isFinite(perShareRisk)) {
    return {
      accountEquity: equity ?? null,
      riskPct: risk.max_risk_per_trade_pct,
      riskDollars: null, shares: null, notional: null, cappedByPositionLimit: false,
      note: equity
        ? "Stop distance unavailable — cannot size the trade."
        : "No account equity known (link a broker, import positions, or set risk.account_equity in portfolio.yaml) — express size as % risk instead of shares.",
    };
  }
  const riskDollars = (equity * risk.max_risk_per_trade_pct) / 100;
  let shares = Math.floor(riskDollars / perShareRisk);
  const maxNotional = (equity * risk.max_position_pct) / 100;
  let capped = false;
  if (shares * entry > maxNotional) {
    shares = Math.floor(maxNotional / entry);
    capped = true;
  }
  return {
    accountEquity: equity,
    riskPct: risk.max_risk_per_trade_pct,
    riskDollars: Math.round(riskDollars),
    shares: Math.max(0, shares),
    notional: Math.round(Math.max(0, shares) * entry),
    cappedByPositionLimit: capped,
    note: capped
      ? `Size capped by the ${risk.max_position_pct}% single-position limit.`
      : `Risks ~${risk.max_risk_per_trade_pct}% of equity if the stop is hit.`,
  };
}

// Compact text block for AI prompts.
export function accountContextText(userId: number): string {
  const snap = cached.get(userId);
  if (!snap) return "ACCOUNT: no broker snapshot yet (manual YAML portfolio in use).";
  const a = snap.account;
  const lines = [
    `ACCOUNT (source: ${snap.source}, as of ${new Date(snap.asOf * 1000).toISOString().slice(0, 16)} UTC):`,
    `- equity: ${a.equity != null ? "$" + a.equity.toLocaleString() : "unknown"}, cash: ${a.cash != null ? "$" + a.cash.toLocaleString() : "unknown"}, buying power: ${a.buying_power != null ? "$" + a.buying_power.toLocaleString() : "unknown"}`,
  ];
  if (snap.openOrders.length) {
    lines.push(`- open orders: ${snap.openOrders.map((o) => `${o.side} ${o.qty} ${o.ticker} (${o.type}${o.limit_price ? ` @$${o.limit_price}` : ""})`).join("; ")}`);
  }
  return lines.join("\n");
}
