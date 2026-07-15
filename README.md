# MarketPulse

A personal trading research and decision-support engine. It scans a **~1,500-stock liquid universe across the entire US market** (large/mid/small cap, sector-tagged) for both **long and short** setups, tracks **market regime and sector rotation**, validates every idea through a conservative multi-factor framework with **stress tests**, analyzes **intraday setups from chart screenshots or live data**, scores **any ticker you search** on demand — in the scanned universe or not — alongside its news, and turns everything into plain-English advice with the full pro detail one tap away. Set a price or score alert on anything you're watching.

> ⚠️ Decision-support tool, not licensed financial advice. Every trade is your decision.

## What it does

- **Full-market screener (no AI cost):** every 6 hours, pulls a year of daily prices for the filtered universe (market cap ≥ $300M, price ≥ $3, volume ≥ 300k — configurable) and computes trend structure, golden/death crosses, RSI, MACD, momentum, ATR, swing-pivot support/resistance, breakout/breakdown state with volume confirmation, relative strength vs sector ETF and SPY, and 60-day beta. Everything fuses into **separate 0–100 long and short scores** — momentum is capped so it can never dominate, and shorts are hard-capped below setup grade without confirmed structural breakdown.
- **Market regime + sector rotation (no AI cost):** trend-and-volatility regime with a risk-off flag, market breadth, and per-sector rotation states (leading / improving / weakening / lagging vs SPY) from the 11 SPDR sector ETFs. The Market tab shows the **real indices — Dow, S&P 500, Nasdaq, Russell 2000, plus VIX** — each one a click away from its TradingView chart. (The regime, relative-strength, and breadth math still runs on SPY/QQQ/IWM candles underneath; the indices are the display layer, not the inputs.) Ideas are presented **by sector**, and every AI judgment receives this context.
- **Idea validation (the core):** any ticker — screener candidate or your own idea, long or short — goes through one unified pipeline: deterministic evidence gathering (technicals, levels, RS, sector rotation, regime, 14-day news, earnings proximity, risk-first entry/stop/target frame, account-aware position sizing) → a deep-reasoning AI pass that scores six dimensions independently (technical, catalyst, market fit, news/sentiment, risk/reward, invalidation clarity), **stress-tests the idea** (base/bull/bear/failure cases + "does it survive risk-off?"), and rates it **strong / moderate / weak / reject** under a strict rubric. Weak setups get downgraded even if the chart looks exciting.
- **Intraday analyzer:** paste a chart screenshot and/or give a ticker + timeframe (1m/5m/15m/1h). It fetches live intraday bars, VWAP, opening range, relative volume, higher-timeframe structure, market tape, and same-day news, cross-checks the screenshot against real data, runs a 1-minute noise check (scalp vs momentum vs trend-continuation vs no-trade), and returns a full plan: entry zone, stop, targets, invalidation, holding period, confidence, R:R, exit-early conditions, and sizing. "No trade" is a first-class answer.
- **Options support:** every idea validation pulls the live chain (a strike ladder with bid/ask/IV per strike, ATM IV, implied move) and recommends calls/puts/spread/neutral/avoid with IV-crush and theta risk in plain terms.
- **Swing / options mode (Analyze tab):** upload 1-day / 1-week / 1-month candlestick charts (any subset) for a ticker — plus, optionally, a screenshot of your broker's options chain to price against those exact quotes. The model reads the multi-timeframe structure against live daily data and week-long news sentiment, then proposes a concrete **options structure** — strike, expiry, and spreads/straddles/strangles/iron condors chosen from the live strike ladder — whose **max loss, max gain, and breakevens are computed deterministically by a Black-Scholes engine** (spot × IV × time stress grid), never taken on the model's word.
- **In-trade management:** every analysis card has a follow-up chat — once you're in a position, ask "hit my first target, trim or hold?" and attach fresh screenshots. It re-pulls the current tape and answers against your original plan.
- **Backtest & walk-forward (Backtest tab):** describe a strategy in plain English (or upload a chart) — an AI translates it into a rule spec, and a deterministic engine backtests it on real daily candles with next-bar-open fills (no lookahead), then stress-tests it (worst historical window + 1,000-path Monte Carlo) and runs **anchored walk-forward validation**: grid-searches parameters on training windows only and reports **out-of-sample** results with a walk-forward-efficiency verdict, so you can tell a real edge from a curve-fit. Options backtests are model-priced (no historical option-quote feed exists) and labeled as such.
- **Brokerage integration:** link **Robinhood** (read-only — run `bun run link:robinhood` once) for live equities, options, and crypto positions with 60-second updates during market hours; or paste a JSON export from any broker in the Import panel. Priority: Robinhood > import > `portfolio.yaml` (the fallback). YAML theses merge onto broker positions. Read-only throughout — MarketPulse never places or cancels orders.
- **Search any ticker (⌘K / Ctrl-K):** type any symbol — in the scanned universe or not — and get its live price, **your** long/short score and direction verdict, a 90-day sparkline, and the last week of company news, with a one-click jump to the TradingView chart. Off-universe symbols are scored **on demand** by rerunning the same screener pipeline over a year of daily candles, so the number you see is the number the scanner would give it, not an approximation. Anything with under ~1 year of history returns price + news and says why it has no score instead of faking one.
- **Price & score alerts:** from any ticker's detail panel, set *price above / below X* or *score ≥ N* (score alerts test the **higher of the long and short score** — the strength of the setup in whichever direction it's leaning). Alerts ride the live detector cycle (~90s while the market is open, 5 min extended, 30 min closed) and fire **once**, on a genuine crossing — one you create while the condition is already true stays quiet until the value leaves and crosses back in, so you don't get an instant useless ping. Firing retires the alert; recreate it to re-arm. Up to 20 tickers under watch, and each one costs a Finnhub quote per cycle out of the same free-tier budget the event detectors use (20 alerts ≈ 22s of the ~90s cycle). Delivery is Telegram (see Setup).
- **Tabbed dashboard:** Portfolio · Market · Ideas · Analyze · Backtest · Chat · Activity, deep-linkable via URL hash, with unread badges on background tabs. Ideas group into a **collapsible sector tree** with metric filter toggles (above 200-day, volume rising, beating S&P, oversold RSI<35, score ≥ 70). **Dark/light theme** follows your OS by default; the header toggle overrides it. Your theme, active filters, and which sectors you collapsed persist across refreshes; expanded rows survive the 60-second live update (they reset on a page reload).
- **Live event monitoring:** quotes/volume anomalies via Finnhub websocket + polling, SEC filings via EDGAR, company news, earnings surprises — on your positions and watchlist, plus a 15-minute full-universe sweep that promotes any abnormal mover into live monitoring within minutes.
- **Two-tier AI:** Haiku triages every event for pennies; the deep model (Sonnet 5 by default — ~40% cheaper than Opus at near-Opus quality; override with `MARKETPULSE_MODEL_DEEP`) writes full signals only for events that matter. Notifications fire **only** for buy/sell advice.
- **Cost controls:** "Live AI updates" toggle stops all background token spend; circuit breakers hard-stop runaway AI calls; request queue throttles bursts. Screener, regime, rotation, and levels are pure math — $0.

## Setup

1. Free Finnhub key: https://finnhub.io
2. Anthropic API key: https://platform.claude.com (needs credits)
3. `cp .env.example .env` and fill both keys in
4. Put your real holdings in `config/portfolio.yaml` (or link Robinhood / use the Import panel) — add a one-line `thesis:` per holding and a `risk:` section for sizing
5. `bun install && bun start` → http://localhost:3000

**Telegram (required for alerts to reach you):** set `TELEGRAM_BOT_TOKEN` (bot via @BotFather) and `TELEGRAM_CHAT_ID` (from @userinfobot) in `.env`. Without it, price/score alerts still evaluate and fire correctly but have nowhere to land — the only other channel is a native macOS notification, which off macOS just fails and writes a `[notify:mac] failed:` line to the log on every delivery. Signals (buy/sell advice) use the same channel.

Optional: Robinhood link (`bun run link:robinhood` — read-only, stores tokens locally; complete the SMS code or approve the login in the Robinhood app when prompted). Robinhood has no official public API; this uses the same private endpoints robin_stocks does (including the device-approval workflow) and can break without notice — the app degrades to import/YAML if so.

## Config files

- `config/portfolio.yaml` — holdings (shares, cost basis, thesis), watchlist, and `risk:` (account equity fallback, max risk per trade %, max position %). Held/watched tickers get real-time news/filing monitoring.
- `config/screener.yaml` — universe `filters:` (min market cap / price / volume, max stocks) plus extra tickers to force into the scan.

## Architecture

```
NASDAQ full-market feed (~7000 stocks + sector/industry) ─► universe filter (~1500 liquid names)
Yahoo daily OHLCV ─► screener: long/short confluence scores, S/R, RS, beta ─► setup events
Yahoo benchmarks (SPY/QQQ/IWM/VIX + ^DJI/^GSPC/^IXIC/^RUT + 11 sector ETFs)
                    ─► regime + sector rotation + breadth   (math on SPY; indices are the display row)
Finnhub ws+REST, SEC EDGAR ─► detectors: news/filings/moves ─► events
                    events ─► Haiku triage ─► deep-model signal (regime-aware)
                    detector cycle (~90s open) ─► alert crossing check ─► Telegram (fire-once)
on-demand: idea validator (evidence → 6-dim scoring → stress tests → strong/moderate/weak/reject)
           ticker lookup ⌘K (any symbol → same screener pipeline → score + news; 60s cache,
                             backs off during a scan, never writes the screener table)
           intraday analyzer (screenshot + live bars + HTF + tape → plan or no-trade)
           options context (chain IV, implied move) · advisor chat · briefings (9:00/16:15 ET)
broker: Robinhood link > JSON import > portfolio.yaml ─► positions/orders/equity ─► risk-first sizing
                    ─► dashboard (SSE) · notifications (buy/sell only) · SQLite
```

## API surface (all local)

- `GET /api/market` — regime, benchmarks (incl. Dow/S&P/Nasdaq/Russell/VIX), sector rotation boards
- `GET /api/screener` — every scanned stock with long/short scores + indicators
- `GET /api/ticker?sym=AAPL` — on-demand score + indicators + week of news for **any** ticker, in the scan universe or not. Also accepts index symbols (`^GSPC`, `^DJI`, `^IXIC`, `^RUT`), which get scored but carry no news. 60s cache; returns 400 on a bad symbol, and 503 for an *uncached* symbol while a full scan is running (cached ones still serve)
- `GET /api/alerts` — every alert, active and fired
- `POST /api/alerts` `{ticker, kind: price_above|price_below|score_gte, threshold}` — create an alert (seeded so an already-true condition won't fire instantly)
- `DELETE /api/alerts?id=N` — delete an alert
- `POST /api/ideas/validate` `{ticker, direction?: long|short|auto, notes?, options?}` — full validation report
- `POST /api/ideas/generate` `{count?}` — validate the strongest sector-diversified setups (capped at 6)
- `POST /api/intraday/analyze` `{ticker?, timeframe?, image?, notes?, options?}` — intraday plan
- `GET /api/ideas` — recent validation reports
- `GET/POST /api/broker/*` — status, refresh, JSON import
- plus `/api/state`, `/api/quotes`, `/api/ask` (chat), `/api/briefing`, `/api/ai-live`, `/api/breaker/reset`

## Notes

- First full scan after boot takes ~15–30 minutes (1,500 tickers, rate-limited politely; shrink `filters.max_stocks` for faster passes). The market/sector view appears within ~1 minute.
- Typical AI cost: ~$0.10–0.50/day with live updates on; each idea validation or intraday analysis is a few cents (user-initiated).
- Shorting has costs this system does not model (borrow fees, locates, squeeze risk) — it flags the risk, you own the decision.
- Reset all history: delete `data/marketpulse.db`.
