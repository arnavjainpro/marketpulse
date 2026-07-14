// Broker resolution + cached snapshot. Priority: linked brokerage (Robinhood) >
// one-shot JSON import > portfolio.yaml. YAML theses are merged onto broker
// positions by ticker either way, so "why you own it" survives auto-linking.
import { loadPortfolio, loadRiskConfig, type Portfolio } from "../config";
import { yamlProvider, importProvider } from "./manual";
import { robinhoodProvider } from "./robinhood";
import type { BrokerSnapshot } from "./types";

// Priority: linked Robinhood > one-shot import > portfolio.yaml.
const providers = [robinhoodProvider, importProvider, yamlProvider];

let cached: BrokerSnapshot | null = null;
let inFlight: Promise<BrokerSnapshot> | null = null;

export async function refreshBroker(): Promise<BrokerSnapshot> {
  // Collapse concurrent refreshes (interval timer + user clicking Refresh).
  if (inFlight) return inFlight;
  inFlight = doRefresh().finally(() => { inFlight = null; });
  return inFlight;
}

async function doRefresh(): Promise<BrokerSnapshot> {
  for (const p of providers) {
    if (!p.available()) continue;
    try {
      const snap = await p.fetchSnapshot();
      // Merge YAML context: theses onto positions, watchlist union, equity fallback.
      if (p.name !== "manual") {
        const yaml = loadPortfolio();
        const theses = new Map(yaml.holdings.filter((h) => h.thesis).map((h) => [h.ticker, h.thesis!]));
        for (const h of snap.holdings) {
          const t = theses.get(h.ticker);
          if (t) h.thesis = t;
        }
        snap.watchlist = [...new Set([...snap.watchlist, ...yaml.watchlist])];
        if (snap.account.equity == null) snap.account.equity = loadRiskConfig().account_equity;
      }
      cached = snap;
      console.log(
        `[broker] snapshot via ${snap.source}: ${snap.holdings.length} positions, ${snap.watchlist.length} watched, ` +
        `${snap.openOrders.length} open orders${snap.account.equity != null ? `, equity $${snap.account.equity.toLocaleString()}` : ""}`
      );
      return snap;
    } catch (err) {
      console.error(`[broker] ${p.name} failed, trying next provider:`, err);
    }
  }
  // yamlProvider never throws, but keep a hard fallback anyway.
  cached = await yamlProvider.fetchSnapshot();
  return cached;
}

export function brokerSnapshot(): BrokerSnapshot | null {
  return cached;
}

// Sync portfolio view for everything that previously called loadPortfolio().
export function currentPortfolio(): Portfolio {
  if (cached) return { holdings: cached.holdings, watchlist: cached.watchlist };
  return loadPortfolio();
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
export function positionSizing(entry: number, stop: number): SizingPlan {
  const risk = loadRiskConfig();
  const equity = cached?.account.equity ?? risk.account_equity;
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
export function accountContextText(): string {
  if (!cached) return "ACCOUNT: no broker snapshot yet (manual YAML portfolio in use).";
  const a = cached.account;
  const lines = [
    `ACCOUNT (source: ${cached.source}, as of ${new Date(cached.asOf * 1000).toISOString().slice(0, 16)} UTC):`,
    `- equity: ${a.equity != null ? "$" + a.equity.toLocaleString() : "unknown"}, cash: ${a.cash != null ? "$" + a.cash.toLocaleString() : "unknown"}, buying power: ${a.buying_power != null ? "$" + a.buying_power.toLocaleString() : "unknown"}`,
  ];
  if (cached.openOrders.length) {
    lines.push(`- open orders: ${cached.openOrders.map((o) => `${o.side} ${o.qty} ${o.ticker} (${o.type}${o.limit_price ? ` @$${o.limit_price}` : ""})`).join("; ")}`);
  }
  return lines.join("\n");
}
