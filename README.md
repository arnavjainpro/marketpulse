# MarketPulse

A personal investing advisor that watches the whole market for you. It scans the **entire S&P 500** (plus your holdings and watchlist) for buy setups, monitors your positions for material events in near-real-time, and turns everything into plain-English advice — with the full pro detail one tap away.

> ⚠️ Decision-support tool, not licensed financial advice. Every trade is your decision.

## What it does

- **Market screener (no AI cost):** every 6 hours, pulls a year of daily prices for ~508 stocks and computes golden/death crosses (formed *and* approaching, with ETA), RSI, MACD, 3/6-month momentum, price vs 200-day average, 52-week position, and volume trend — fused into a 0–100 score.
- **Live event monitoring (your stocks):** quotes/volume anomalies via Finnhub websocket + polling, SEC filings via EDGAR, company news, earnings surprises.
- **Two-tier AI:** Haiku triages every event for pennies; Opus writes a full signal (action, conviction, plain-English headline, thesis, invalidation, your exposure) only for events that matter.
- **Notifications only for advice:** you get a macOS/Telegram alert *only* when the AI says buy or sell — one plain sentence. No noise.
- **Simple UI, pro depth:** Robinhood-style dashboard — portfolio value, advice cards, your stocks, buying ideas, chat. Every row expands to show the quantitative detail (score, RSI, momentum, cross state) plus a "Get AI advice" button.
- **Cost controls:** "Live AI updates" toggle in the header stops all background token spend (monitoring continues, rule-based severity applies); circuit breakers hard-stop runaway AI calls; request queue throttles bursts.

## Setup

1. Free Finnhub key: https://finnhub.io
2. Anthropic API key: https://platform.claude.com (needs credits)
3. `cp .env.example .env` and fill both keys in
4. Put your real holdings in `config/portfolio.yaml` (add a one-line `thesis:` per holding — the AI judges events against it)
5. `bun install && bun start` → http://localhost:3000

Optional Telegram push: create a bot via @BotFather, get your chat id from @userinfobot, add both to `.env`.

## Config files

- `config/portfolio.yaml` — holdings (shares, cost basis, thesis) + watchlist. Held/watched tickers get real-time news/filing monitoring.
- `config/screener.yaml` — extra tickers scanned beyond the S&P 500 (which is fetched automatically).

## Architecture

```
S&P 500 daily candles (Yahoo) ─► screener: crosses/momentum/score ─► setup events
Finnhub ws+REST, SEC EDGAR    ─► detectors: news/filings/moves    ─► events
                     events ─► Haiku triage ─► Opus signal (buy/sell/hold + plain headline)
                            ─► dashboard (SSE) · notifications (buy/sell only) · SQLite
on-demand: advisor chat · per-stock AI deep-dive · daily briefings (9:00 / 16:15 ET)
```

## Notes

- First screener scan after boot takes ~3–4 minutes (508 tickers, rate-limited politely).
- Typical AI cost: ~$0.10–0.50/day with live updates on; $0 with the toggle off.
- Reset all history: delete `data/marketpulse.db`.
