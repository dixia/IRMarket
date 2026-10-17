# IRMarket — One Market per Pair (Option B) Implementation Plan

> **Status:** **In progress** — code complete on branch `feat/one-market-per-pair`:
> bot round model + deploy script + web rounds-from-quotes implemented; bot unit tests
> (`bot/tests/test_rounds.py`) + hardhat suite + web tsc/build + Playwright e2e pass locally.
> **Remaining:** IRMarket redeploy + `NEXT_PUBLIC_MARKET_ADDRESS`/registry update, and a live
> `--once` ×2 testnet run (zero `createMarket`) — deliberately deferred.
> **Branch/worktree:** based on `IRMarket-monoracleA` (`feat/monoracle-upstream`,
> includes `5baff39` packed-struct + guarded `createMarket`).
> **Touches:** `contracts/` (redeploy only), `script/deploy-market-stack.js`, `bot/verifier.py`,
> `web/src/hooks/*`, `web/src/app/*`, `web/src/components/*`, `web/src/lib/*`, docs.
>
> **Chinese summary (快速阅读)**
> 现在 bot 每轮都 `createMarket`（新 marketId），因为 frontend 把「一个 market」当作「一轮」，
> 并用 `market.expiryBlock` 做倒计时。但合约里 `market.expiryBlock` 是**纯 advisory**：`openLong`
> 只校验 **quote 的** `expiryBlock`/ACTIVE/pair，从不读 market 的 expiry。因此市场创建后即使过期也能
> **无限复用**。本计划：每个 pair **只创建一次** market（15 分钟），之后所有轮次由 **quote 的
> expiryBlock** 定义；bot 不再在循环里 `createMarket`；frontend 改为从 quotes 派生轮次/倒计时。
> 合约逻辑不变（可复用当前 `IRMarket-monoracleA` 版本，需重新部署以拿到新地址）。

---

## 1. Problem

Monad bills **gas limit × price**, so an inflated/ repeated op is money burned. Today each pair
mints a brand-new market **every round** (`bot/verifier.py:525 roll_round()` →
`createMarket`, `:571 step()`):

- `createMarket` is the single biggest per-round op (limit 250k; measured 198.5k repeat /
  218.5k first-time on the deployed un-redeployed wrapper).
- It also grows `nextMarketId` unbounded → the frontend enumerates **every** market each poll
  (`web/src/hooks/useMarkets.ts:37`; 112+ markets today), and `marketId` churn is pure overhead.

Root cause: the frontend models **a round == a `Market`** and drives the countdown from
`market.expiryBlock`. But that field is advisory and unused by the trade path.

### 1.1 Contract evidence (market is reusable)

`_checkTradeable` (`contracts/IRMarket.sol:244-253`) validates only:

- `q.baseToken/quoteToken == market.baseToken/quoteToken`
- `q.status == ACTIVE`
- `block.number <= q.expiryBlock` — the **quote's** expiry

`openLong/openShort` (`:176-228`) read the market only for `baseToken`, `quoteToken`,
`feeBps`, `marketMaker`. `m.expiryBlock` is written once in `createMarket` (`:150-157`) and
**never read again** (only the `markets()` getter exposes it). ⇒ After the market's expiry
passes, `openLong(marketId, quoteId)` still works with any fresh ACTIVE quote. The market is
**infinitely reusable**.

---

## 2. Decisions (confirmed)

| # | Decision |
|---|---|
| D1 | **Round identity = quote `expiryBlock`** (not `market.expiryBlock`). |
| D2 | **Round selector stays**, sourced from quote expiries (live + past groups). |
| D3 | **One market per pair**, created **once**; the market field `expiryBlock` = 15 min and is inert thereafter. |
| D4 | **15-minute rounds**: `ROUND_BLOCKS = 3000` (~15 min @ 0.3 s), `EXPIRY_SECONDS = 900`. |
| D5 | Market creation lives in the **deploy script** (deploy-time, CI-idempotent); the bot does **not** create markets in the loop. |
| D5a | `marketMaker` = the **deployer** address (the 1% wrapper fee is paid to the deployer, not the bot). A `MARKET_MAKER` env can override. |
| D6 | **Redeploy `IRMarket`** from `IRMarket-monoracleA` (packed struct + guarded `createMarket`), then create the one market/pair. |
| D7 | Market discovery = **enumerate `1..nextMarketId-1` + dedup by pair** (trivially small after redeploy: one per pair). |
| D8 | Quote-history window = `MAX_TRACKED_QUOTES = 50` (the trailing quote-id window the web reads); raise later only if longer round history is needed. |
| D9 | `NEXT_PUBLIC_DEMO_MARKET_ID` — already **unused by `web/src`** (only stale docs + the bot log line); drop the bot log line, no web change. |

### 2.1 Explicitly out of scope / unchanged

- Monoracle oracle: unchanged, never redeployed (input).
- `IRMarketVault`: unchanged (binds `oracle` + `priceBase` + `settlementToken`, **not** the wrapper).
- Contract **logic**: no change; only a fresh deployment (to get the `5baff39` build + clean ids).
- `TradePanel`, `useTrade`, `usePositions`, `useReferencePrice`, `ClosePanel`: already quote-based,
  effectively unchanged.

---

## 3. Target model

```
Market (per pair, created once)            Quote (Monoracle, per round)
  marketId, base, quote,                     quoteId, base, quote, price,
  marketMaker = bot, feeBps,                 expiryBlock = round end, status
  expiryBlock (15 min, inert)                       ▲
        │                                           │
        └──────────── openLong(marketId, quoteId) ──┘
                     (validator reads the QUOTE's expiry, not the market's)
```

- Rounds = distinct quote `expiryBlock` values for the pair.
- Countdown = selected round's quote `expiryBlock` (`live = expiry >= block`).
- `createMarket` called once per pair, ever.

---

## 4. Part A — Contract + deploy + registry

**No `.sol` change.** Redeploy `IRMarket` from this branch and register one market/pair.

### 4.1 `script/deploy-market-stack.js`

1. **Market expiry** → `startBlock + MARKET_EXPIRY_BLOCKS` with default `3000` (15 min).
2. **Market maker** → the **deployer** (`wallet.address`) is the default fee recipient; optional
   `MARKET_MAKER` env overrides. Add to the runbook + printed summary. (Note: the 1% wrapper fee
   then accrues to the deployer, not the bot — intentional per D5a.)
3. **One market per asset** (already one per asset in the loop `:264`; keep, but the expiry is now
   inert). Write `marketId` into `deployment-assets.json`.
4. **Idempotent reuse (CI-safe):** if `deployment-assets.json` has a `marketId` whose on-chain
   `markets(id)` matches `(baseToken, quoteToken, marketMaker, feeBps)` and `baseToken != 0`,
   reuse it; else create a fresh one. (Wrapper has no pair→id lookup, so match via the registry.)
5. Print `NEXT_PUBLIC_MARKET_ADDRESS` and the per-pair `marketId`s.

### 4.2 Addresses / env to update after redeploy

| key | file |
|---|---|
| `NEXT_PUBLIC_MARKET_ADDRESS` | `web/.env.local`, `web/.env.local.example`, Vercel env |
| `oracle` / `market` / `assets[].marketId` | `deployment-assets.json` (gitignored, regenerated) |
| `deployment.json` | regenerated |

Oracle address unchanged; vault address unchanged.

---

## 5. Part B — Bot (`bot/verifier.py`)

### 5.1 Round derivation (new)

Replace "round = `market.expiryBlock`" with a derived round:

```
round_expiry(block) =
  max( q.expiryBlock for q in quotes(base,quote) if q.expiryBlock >= block )   # any provider
  else None                                                                    # no live round
```

- Adopting the **max live expiry across all providers** keeps every provider on the same round.
- `None` ⇒ the bot starts a new round: `round_expiry = block + ROUND_BLOCKS`.

### 5.2 `step()` (`:571`)

1. `_rescan_own_quotes()` (unchanged).
2. **Settle every expired round** whose `expiryBlock < block` (oldest first), then withdraw own
   funds — a single scan over quotes instead of per-market.
3. `re = round_expiry(block)`.
   - `re is None` → new round: `re = block + ROUND_BLOCKS`; `_final_submitted = False`.
4. `watch_vetoes()`.
5. `_active_own_quote(re)`.
6. If `re - block <= lead_blocks and not _final_submitted` → `submit_quote(re, "final")`;
   elif no active quote (or `REQUOTE_EVERY_LOOP`) → `submit_quote(re, "restock")`.

### 5.3 Remove / change

- **Delete** `roll_round()` (`:525`), `_market_created_id()` (`:554`), the per-round `createMarket`,
  and the "NEXT ROUND … update web env" warning (`:546`).
- `self.market_id` / `_market()` are no longer needed for the loop. Keep an **optional startup
  sanity log** that a market exists for the pair (for the UI); do not create one per round.
- `AUTO_CREATE_MARKET`: repurpose to an optional one-shot "ensure the pair's market exists"
  (default **off**; deploy owns it). Document that it must never run per round.
- Update `GAS_DEFAULTS`: `create_market` stays (rare) but is off the hot path; retune the hot path
  `submit_quote` **400k → 340k** (live 276–293k; ~16–23% headroom).

### 5.4 Env / docs

- `bot/.env.example`: `ROUND_BLOCKS=3000`, remove/annotate `AUTO_CREATE_MARKET`,
  add `MARKET_EXPIRY_BLOCKS` note (deploy-side), `submit_quote` gas comment.
- `bot/README.md`, `bot/prd.md` FR-BOT-001/003: "round = quote expiry; one market per pair".

---

## 6. Part C — Web data layer (`web/src`)

### 6.1 New `useRounds(pair?)` (in `web/src/hooks/useRounds.ts`)

- Input: decoded quotes (reuse `useQuotes`, trailing window `MAX_TRACKED_QUOTES=50`).
- Group by `(pair, expiryBlock)`; `live = expiry >= block`; sort live soonest-first, past newest-first.
- Return `{ rounds: Round[], active: Round | null, activeExpiry }`.
- `Round = { expiryBlock: bigint; quotes: Quote[]; live: boolean }` (add to `web/src/lib/types.ts`).

### 6.2 `useMarkets.ts` (`:37`, `:112-120`)

- Build a **pair → latest market** map (dedup by pair, highest `marketId`), instead of treating each
  market as a round. After redeploy this is ~#pairs reads. Keep token-meta enrichment; keep
  `marketId`/`marketMaker`/`feeBps` as the trade target.
- Drop the "market expired" sort semantics (rounds now come from `useRounds`).

### 6.3 `useMarketGroups.ts` (`:29-38`, `:72`)

- `active` / `activeRounds` come from `useRounds` (quote expiries), not `m.expiryBlock`.
- Keep `latest` as the "awaiting next round" fallback.
- `rounds` count = distinct quote expiries.

### 6.4 `useReferencePrice.ts`

- Unchanged (pair-based: `getLatestPrice` + latest ACTIVE quote).

---

## 7. Part D — Web UI (`web/src`)

### 7.1 `MarketCard.tsx` (`:27`, `:55-60`)

- `market` supplies name/ticker/price/trade target; the **countdown uses the active round's quote
  `expiryBlock`** (new prop `roundExpiry`), not `market.expiryBlock`.
- `href` stays `/trade?m=<marketId>` (optionally `&round=<expiryBlock>`).
- `expired` = no live round; `liveRounds` = number of live quote rounds.

### 7.2 `app/page.tsx` (`GroupCard`, `:115-123`)

- Pass `group.activeExpiry` into `MarketCard`; `expired = !group.active`; `liveRounds` from rounds.

### 7.3 `trade/page.tsx` (`:55-70`, `:93-115`, `:119`)

- `pairRounds` from `useRounds(pair)`; `<select>` options keyed by `expiryBlock` (Live/Past groups).
- Header `BlockCountdown` uses the **selected round's quote expiry**.
- Still pass the pair's single `marketId` + `feeBps` to `TradePanel` (unchanged).

### 7.4 `positions/page.tsx` (`:22-23`)

- Use the deduped pair market from `useMarkets`; the rest already keys off `quote.expiryBlock`.

### 7.5 Unchanged

- `TradePanel.tsx` (already `quote.expiryBlock`), `useTrade.ts`, `usePositions.ts`,
  `ClosePanel`, `useReferencePrice.ts`.

---

## 8. Part E — Config + docs

| file | change |
|---|---|
| `web/src/lib/config.ts` | document `EXPIRY_SECONDS=900`; `NEXT_PUBLIC_DEMO_MARKET_ID` is **not referenced in `web/src`** → no code change |
| `web/.env.local.example` | `NEXT_PUBLIC_EXPIRY_SECONDS=900`; note one market/pair |
| `bot/verifier.py` | remove the stale `NEXT_PUBLIC_DEMO_MARKET_ID` hint from the round log line (deleted with `roll_round`) |
| `docs/sc-tech-spec.md` | §3.3/§7/§8.2: createMarket once per pair; round = quote expiry; gas table |
| `docs/prd.md` | D-14 / R22: "one market per round" → one market per pair; rounds from quotes |
| `docs/web-tech-design.md` | round model §: rounds from quotes; `useMarkets` dedup; drop stale `NEXT_PUBLIC_DEMO_MARKET_ID` ref |
| `docs/architecture.md` | §7: per-pair single market note |
| `bot/README.md`, `bot/prd.md` | FR-BOT round definition + gas |

---

## 9. Part F — Tests & verification

**Bot**
- New `bot/tests/test_rounds.py`: derive round from own/all quotes; adopt across restart;
  roll when expired; no-own-quotes → new round; multiple providers → same round.
- Live: `py bot/verifier.py --once` **twice** → assert **zero `createMarket`**; quotes carry the
  derived `expiryBlock`; `settle`/`withdraw` still fire; confirm a quote settles as canonical.

**Web**
- `npx tsc` + `npm run lint` + `npm run build`.
- Existing unit tests unaffected (`decode.test.ts`, `vault.test.ts`, `format.test.ts`).
- Playwright e2e (`npx playwright test`) against local hardhat: card shows a live countdown
  sourced from quotes after the market expiry passes; a trade (`openLong(marketId, quoteId)`)
  succeeds with a reused market.
- Manual: wait past 15 min (or fast-forward anvil) → market list still shows a live round and
  trading still works.

**Deploy**
- `node script/deploy-market-stack.js --dry-run` → prints plan; run → one market/pair; re-run →
  reuse (idempotent), no duplicate markets.

---

## 10. Gas impact (limit-charged, ~102 gwei)

| op | before | after |
|---|---|---|
| `createMarket` | ~250k limit × **16/hr** (4 pairs × 4 rounds/hr @15 min) ≈ 0.41 MON/hr | **0** in steady state (one-time per pair) |
| `submitQuote` | 400k × N | **340k** × N (−15%) |
| settle / withdraw | unchanged | unchanged |

Net: steady-state bot burn drops by roughly the `createMarket` share (~0.4 MON/hr at 15-min
rounds, 4 pairs) plus the `submitQuote` retune, and `marketId` churn stops.

---

## 11. Migration / rollout

1. Redeploy `IRMarket` from this branch; create one 15-min market/pair; `marketMaker` = deployer.
2. Update `NEXT_PUBLIC_MARKET_ADDRESS` + `deployment-assets.json`; regenerate web env.
3. Ship the web change (rounds from quotes) and redeploy `web/` (`npx vercel --prod` from `web/`).
4. Ship the bot change; run `--once` twice to confirm no `createMarket`.
5. Set `ROUND_BLOCKS=3000` / `EXPIRY_SECONDS=900`.
6. Consolidate to **one** bot instance per stack (multiple concurrent bots multiply cost).

---

## 12. Risks & mitigations

| risk | mitigation |
|---|---|
| UI still reads `market.expiryBlock` somewhere | grep + Playwright; rounds sourced only from `useRounds` |
| History depth bounded by `MAX_TRACKED_QUOTES=50` (only the newest handful of rounds) | raise the cap or move to event indexing if longer history needed |
| Redeploy changes addresses | update `NEXT_PUBLIC_MARKET_ADDRESS` + registry; oracle/vault unchanged |
| Bot restarts mid-round | derive `round_expiry` from chain (max live quote expiry) |
| Multiple providers | round = max live expiry across providers (all settle per expiry, as today) |
| Bot off → no live quote | card shows last/expired fallback (same as today) |
| Someone re-introduces per-round `createMarket` | deploy owns market; bot has no create in loop (guarded by test) |

---

## 13. Acceptance criteria

- [ ] One `Market` per pair on-chain after deploy; re-running deploy creates none.
- [ ] Bot runs a full round+roll cycle **without** any `createMarket`.
- [ ] Web market list + trade page show a live countdown **after** the market's own expiry passed.
- [ ] `openLong(marketId, quoteId)` succeeds on a reused market with a fresh round quote.
- [ ] Round selector lists live/past rounds by quote expiry.
- [ ] `createMarket` guard test + bot round unit tests pass.

---

## 14. Resolved decisions

1. **Market discovery** — enumerate `1..nextMarketId-1` + dedup by pair (D7). ✅
2. **`marketMaker`** — the **deployer** (D5a); optional `MARKET_MAKER` override. ✅
3. **`MAX_TRACKED_QUOTES = 50`** (D8) — the trailing quote-id window the web reads each poll
   (`web/src/hooks/useQuotes.ts:11,37`), set to **50** (changed in code from 200). Quotes are a
   single global id space, so 50 covers only the most recent handful of rounds. Since rounds now
   come from quotes, this window also bounds the "past rounds" history the UI can show; raise it or
   move to event indexing only if longer history is needed. ✅
4. **`NEXT_PUBLIC_DEMO_MARKET_ID`** — no web action (D9). Grep shows it is **not referenced anywhere
   in `web/src`**; it survives only in stale docs (`web-tech-design.md`, `DEMO.md`, `deploy.js`) and
   the bot's round log line. Option B deletes that log line; docs can drop the reference. ✅
