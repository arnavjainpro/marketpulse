// Robinhood read-only brokerage adapter (UNOFFICIAL private API — Robinhood
// publishes no public API). Pulls equities, options, and crypto positions plus
// account equity into the common BrokerSnapshot. READ-ONLY: it never places or
// cancels orders. Tokens are obtained once via `bun run link:robinhood` and
// cached in the settings table; the running server only refreshes them.
//
// ponytail: the auth/challenge flow follows robin_stocks and cannot be tested
//   here (no live credentials). The data-fetch paths are deterministic against
//   documented endpoint shapes. If Robinhood's login workflow rejects the
//   password grant for an account, the linker reports it and the user falls
//   back to the existing manual import. Upgrade path: SnapTrade (official
//   Robinhood read access) drops in behind this same BrokerProvider interface.
import { getSetting, setSetting } from "../db";
import type { BrokerProvider, BrokerSnapshot, BrokerOrder } from "./types";
import type { Holding } from "../config";

const CLIENT_ID = "c82SH0WZOsabOXGP2sxqcj34FxkvfnWRZBKlBjFS"; // Robinhood's public iOS client id
const API = "https://api.robinhood.com";
const NUMMUS = "https://nummus.robinhood.com";
const UA = {
  "User-Agent": "Robinhood/8.30.0 (iPhone; iOS 16.0; Scale/3.00)",
  "Content-Type": "application/json",
  Accept: "application/json",
};

export interface RhAuth {
  access_token: string;
  refresh_token: string;
  device_token: string;
  expires_at: number; // unix seconds
}

export function loadAuth(): RhAuth | null {
  const raw = getSetting("robinhood_auth", "");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RhAuth;
  } catch {
    return null;
  }
}
export function saveAuth(a: RhAuth) {
  setSetting("robinhood_auth", JSON.stringify(a));
}
export function clearAuth() {
  setSetting("robinhood_auth", "");
}

export function newDeviceToken(): string {
  return crypto.randomUUID();
}

// Low-level token request — used by both the interactive linker and refresh.
export async function requestToken(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${API}/oauth2/token/`, {
    method: "POST",
    headers: UA,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// ── device-approval (Sheriff) workflow ───────────────────────────────────────
// Pre-auth JSON helpers (no bearer token yet).
async function pfPost(url: string, body: object): Promise<any> {
  const r = await fetch(url, { method: "POST", headers: UA, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  return r.json().catch(() => ({}));
}
async function pfGet(url: string): Promise<any> {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
  return r.json().catch(() => ({}));
}

// Complete Robinhood's modern device-approval workflow (robin_stocks-style).
// `ask` prompts for an SMS/email code when required; app-approval ("prompt")
// polls until the user taps Approve in the Robinhood app. Throws on failure so
// the linker can report it and fall back to manual import.
export async function validateSheriff(deviceToken: string, workflowId: string, ask: (q: string) => string): Promise<void> {
  const machine = await pfPost(`${API}/pathfinder/user_machine/`, { device_id: deviceToken, flow: "suv", input: { workflow_id: workflowId } });
  const machineId = machine?.id;
  if (!machineId) throw new Error(`no machine id from pathfinder (${JSON.stringify(machine).slice(0, 200)})`);
  const inquiriesUrl = `${API}/pathfinder/inquiries/${machineId}/user_view/`;

  const view = await pfGet(inquiriesUrl);
  const challenge = view?.type_context?.context?.sheriff_challenge;
  if (!challenge) {
    // Some accounts have nothing to challenge — just continue the workflow.
    await pfPost(inquiriesUrl, { sequence: 0, user_input: { status: "continue" } });
    return;
  }
  const challengeId = challenge.id;

  if (challenge.type === "prompt") {
    console.log("→ Approve the login in your Robinhood app (push notification). Waiting up to 5 min…");
    const statusUrl = `${API}/push/${challengeId}/get_prompts_status/`;
    let ok = false;
    for (let i = 0; i < 60; i++) {
      const s = await pfGet(statusUrl);
      if (s?.challenge_status === "validated") { ok = true; break; }
      await Bun.sleep(5_000);
    }
    if (!ok) throw new Error("app approval timed out");
  } else if (challenge.type === "sms" || challenge.type === "email") {
    const code = ask(`Enter the ${challenge.type} verification code Robinhood sent: `);
    await pfPost(`${API}/challenge/${challengeId}/respond/`, { response: code });
  } else {
    throw new Error(`unsupported challenge type "${challenge.type}"`);
  }

  // Advance the workflow now that the challenge is satisfied.
  await pfPost(inquiriesUrl, { sequence: 0, user_input: { status: "continue" } });
}

export function toAuth(json: any, deviceToken: string): RhAuth {
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    device_token: deviceToken,
    expires_at: Math.floor(Date.now() / 1000) + (json.expires_in ?? 86400) - 120,
  };
}

async function refreshAccess(a: RhAuth): Promise<RhAuth> {
  const { status, json } = await requestToken({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: a.refresh_token,
    scope: "internal",
    device_token: a.device_token,
    expires_in: 86400,
  });
  if (status !== 200 || !json.access_token) throw new Error(`robinhood token refresh failed (${status})`);
  const next = { ...toAuth(json, a.device_token), refresh_token: json.refresh_token ?? a.refresh_token };
  saveAuth(next);
  return next;
}

// ── authenticated GETs + pagination ─────────────────────────────────────────
let authHeader = "";
async function rhGet(url: string): Promise<any> {
  const res = await fetch(url, { headers: { ...UA, Authorization: authHeader }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401) throw Object.assign(new Error("robinhood 401"), { code: 401 });
  if (!res.ok) throw new Error(`robinhood GET ${url} → ${res.status}`);
  return res.json();
}
async function rhList(url: string): Promise<any[]> {
  const out: any[] = [];
  let next: string | null = url;
  while (next) {
    const page = await rhGet(next);
    out.push(...(page.results ?? []));
    next = page.next ?? null;
  }
  return out;
}

// Instrument-URL → symbol, cached (positions reference instruments by URL).
const symbolCache = new Map<string, string>();
async function instrumentSymbol(url: string): Promise<string> {
  if (symbolCache.has(url)) return symbolCache.get(url)!;
  const sym = String((await rhGet(url)).symbol ?? "").toUpperCase();
  symbolCache.set(url, sym);
  return sym;
}

async function pullSnapshot(): Promise<BrokerSnapshot> {
  const holdings: Holding[] = [];

  // Equities — priced by the app's existing quote feed, so no market_value here.
  const positions = await rhList(`${API}/positions/?nonzero=true`);
  for (const p of positions) {
    const qty = Number(p.quantity);
    if (!qty) continue;
    holdings.push({
      ticker: await instrumentSymbol(p.instrument),
      shares: qty,
      cost_basis: Number(p.average_buy_price) || 0,
      asset_class: "equity",
    });
  }

  // Options — carry their own market value (can't be quoted by ticker).
  const optPositions = await rhList(`${API}/options/positions/?nonzero=true`);
  for (const op of optPositions) {
    const qty = Number(op.quantity);
    if (!qty) continue;
    const inst = await rhGet(op.option);
    const sign = op.type === "short" ? -1 : 1;
    let mark = Number(op.average_price) / 100 || 0; // fallback to basis
    try {
      const md = await rhGet(`${API}/marketdata/options/?instruments=${encodeURIComponent(op.option)}`);
      const px = Number(md.results?.[0]?.adjusted_mark_price);
      if (px) mark = px;
    } catch {}
    holdings.push({
      ticker: `${op.chain_symbol} ${inst.expiration_date} ${Number(inst.strike_price).toFixed(0)}${inst.type === "call" ? "C" : "P"}`,
      shares: qty * sign,
      cost_basis: Number(op.average_price) / 100 || 0, // per-share premium paid
      asset_class: "option",
      market_value: sign * qty * mark * 100,
      option: {
        type: inst.type === "call" ? "call" : "put",
        strike: Number(inst.strike_price),
        expiry: String(inst.expiration_date),
        underlying: String(op.chain_symbol).toUpperCase(),
      },
    });
  }

  // Crypto — nummus holdings + forex mark price.
  try {
    const [cryptoHoldings, pairs] = await Promise.all([
      rhList(`${NUMMUS}/holdings/`),
      rhGet(`${NUMMUS}/currency_pairs/`).then((r) => r.results ?? []),
    ]);
    const pairId = new Map<string, string>(); // currency code → pair id
    for (const cp of pairs) pairId.set(String(cp.asset_currency?.code), String(cp.id));
    for (const h of cryptoHoldings) {
      const qty = Number(h.quantity);
      const code = String(h.currency?.code ?? "");
      if (!qty || !code) continue;
      let mark = 0;
      const id = pairId.get(code);
      if (id) {
        try {
          const q = await rhGet(`${API}/marketdata/forex/quotes/${id}/`);
          mark = Number(q.mark_price) || 0;
        } catch {}
      }
      const cost = (h.cost_bases ?? []).reduce((s: number, c: any) => s + Number(c.direct_cost_basis ?? 0), 0);
      holdings.push({
        ticker: `${code}-USD`,
        shares: qty,
        cost_basis: qty ? cost / qty : 0,
        asset_class: "crypto",
        market_value: mark ? qty * mark : cost,
      });
    }
  } catch {
    // crypto is optional — equities/options are the important part
  }

  // Account equity + open orders.
  let account = { equity: null as number | null, cash: null as number | null, buying_power: null as number | null };
  try {
    const portfolios = await rhList(`${API}/portfolios/`);
    const acc = (await rhList(`${API}/accounts/`))[0] ?? {};
    const pf = portfolios[0] ?? {};
    account = {
      equity: Number(pf.extended_hours_equity ?? pf.equity) || null,
      cash: Number(acc.portfolio_cash ?? acc.cash) || null,
      buying_power: Number(acc.buying_power) || null,
    };
  } catch {}

  const openOrders: BrokerOrder[] = [];
  try {
    const OPEN = new Set(["queued", "confirmed", "partially_filled", "unconfirmed", "pending"]);
    const orders = await rhList(`${API}/orders/`);
    for (const o of orders.slice(0, 100)) {
      if (!OPEN.has(String(o.state))) continue;
      openOrders.push({
        ticker: await instrumentSymbol(o.instrument),
        side: o.side === "sell" ? "sell" : "buy",
        qty: Number(o.quantity) || 0,
        type: String(o.type ?? "market"),
        limit_price: o.price != null ? Number(o.price) : null,
        status: String(o.state),
        submitted_at: String(o.created_at ?? new Date().toISOString()),
      });
    }
  } catch {}

  return {
    source: "robinhood",
    asOf: Math.floor(Date.now() / 1000),
    holdings,
    watchlist: [],
    openOrders,
    account,
  };
}

export const robinhoodProvider: BrokerProvider = {
  name: "robinhood",
  available: () => !!loadAuth(),
  async fetchSnapshot(): Promise<BrokerSnapshot> {
    let a = loadAuth();
    if (!a) throw new Error("robinhood not linked");
    if (Date.now() / 1000 >= a.expires_at) a = await refreshAccess(a);
    authHeader = `Bearer ${a.access_token}`;
    try {
      return await pullSnapshot();
    } catch (e: any) {
      // One re-auth attempt on 401, then let the provider loop fall through.
      if (e?.code === 401) {
        a = await refreshAccess(loadAuth()!);
        authHeader = `Bearer ${a.access_token}`;
        return await pullSnapshot();
      }
      throw e;
    }
  },
};
