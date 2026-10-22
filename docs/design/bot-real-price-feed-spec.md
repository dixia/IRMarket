# IRMarket Bot — Real Price Feed + SOXX Listing (Technical Specification)

> **Status:** Implemented on `feat/real-price-feed` (see `bot/price_feed.py`, `bot/verifier.py`, `bot/tests/test_price_feed.py`); enabled per-asset via `priceSource` in `deployment-assets.json` and gated by `PRICE_FEED_ENABLED=0` default.
> **Owner:** bot/ (verifier) · **Touches:** `bot/verifier.py`, `deployment-assets.json`,
> `script/deploy-market-stack.js`, `web/src/lib/assets.ts`, `web/.env.local*`.
>
> **Companion docs**
> - `bot/prd.md` — FR-BOT-001..004 (quoting / settlement quote / auto-settle / veto watch).
> - `bot/README.md` §Production Deployment — the existing TODO this spec resolves:
>   *"replace the static `PriceFeed` with a real feed"*.
> - `docs/prd.md` R22 — multi-asset demo (NVDA / GLM / SNDK / DEEPSEEK vs HKD).
> - `docs/architecture.md` §5/§7 — IRMarket **consumes** upstream Monoracle; oracle is an
>   input, never deployed by IRMarket scripts; per-pair vault model.
>
> **中文摘要（给快速阅读）**
> 目前 `bot/verifier.py` 的 `PriceFeed` 是**随机游走假数据**（以配置的 `fairPrice` 为基准 ±3% 抖动，
> 再夹到 ±20%）。本 spec 把它换成**真实免费行情源**，并按需登记新标的 **SOXX**（iShares 半导体 ETF）：
> - 已上市、可接真实源：**NVDA、SNDK、SOXX**（美股/ETF，走 Nasdaq 免密 JSON 接口）；
>   **GLM = 智谱 (Z.AI) 02513.HK**（港股，走新浪/腾讯免密行情接口，**本身即以 HKD 计价**）；
> - **DEEPSEEK 未上市**（私有公司）⇒ 无真实源，保留合成/冻结价并显式标注 `synthetic`。
> - 设计要点：`PriceSource` 抽象 + TTL 缓存 + 多源回退 + 陈旧兜底；保留 `feed.get(block)` 签名，
>   bot 主循环零改动。**关键坑**：现有 ±20% 夹取是相对静态 `fairPrice` 的，若真实价远离配置值
>   （例：SNDK 真实价 ≫ 配置 88）会被错误夹死 —— 真实源必须绕过该夹取。
> - 还补了 FX 口径（demo 的 "HKD" 目前直接当美元名义价，不做汇率换算）与限流/交易时段风险。

---

## 1. Goal & non-goals

### 1.1 Goal

1. Replace the synthetic random-walk `PriceFeed` with a **real, free, reasonably reliable**
   price source per asset, behind a small pluggable abstraction.
2. **Add SOXX** (iShares PHLX Semiconductor Sector ETF, NASDAQ) to IRMarket: token +
   market + assets registry + web metadata.
3. Refresh the configured price for the **already-listed** instruments (NVDA, SNDK, and
   GLM = Zhipu Technology / Z.AI, HKEX 02513.HK) so the canonical price tracks reality.
4. Keep the bot's on-chain behaviour (quote → settle → roll) **unchanged** — this is a
   data-source swap, not a protocol change.

### 1.2 Non-goals

- No change to Monoracle / IRMarket contracts, ABIs, or the veto semantics.
- No oracle deployment from IRMarket scripts (hard rule, `docs/architecture.md`).
- No production-grade market-data SLA. This is a hackathon/demo-grade feed with a clear
  upgrade path to a keyed provider (§11).
- No order-book / cross-venue aggregation, no latency arbitrage, no delta hedging.

---

## 2. Current state (as-is)

`bot/verifier.py:204` — `PriceFeed`:

```python
class PriceFeed:
    def __init__(self, fair_price: int):
        self.fair = int(fair_price); self.current = int(fair_price)
        self.jitter = int(os.getenv("PRICE_JITTER_BPS", "300")) / 10_000
    def get(self, _block: int) -> int:
        if self.jitter > 0:
            self.current = int(self.current * (1 + random.uniform(-self.jitter, self.jitter)))
            lo, hi = int(self.fair * 0.8), int(self.fair * 1.2)   # ±20% clamp vs STATIC base
            self.current = max(lo, min(hi, self.current))
        return self.current
```

Wiring & config:
- `MarketMakerBot.__init__` → `self.feed = PriceFeed(pair.fair_price)` (`bot/verifier.py:248`).
- Fair prices come from `deployment-assets.json` (`assets[].fairPrice`, 1e18 WAD) parsed by
  `load_asset_configs` (`bot/verifier.py:140`) into `PairConfig` (`bot/verifier.py:69`);
  legacy env fallback `MONITORED_PAIRS` (`bot/verifier.py:182`).
- Current registry (`deployment-assets.json`, gitignored, live values):

| symbol | fairPrice (WAD ≈ units) | kind |
|---|---|---|
| NVDA | 230 | US equity |
| GLM | 2.5 | ambiguous (see §12 D-A) |
| SNDK | 88 | US equity |
| DEEPSEEK | 45 | private, not listed |

The quote math is `quote_amount = quote_base * fair // E18` (`bot/verifier.py:384`), so the
feed must keep returning a **1e18 WAD integer**.

---

## 3. Asset inventory & source map

| symbol | underlying | listed? | source | symbol/id | notes |
|---|---|---|---|---|---|
| NVDA | NVIDIA Corp | ✅ NASDAQ: NVDA | `nasdaq` | `NVDA` | last sale |
| SNDK | SanDisk Corp | ✅ NASDAQ: SNDK | `nasdaq` | `SNDK` | last sale |
| **SOXX** | **iShares PHLX Semiconductor ETF** | ✅ NASDAQ (ETF) | `nasdaq` | `SOXX`, `assetclass=etf` | **new** |
| GLM | Zhipu Technology (Z.AI) | ✅ HKEX: 02513.HK | `sina` (fallback `tencent`) | `hk02513` | HKD-denominated already |
| DEEPSEEK | DeepSeek (private co.) | ❌ not listed | `synthetic` | — | keep walk/freeze; label synthetic |

GLM is **Zhipu Technology (Z.AI)**, the HK-listed 02513.HK — confirmed; live feed shows
`Z.AI … 518.000 HKD` (2026-10-16). It is quoted **natively in HKD**, so for this pair the
quote token and the feed unit finally agree (§5.4). The old `fairPrice` seed (2.5) is stale
and only serves as the synthetic/seed fallback. DEEPSEEK has **no** public market →
`synthetic` by construction (per the task: "Deepseek is not listed").

---

## 4. Feed source evaluation (live evidence, Oct 16 2026)

Probed from this environment:

| source | endpoint | result | verdict |
|---|---|---|---|
| **Nasdaq** (unofficial) | `GET https://api.nasdaq.com/api/quote/{SYM}/info?assetclass={stocks\|etf}` | SOXX `$514.71`, NVDA `$217.23`, SNDK `$1,394.83`; JSON with `lastTradeTimestamp`, `marketStatus`, `assetClass` | ✅ **primary for US equities/ETF** |
| **Sina** (unofficial) | `GET https://hq.sinajs.cn/list=hk02513` (needs `Referer: https://finance.sina.com.cn`) | `var hq_str_hk02513="Z.AI,…,518.000,…"` (HKD) | ✅ **primary for HK** |
| **Tencent** (unofficial) | `GET https://qt.gtimg.cn/q=hk02513` (needs `Referer: https://gu.qq.com`) | `v_hk02513="100~…~02513~518.000~…~HKD~…"` (HKD) | ✅ **HK fallback** |
| Yahoo Finance chart | `GET https://query1.finance.yahoo.com/v8/finance/chart/{SYM}` | US: first call ok then **404 (rate-limited)**; **HK `2513.HK` 404** | ⚠️ unreliable here |
| Stooq | `https://stooq.com/q/l/?s=…&e=csv` | 404 / anti-bot HTML | ❌ drop |

Nasdaq response shape (SOXX, live):

```json
{ "data": {
    "symbol": "SOXX",
    "companyName": "iShares PHLX SOX Semiconductor Sector Index Fund",
    "marketStatus": "Closed",
    "assetClass": "ETF",
    "primaryData": {
      "lastSalePrice": "$514.71",
      "lastTradeTimestamp": "Oct 15, 2026",
      "isRealTime": false
} } }
```

Parse paths:
- Nasdaq: `data.primaryData.lastSalePrice` → strip `$` and `,` → float.
- Sina: body `var hq_str_hk02513="name,cn,open,prevclose,high,low,last,chg,pct,…";` →
  comma-split, field **6** = last.
- Tencent: body `v_hk02513="100~name~02513~last~prevclose~open~…~HKD~…";` → `~`-split,
  field **3** = last; a later field carries the currency (`HKD`).

All are **key-less**. Nasdaq needs `Accept: application/json`; Sina/Tencent need a browser
`User-Agent` + `Referer` (a missing Referer yields an empty body). Sina/Tencent responses are
**GBK**-encoded for the company name — decode with `gbk`/`errors="replace"` (the numeric
fields are ASCII). Treat every source as **unofficial** — wrapped by cache + fallback (§5.3).

---

## 5. Design

### 5.1 Abstraction

Add a `PriceSource` protocol; keep `PriceFeed` (random walk) as one implementation so the
legacy/demo path is untouched.

```python
class PriceSource(Protocol):
    def fetch(self, block: int) -> int:      # returns 1e18 WAD
        ...
```

- `SyntheticWalkSource(fair_price, jitter_bps)` — factor the current `PriceFeed` body out;
  keeps the ±20%-of-static-base clamp. **Synthetic only.**
- `NasdaqSource(symbol, asset_class)` — `GET …/info`, parse `lastSalePrice`.
- `NebiusSource(symbol[, @region])` — Nebius spot (preemptible) GPU prices from
  the unauthenticated API behind `nebius.com/spot-prices` (issue #28):
  `GET https://api.nebius.cloud/billing/v1alpha1/spot-price` → `items[]`, match
  `productTitle` by GPU model (`B300`, `H200`, `RTX PRO 6000`, …), USD per
  GPU-hour; unpinned = lowest across regions, `@region` pins one.
- `SinaSource(code)` — `GET https://hq.sinajs.cn/list={market}{code}`; `market` ∈
  `hk|sh|sz` (bare code ⇒ `hk`). Last price is field **6** for HK, field **3** for
  A-shares (`sh`/`sz`).
- `TencentSource(code)` — `GET https://qt.gtimg.cn/q={market}{code}`, parse field 3
  (last) for both HK and A-shares. `SinaHKSource`/`TencentHKSource` remain as aliases.
- `FallbackSource([s1, s2, …])` — try each; first success wins.
- `CachedSource(inner, ttl_seconds, max_staleness_seconds, seed_wad, outage_policy)` — TTL
  cache + last-good value + staleness guard (below).

Factory:

```python
def build_feed(pair: PairConfig, logger: Optional[logging.Logger] = None) -> PriceSource:
    # PRICE_FEED_ENABLED != "1" (or synthetic/unknown/missing-symbol source) → synthetic
    ...
```

`MarketMakerBot.__init__` changes one line to `self.feed = build_feed(pair, logger=log)`; the main
loop keeps calling `self.feed.get(block)`. **No other bot changes required** — except the
outage policy below (quote refusal).

### 5.2 Unit & scale

- Feed returns a `float` price (USD for US names, HKD for GLM); convert to WAD via
  `Decimal` half-up quantization (`Decimal(str(price)).quantize(1e-18-ish)` → int WAD —
  implemented, slightly better than `int(round(price * 1e18))` for float-precision edge cases).
- Parse must reject non-finite / `N/A` / empty and fall through the fallback chain.
- Keep the value an `int` WAD — the quote math (`quote_base * fair // E18`) is unchanged.

### 5.3 Cache, freshness, fallback

```
request ─▶ CachedSource
             ├─ fresh (age < ttl)      → return cached
             ├─ refetch stale (ttl ≤ age): success → update cache; error → fall through
             ├─ error on all sources, last-good fresh-enough (age < max)
             |                          → return last-good + log WARNING (stale)
             └─ total outage (no last-good, or age ≥ max) → outage policy:
                  halt  → raise FeedOutageError; the bot does NOT quote this tick
                  seed  → legacy: fairPrice seed + log ERROR
                  (a zero/absent seed raises under BOTH policies)
```

- `ttl_seconds` default **60** — one fetch/min/asset; never fetch on every 5 s quote loop
  (rate-limit safety across 4–5 pairs). Also the **retry-throttle window**: `age` tracks the
  last *successful* fetch, so during an outage it stays ≥ ttl forever — without a separate
  `_last_attempt_at` guard every poll (and every ~0.4 s near-expiry tick) would hit the
  network, i.e. a 429 storm that prolongs the outage. At most one fetch attempt per TTL
  window; throttled ticks return last-good (or apply the outage policy) with no request.
- `max_staleness_seconds` default **3600**; beyond it the outage policy applies.
- **Outage policy (`PRICE_FEED_OUTAGE_POLICY`) default `halt`** (review feedback on PR #21):
  falling back to a `fairPrice` seed that is 15x off reality (SNDK 88 vs ≈1,394) makes the
  mark instantly veto-arbitraged. So the bot **refuses to quote** while no usable real price
  exists. `bot/verifier.py`: `submit_quote` catches `FeedOutageError` and skips the quote
  (loop retries next tick); `watch_vetoes` withdraws anyway (withdrawal doesn't need a mark)
  but reports PnL as unavailable. Use `seed` only after refreshing `fairPrice` to real values.
- `marketStatus == "Closed"` (equities) is **not** an error: the last sale is a valid
  (frozen) mark; log at DEBUG + record `lastTradeTimestamp` so the demo can explain a
  non-moving price.
- Fallback chain per asset: equities `nasdaq → yahoo → last-good → halt`; CN
  (HK + A-shares) `sina → tencent → last-good → halt` (`hk02513`, `sh600519`,
  `sz000001`, …); GPU spot `nebius → last-good → halt` (single endpoint — no
  secondary source); under `seed` policy the chain ends at the seed.

### 5.4 FX (quote unit)

Demo convention: the quote token is named "HKD". For **GLM/02513.HK the feed is already HKD**,
so it is exactly right with no conversion. For the US names (NVDA/SNDK/SOXX) the canonical
price is currently the raw **USD** number (handoff shows `225.63 HKD/NVDA` while NVDA ≈ $217),
i.e. the label is nominal. This spec **preserves** that (US factor = 1.0) but isolates it
behind one per-asset `FX_QUOTE_PER_USD` (default `1.0`) so the US names can be converted to
true HKD (≈ 7.8) later without touching adapters. Note the tradeoff: converting US names makes
all pairs consistently HKD (matching GLM) but changes the current on-screen marks — see §12 D-B.

A-shares (`sh`/`sz`) are quoted in **CNY**; the demo treats them the same nominal way (factor
`1.0`, global USD factor ignored), so `MOUTAI` shows its raw CNY number as "HKD".

### 5.5 Do NOT clamp real feeds

The ±20%-of-`fairPrice` clamp in `SyntheticWalkSource` would silently break real feeds whose
price is far from the static seed (SNDK live ≈ 1,394 vs seed 88 → clamped to 105.6). Real
sources **bypass the clamp**; instead apply a **sanity band** on the WAD result (reject
`≤ 0` or `> PRICE_SANITY_MAX`, default `1e9` units) and reject implausible jumps
(`> PRICE_MAX_JUMP_BPS`, default 5000 = 50%) with a WARNING **without** discarding the value
(the veto market needs the true mark; a jump is information, not an error).

---

## 6. Config schema

### 6.1 Asset registry (`deployment-assets.json`) — additive fields

```json
{
  "symbol": "SOXX",
  "baseToken": "0x…",
  "quoteToken": "0x36448Ef080ba5fa251e1a9bd61782786f9e24F04",
  "fairPrice": "514000000000000000000",
  "marketId": "5",
  "expiryBlock": "70995510",
  "priceSource": "nasdaq",
  "priceSymbol": "SOXX",
  "assetClass": "etf",
  "fxQuotePerUsd": 1.0
}
```

Existing entries gain two fields (`priceSource`, `priceSymbol`; `assetClass` defaults to
`stocks`). Unknown `priceSource` ⇒ `synthetic`. GLM entry: `"priceSource": "sina",
"priceSymbol": "hk02513"` (fallback `tencent`). DEEPSEEK entry: `"priceSource": "synthetic"`.

### 6.2 Env (`bot/.env.example`)

| var | default | meaning |
|---|---|---|
| `PRICE_FEED_ENABLED` | `0` | master switch; `0` = current synthetic demo behaviour |
| `PRICE_FEED_TTL_SECONDS` | `60` | per-asset cache TTL |
| `PRICE_FEED_MAX_STALENESS_SECONDS` | `3600` | beyond → outage policy applies |
| `PRICE_FEED_OUTAGE_POLICY` | `halt` | `halt` = refuse to quote on no-usable-price (default, §5.3); `seed` = legacy fairPrice fallback |
| `FX_QUOTE_PER_USD` | `1.0` | quote-per-USD multiplier (§5.4) |
| `PRICE_FEED_FALLBACK` | `1` | enable secondary source (yahoo / tencent) |
| `BOT_SKIP_SYMBOLS` | `NVDA` | registry symbols the bot must not quote (CSV, case-insensitive); stops quoting without touching the on-chain market/registry |
| `NASDAQ_API_BASE` | `https://api.nasdaq.com/api/quote` | override/testing |
| `YAHOO_API_BASE` | `https://query1.finance.yahoo.com` | override/testing |
| `NEBIUS_API_BASE` | `https://api.nebius.cloud/billing/v1alpha1/spot-price` | override/testing (GPU spot, §5.1) |
| `SINA_API_BASE` | `https://hq.sinajs.cn` | override/testing |
| `TENCENT_API_BASE` | `https://qt.gtimg.cn` | override/testing |
| `PRICE_MAX_JUMP_BPS` | `5000` | warn-only jump threshold |
| `PRICE_SANITY_MAX` | `1000000000` | reject absurd WAD |

---

## 7. Code touchpoints (implementation checklist)

| file | change |
|---|---|
| `bot/price_feed.py` | NEW, stdlib-only module: `PriceSource`/`SyntheticWalkSource`/`NasdaqSource`/`YahooSource`/`NebiusSource`/`SinaSource`/`TencentSource`/`FallbackSource`/`CachedSource`/`build_feed` |
| `bot/verifier.py` | `PairConfig` gains `price_source`/`price_symbol`/`asset_class`/`fx_quote_per_usd`; `load_asset_configs` reads them; `__init__` builds the real feed via `build_feed(pair)`; keep `get(block)` |
| `deployment-assets.json` | add `SOXX` entry; add `priceSource`/`priceSymbol` to NVDA/GLM/SNDK/DEEPSEEK (gitignored — regenerate) |
| `script/deploy-market-stack.js` | add `SOXX` to default `ASSETS` (`NVDA:…,GLM:…,SNDK:…,DEEPSEEK:…,SOXX:…`); pass through per-asset `priceSource` when writing the registry (or write from a sibling map) |
| `script/mint-demo-tokens.js` | SOXX available by symbol (registry-driven already) |
| `web/src/lib/assets.ts` | `SOXX: "iShares Semiconductor ETF"`, `GLM: "Zhipu Technology (Z.AI) · 02513.HK"` |
| `web/.env.local` + `.example` | add SOXX base token to `NEXT_PUBLIC_SELECTED_BASE_TOKENS` (curation) |
| `bot/.env.example` | document the new env vars (§6.2) |
| `docs/prd.md` R22 (optional) | note SOXX joins the multi-asset set; DEEPSEEK stays synthetic |

HTTP: use **stdlib `urllib.request`** (already a Python dep) or add `requests` to
`bot/requirements.txt`; do not add a heavy dependency. All network calls must be
timeout-bounded (≈5 s) and wrapped so an exception can never bubble into `step()`.

---

## 8. Adding SOXX to the stack (runbook)

1. **Deploy/registry** (reuses existing tokens; never deploys Monoracle):
   `$env:ORACLE_ADDRESS="0x80732110…"; $env:ASSETS="NVDA:230,GLM:2.5,SNDK:88,DEEPSEEK:45,SOXX:514"; node script/deploy-market-stack.js`
   → new `SOXX` MockERC20 + a fresh market round; `deployment-assets.json` gains the SOXX
   entry with `priceSource:"nasdaq"`, `priceSymbol:"SOXX"`, `assetClass:"etf"`.
2. **Bot**: with `PRICE_FEED_ENABLED=1`, `MarketMakerBot` auto-loads the 5th pair from the
   assets file; verify the log line shows `[SOXX] quoted … fair=514.71`.
3. **Web**: add the display name; add SOXX base token to the curated list; redeploy `web/`
   (`npx vercel --prod` from `web/`) so the client chunk re-inlines the env.
4. **Vault (optional)**: MVP vault is `assets[0]` (NVDA) only. A SOXX vault follows the
   per-pair model (`docs/architecture.md` §7) — out of scope here (§12 D-E).

---

## 9. Failure modes & risk register

| risk | impact | mitigation |
|---|---|---|
| Nasdaq/Sina/Tencent/Yahoo unofficial + rate limits / geo-block | feed down | TTL cache + fallback chain + last-good + seed; keyed provider in prod (§11) |
| HK sources (Sina/Tencent) geo-restricted or missing `Referer` | empty body → no price | require `Referer`, decode GBK, fall back Sina→Tencent→last-good→seed |
| US market closed (nights/weekends); HK lunch break / close | canonical price frozen; demo PnL static | documented behaviour; optional demo jitter overlay (off-chain only) — not applied to the real mark |
| Parse/unit error (`$1,394.83`, `N/A`, GBK name) | wrong price → bad quote | strict field-index parser + unit tests; sanity band (§5.5) |
| Static-seed clamp kills real price | price pinned near seed (88 / 2.5 / 230) | real sources bypass the clamp (§5.5) — **must ship in same change** |
| USD vs HKD mismatch | US names nominal, GLM true HKD | explicit `FX_QUOTE_PER_USD`, default 1.0, documented (§5.4) |
| Feed makes bot quote pick-off-able (stale vs real move) | provider P&L bleed | expected for the veto market; cap `QUOTE_BASE_AMOUNT`, run as demo provider only |
| Rate-limit across N pairs | 429s | per-symbol cache + staggered startup; never fetch in the quote loop |
| Data ToS (scraping) | hackathon-only fine | switch to keyed provider for production |

---

## 10. Acceptance criteria & tests

**Unit (new `bot/tests/`, no chain):**
- [x] `NasdaqSource` parses `"$514.71"` → `514710000000000000000` WAD; `"$1,394.83"` →
      `1394830000000000000000`; rejects `"N/A"`/`""`/missing `lastSalePrice`.
      A non-`Open` `marketStatus` (a **sibling** of `primaryData` — verified against the live
      response) logs at DEBUG with `lastTradeTimestamp`; `Open` logs nothing.
- [x] `NebiusSource` (issue #28): lowest spot across regions for a GPU model
      (`B300` → 6.70 USD/GPU-hour live); `@region` pin (`B300@us-north1` → 8.29);
      unknown GPU/region and empty `items` raise; `fx` applied; a malformed SKU row is
      skipped rather than aborting the scan.
- [x] `SinaSource` parses `var hq_str_hk02513="Z.AI,…,…,518.000,…"` → field 6 (HK);
      `TencentSource` parses `v_hk02513="…~02513~518.000~…"` → field 3.
- [x] A-shares (issue #35): `SinaSource("sh600519")` parses field **3** (live ¥1318.49),
      `TencentSource("sh600519")`/`("sz000001")` parse field 3; `hk`/`sh`/`sz` prefixes
      route to the right URL/key; a bare code still means `hk`.
- [x] `BOT_SKIP_SYMBOLS=NVDA` drops NVDA from the quoted pairs (registry/market untouched).
- [x] GBK company-name bytes decode without raising (`errors="replace"`).
- [x] `CachedSource`: within TTL no second HTTP call; past TTL refetches; all-sources-down but
      within `max_staleness` returns last-good; past it the outage policy applies (default
      `halt` raises `FeedOutageError`; `seed` returns the seed with ERROR; zero seed raises).
      Retry throttle: at most one fetch attempt per TTL window, so an outage does not
      re-hit the network on every poll; throttled ticks emit no ERROR.
- [x] `FallbackSource`: primary 500 → secondary value returned (Sina down → Tencent).
- [x] `SyntheticWalkSource` still clamps to ±20% of seed (regression guard).
- [x] `build_feed` picks source from `priceSource`; unknown ⇒ synthetic.

**Integration (testnet):**
- [ ] `PRICE_FEED_ENABLED=1 python bot/verifier.py --once` logs real prices for all 5 pairs.
- [ ] After a settle, `getLatestPrice(SOXX, HKD)` ≈ the Nasdaq last sale (± tolerances).
- [ ] `deployment-assets.json` contains SOXX with a valid `marketId`; no Monoracle redeploy.
- [ ] Web shows `SOXX — iShares Semiconductor ETF` and the live canonical price.

---

## 11. Upgrade path (post-demo)

- Keyed free tiers: **Finnhub** (60 req/min) or **Alpha Vantage** (25 req/day) as primary;
  keep Nasdaq / Sina / Tencent as fallback. Same `PriceSource` interface.
- Add a small **provider-health** log / metric (last success age per source).
- Optional on-chain freshness bound in the vault PriceAdapter (see
  `docs/design/lp-pool-tech-spec.md` §8) — separate change, not this spec.

---

## 12. Open decisions

| # | question | proposed default |
|---|---|---|
| D-A | ~~Is `GLM` = Golem or a placeholder?~~ **RESOLVED:** GLM = Zhipu Technology / Z.AI, HKEX 02513.HK | `sina` → `tencent` |
| D-B | Convert USD→HKD for the US names (`FX_QUOTE_PER_USD ≈ 7.8`) so all pairs are true HKD like GLM, or keep nominal 1.0? | keep 1.0 (matches current deployed marks) |
| D-C | Enable feeds by default, or gate behind `PRICE_FEED_ENABLED`? | gated (`0`) until reviewed |
| D-D | HK secondary source = Tencent, and US secondary = Yahoo (both unofficial)? | yes, behind `PRICE_FEED_FALLBACK` |
| D-E | Deploy a dedicated SOXX vault? | no — wrapper market only |

---

## 13. Out of scope

Contract/ABI changes; Monoracle deployment; order books or cross-venue aggregation; real FX
hedging; production SLA / monitoring stack; redesigning the LP-pool PriceAdapter.
