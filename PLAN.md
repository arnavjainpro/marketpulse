# MarketPulse: Performance & Universe Expansion Plan (corrected scope)

<!-- /autoplan restore point: ~/.gstack/projects/marketpulse/vignesh-autoplan-restore-20260715-221025.md -->

Reviewed via /autoplan on 2026-07-15. Original plan corrected at the premise gate:
- DROPPED "Decouple Storage from AI Scanning" — already implemented (universe.ts upserts all ~7,000 feed rows; max_stocks only sets in_scan).
- DROPPED "Search Caching in server.ts" — already implemented (60s TTL cache in engine/ticker.ts).
- CORRECTED "/api/quotes is sequential" — it is parallel (Promise.all); the real pressure is 8 fetchQuote call sites sharing a 60/min budget.

## 1. Shared Quote Cache (`src/ingest/finnhub.ts`)

**Problem**: 8 call sites (`/api/quotes`, alerts ×2, detectors, advisor, briefing, intraday, validator, refreshDailyStats) each hit Finnhub `/quote` directly, sharing a 60 req/min budget with no dedup. Portfolio prices already stream over the WebSocket but are only written to SQLite bars, never reused for quotes.

**Design**:
- `quoteCache: Map<ticker, { quote: Quote; fetchedAt: number }>` in finnhub.ts.
- `cachedQuote(ticker)`: return cached quote if fresh (60s TTL); otherwise REST-fetch, store, return. All existing `fetchQuote` call sites switch to `cachedQuote`. Raw `fetchQuote` stays exported for the rare must-be-fresh path (refreshDailyStats can keep raw).
- WS patch: inside `startTradeStream`'s trade handler, if a cache entry exists for the symbol, patch `c` (last price), recompute `d`/`dp` from stored `pc`, and update `t`. Trades carry only price — `pc/h/l/o` stay from the last REST fetch, so entries still expire on TTL and re-fetch via REST to refresh those fields. No cache entry is *created* from a WS trade (a bare price with zeroed pc/d/dp would corrupt callers that read pc).
- Off-hours: WS is silent; TTL-based REST behaviour is unchanged. No special casing.

## 2. ETF Ingestion + Symbol Regex (`src/ingest/universe.ts`)

**Problem**: Universe pulls only `screener/stocks`; ETFs are absent from search, and the `^[A-Z]{1,5}$` filter drops preferred shares / class shares (BRK.B, BF.B, dotted/dashed symbols).

**Design**:
- Fetch `https://api.nasdaq.com/api/screener/etf?tableonly=true&limit=0&download=true` alongside the stocks feed (same headers/timeout; each feed failure independent — one failing must not kill the other). Map ETF rows into `UniverseRow` with `sector: "ETF"`, `industry: "ETF"`, `marketCap: 0` (feed has no cap), price/volume from `lastSalePrice`/`volume` fields (verify exact field names at implementation).
- ETFs are **stored, never scanned**: `in_scan = 0` always. Rationale: dollar-volume ranking would let SPY/QQQ/etc. crowd stocks out of the 1,500 scan slots, and the AI screener's scoring model is built for single names. Searchable via `/api/ticker` (which already scores anything with Yahoo candles).
- `sectorEtf("ETF")` falls through to "SPY" benchmark — already the correct behaviour, no change.
- Relax the stocks-feed regex to `^[A-Z]{1,5}([.-][A-Z])?$` (base symbol + optional one-letter class/preferred suffix), then normalize `.` → `-` on ingest for Yahoo compatibility. Keep excluding `^`-prefixed and unit/warrant garbage. Note: Finnhub uses dots (BRK.B) while Yahoo uses dashes (BRK-B); storage uses dashes (matches existing fetchSP500 convention), and the Finnhub call path converts `-` → `.` at request time for these symbols.

## 3. Search availability during scans (`src/engine/ticker.ts`) — APPROVED at gate (D4)

**Problem (found in review)**: `scoreTicker` returns 503 "Scan in progress" for the entire 10-12 min screener run, every 6 hours. Search is dead during it.

**Candidate fix**: serve stale cache entries during a scan (ignore TTL when `isScanRunning()`), and only 503 on a true cache miss. Two lines; no contention risk since it avoids the Yahoo fetch it was protecting against.

## Eng review amendments (Phase 3, both voices concur)

1. **Single-flight cache misses**: cache the in-flight `Promise<Quote>`, not just completed fetches; evict on rejection (a cached rejection would poison the ticker for 60s). Prevents `/api/quotes` × two tabs × alert loop each REST-fetching the same miss.
2. **Symbol-form boundary in finnhub.ts**: storage/cache keys are dash-form (`BRK-B`); Finnhub speaks dot-form (`BRK.B`). Add `toFinnhub()/fromFinnhub()` applied in `get()` (covers `/quote` and `/company-news`), in WS subscribe, and on `tr.s` receipt — fixing the same latent bug in `upsertBar` keying and WS subscription, not just the new cache path.
3. **Held ETFs keep scan coverage**: `in_scan = 0 for ETFs UNLESS protectedSet.has(ticker)`. Otherwise a held SPY loses the scan/score coverage it has today via the synthetic-row path.
4. **WS patch details**: quote `t` is unix seconds, trade `t` is milliseconds — convert. Guard `pc > 0` before recomputing `dp` (all-zero quotes yield Infinity).
5. **Normalize `.`→`-` before the `bySymbol` map build** in refreshUniverse, or feed-form and protected-set-form of the same symbol become duplicate rows.
6. **Feeds fetched independently** (no `Promise.all` that fails both); ETF response shape differs from stocks (`lastSalePrice` vs `lastsale`) — map defensively, log row counts per feed.

## Architecture (after change)

```
                      ┌────────────── finnhub.ts ──────────────┐
  WS trades (dot-form)│  fromFinnhub(tr.s) ─┐                  │
        ─────────────▶│                     ▼                  │
                      │   quoteCache: Map<dash-sym,            │
                      │     {promise|quote, fetchedAt}>        │
                      │       ▲ patch c/d/dp/t (TTL untouched) │
  REST /quote         │       │ miss → single-flight fetch     │
   (toFinnhub) ◀──────│───────┘        (60s TTL)               │
                      └───────▲──────────────▲─────────────────┘
        cachedQuote():        │              │
  server /api/quotes ─────────┤   alerts ×2 ─┤  detectors ─┤
  advisor ─ briefing ─ intraday ─ validator ─┘  (8 call sites)

  universe.ts: [stocks feed] + [etf feed]  (independent try/catch)
        └─ normalize .→-  → merge → protected-set → in_scan ranking
                                     (ETFs: in_scan=0 unless protected)
```

## Test plan (artifact: ~/.gstack/projects/marketpulse/vignesh-test-plan.md)

1. Single-flight: two concurrent `cachedQuote("AAPL")` → exactly 1 fetch; rejection evicts entry.
2. Round-trip: `cachedQuote("BRK-B")` requests `BRK.B`, caches under `BRK-B`; WS trade `s:"BRK.B"` patches that entry.
3. WS patch never creates entries; `d`/`dp` recomputed correctly; `pc=0` guarded; patched `t` in seconds.
4. Regex table: accept `BRK.B`, `BF.B`, `AAPL`; reject `.....`, `-A-B-`, `^SPX`, `ABCDE.FG`.
5. Feed independence: ETF fetch throws → stocks universe intact, and vice versa.
6. Held ETF: SPY in portfolio → `in_scan=1`; unheld SPY → `in_scan=0`.
7. Stale-serve: cache hit + scan running → 200 with stale data; true miss + scan running → 503.

## Failure modes registry

| Failure | Blast radius | Handling |
|---|---|---|
| Finnhub REST down | cachedQuote rejects | single-flight evicts; callers already try/catch |
| WS dead | cache stops patching | TTL forces REST refresh; existing watchdog reconnects |
| NASDAQ ETF feed breaks | ETFs missing from search | independent fetch; stocks unaffected; log row counts |
| NASDAQ stocks feed breaks | existing fallback path | unchanged (S&P500 + config fallback) |
| Bad symbol (all-zero quote) | dp = Infinity | pc>0 guard |

## NOT in scope
- `^`-form preferred shares (ABR^D etc., ~400 symbols) — cross-provider symbol mapping is inconsistent (Yahoo -P form vs Finnhub .PR form); wrong-form rows are worse than absent rows. Class shares (BRK/B → BRK-B) ARE ingested.
- Storage/scan decoupling — already exists.
- /api/ticker search cache — already exists.
- Delisted-symbol cleanup in `universe` table (upsert-only today; stale rows accumulate) — deferred to TODOS, storage-only impact.
- Replacing NASDAQ feeds with Finnhub `/stock/symbol` — rejected for now: Finnhub's symbol list lacks marketCap/volume/sector needed for scan filtering and sector boards. Revisit if NASDAQ blocks the UA.
- Frontend changes — search already queries the universe table; new rows appear automatically.

## What already exists (leverage map)
- Full-feed storage with `in_scan` flag: universe.ts refreshUniverse.
- 60s /api/ticker cache: engine/ticker.ts.
- WS trade stream + reconnect/watchdog: finnhub.ts startTradeStream.
- Dots→dashes normalization precedent: fetchSP500.
- Ticker validation allowing dots/dashes: engine/ticker.ts VALID regex.

## Decision Audit Trail

| # | Phase | Decision | Class | Principle | Rationale | Rejected |
|---|-------|----------|-------|-----------|-----------|----------|
| 1 | CEO | Drop storage-decoupling item | Mechanical | P4 (DRY) | Already implemented in universe.ts | Re-implementing existing code |
| 2 | CEO | Drop /api/ticker cache item | Mechanical | P4 (DRY) | 60s TTL cache exists in ticker.ts | Duplicate cache layer |
| 3 | CEO | Correct /api/quotes premise | Mechanical | — | Promise.all is parallel; reframed as shared-budget problem | — |
| 4 | CEO | Quote cache covers all 8 call sites, not just /api/quotes | Auto | P2 (boil lakes) | Same file, same root cause, < 1 day | Endpoint-only patch |
| 5 | CEO | WS never creates cache entries, only patches | Auto | P1 (completeness) | Bare-price entries would corrupt pc/d/dp readers | Trade-seeded entries |
| 6 | CEO | ETFs stored with in_scan=0 | Taste → gate | P5 | SPY/QQQ would crowd stocks out of scan ranking | ETFs scannable |
| 7 | CEO | Keep NASDAQ feeds over Finnhub /stock/symbol | Taste → gate | P3 | Finnhub list lacks cap/volume/sector metadata | Subagent preferred Finnhub |
| 8 | CEO | Regex `^[A-Z]{1,5}([.-][A-Z])?$` not `^[A-Z.\-]{1,6}$` | Auto | P1 | Plan's regex admits "....." and "-A-B-"; anchored form captures the target symbols only | Looser regex |
| 9 | CEO | Search-503 fix added as scope expansion | Taste → gate | P2 | Found in review; 2-line fix in blast radius | Leaving search dead 10 min/6 h |
| 10 | Phase-skip | Skip Design phase | Mechanical | — | No UI rendering terms in plan; backend-only | — |
| 11 | Phase-skip | Skip DX phase | Mechanical | — | Internal API consumed by own frontend; not a developer product | — |
| 12 | Eng | Single-flight promise cache | Auto | P1 | Concurrent misses burn the budget the plan exists to protect | Completed-fetch-only cache |
| 13 | Eng | Symbol conversion at finnhub.ts boundary (all paths) | Auto | P4/P2 | Fixes latent upsertBar + WS-subscribe bugs, not just new cache | Quote-path-only patch |
| 14 | Eng | ETFs in_scan=0 UNLESS protected | Auto | P1 | Held SPY must not lose existing scan coverage | Hard in_scan=0 |
| 15 | Eng | Convert trade-t ms→s; guard pc>0 | Auto | P1 | Unit mismatch + Infinity dp on zero quotes | — |
| 16 | Eng | Normalize .→- before map build | Auto | P1 | Prevents duplicate rows per symbol | Post-merge normalize |
| 17 | Eng | Independent feed fetches | Auto | P1 | Promise.all would let ETF breakage shrink stock universe ~1000 names | Combined fetch |
