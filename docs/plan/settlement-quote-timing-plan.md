# Final settlement quote timing — implementation plan

> **Status:** In progress — Change A (bot) + Change B (wrapper gate) implemented on
> `stage/settlement-quote-timing` and merged to `main`/`feat/real-price-feed`;
> live-verified on the AWS server (0 reverted txs; `dt_send_s` 0.52–0.9 s from AWS
> vs 1.0–3.3 s local). §6 adds the Multicall3 per-step batching (measured 8.8×
> faster steps) that makes the at-lead submission reachable. §7.2 (upstream
> automatic settlement) pending as its own migration.
> **Issue:** dixia/IRMarket#22 (final settlement quote reverts on testnet)
> **Branch order:** `stage/testnet-gas` first, port to `feat/real-price-feed` after verification.
> **Owner:** bot/ + contracts/. No upstream (Monoracle) change is required for the fix itself;
> an optional upstream change is specified in §7 for a later cycle.

---

## 1. Problem statement

Each market round ends at its expiry block. After that block the round's official
settlement price must be recorded on-chain as the canonical price
(`Monoracle.getLatestPrice`). The bot records it by submitting one last
collateralized quote — the **final settlement quote** — whose price is read at the
round expiry and which is settled after every other quote of the round, so it becomes
the canonical price.

That quote reverts intermittently today. Monoracle requires a quote's
`expiryBlock` to be strictly in the future at the block that **includes** the
transaction (`Monoracle.sol:178`, `ExpiryMustBeFuture`). The bot currently sets the
final settlement quote's `expiryBlock` equal to the market expiry `E`. The
transaction must therefore be included in a block `<= E`, while the bot only
observes the chain head once per loop iteration. When its loop period (historically
~44 blocks because of full-ledger scans; ~16–20 blocks after commit `82af95e`) is
larger than the submission window, the transaction is broadcast after the chain has
already passed `E` and reverts — and Monad bills the full gas limit (400,000).

Measured on testnet (see `docs/monad-testnet-inclusion-latency.md`):

| fact | value | source |
|---|---|---|
| block time | 0.310 s (100 blocks in 31 s) | measured |
| inclusion latency | 0–2 blocks after broadcast (78 samples, avg 0.87) | `[latency]` instrumentation |
| old lead default | 2 blocks = 0.62 s window | issue #22 |
| old loop period | ~13.7 s ≈ 44 blocks | pre-`82af95e` sweeps |

Conclusion: the network is not the bottleneck. The failure is a timing collision
between the bot's loop period and a submission window that is pinned to the same
block at which trading ends.

## 2. Terminology

- `E` — the market's expiry block (from `IRMarket.markets(id).expiryBlock`). Trading
  ends at `E`.
- **trading quote** — a quote with `expiryBlock = E`, tradeable through the wrapper
  until `E`.
- **final settlement quote** — the quote whose price becomes the round's canonical
  settlement price. Under this plan its `expiryBlock` is `E + G`.
- `G` — **settlement window**, in blocks. The final settlement quote may be included
  anywhere in `[E, E + G]`.
- `lead` — how many blocks before `E` the bot reads the price and submits the final
  quotes. Controls price freshness only.
- **inclusion deadline** — the latest block in which a transaction may be included
  for the quote to be accepted: `expiryBlock`.

## 3. Design

Split the two roles that are currently forced onto one expiry value:

| role | expiry | may be traded until | settles |
|---|---|---|---|
| trading quotes | `E` | `E` | after `E` |
| final settlement quote | `E + G` | never (blocked by the wrapper gate, §6) | after `E + G` |

Sequence of one round:

```
head <= E - lead     normal quoting: trading quotes with expiry E
E - head <= lead     read price once; submit
                       (a) one final trading quote, expiry E   (same price)
                       (b) the final settlement quote, expiry E + G
E < head <= E + G    settlement window: settle + withdraw the E-quotes once;
                     submit a late settlement quote if (b) was never sent
head > E + G         settle the E+G quote last, withdraw it, roll the next round
```

Why this satisfies the freshness requirement (< 1 s):

- `lead = 3` blocks → the price is read ≤ 0.93 s before `E`.
- Quote (a) settles right after `E`, so the canonical price reflects the round-expiry
  price within ~1 block (~0.3 s) after `E` — **without waiting for `G`**.
- Quote (b) has inclusion deadline `E + G`, so a delayed transaction no longer
  reverts; `G` only delays the confirmation and the provider's collateral return,
  not the price.
- If (b) is vetoed during its window, the canonical price falls back to (a) — which
  carries the same price, read at the same step.

## 4. Change A — bot (`bot/verifier.py`, no contract change)

1. **Config**
   - `SETTLEMENT_QUOTE_LEAD_BLOCKS`: `30` → `3` (freshness only; safety comes from `G`).
   - New `SETTLEMENT_WINDOW_BLOCKS` (env), default `60` (~18.6 s). Covers the
     observed inclusion outliers (28 blocks) plus an RPC hiccup and one retry cycle.

2. **`step()` phase split** (currently two branches at `verifier.py:830`):
   - `head >= E` must enter the settlement-window branch, not the restock branch
     (fixes a pre-existing edge: a restock submitted at `head == E` reverts today).
   - settlement window (`E <= head <= E + G`): run the E-quote settle/withdraw pass
     **once** (idempotence flag, e.g. `_round_swept`); still run veto watch; if the
     settlement quote was never submitted (restart, missed step) and
     `head < E + G - 2`, submit it with expiry `E + G`; do not restock with expiry
     `E` (it would revert); do not roll the round.
   - finalize (`head > E + G`): run the E-quote pass if not yet done, then settle the
     `E + G` quote **last**, withdraw it, `roll_round()`, reset per-round state
     (`_round_swept`, `_settlement_quote_id`, `_final_submitted`).

3. **Final-quotes step**: at `E - head <= lead`, submit (a) the final trading quote
   (only if no active one) and (b) the settlement quote with expiry `E + G`, both
   priced from the same feed read. No restock after this point.

4. **Restart recovery**: `_rescan_own_quotes` scans backward and already stops at the
   first quote with `expiryBlock < round_expiry`; the `E + G` quote is the newest own
   quote, so it is found. Classify it (set `_settlement_quote_id`,
   `_final_submitted = True`) and keep it **out** of `_own_current` so the E-quote
   pass never touches it. `settle_round`'s filter `q["expiryBlock"] != round_expiry`
   already excludes it; add a sibling `settle_settlement_quote()`.

5. **Adaptive loop period** (in `run` / `run_all`): when any pair is within
   `E - LOOKBACK <= head <= E + 3`, sleep ~0.4 s instead of `QUOTE_INTERVAL_SECONDS`
   (5 s). `NEAR_EXPIRY_LOOKBACK_BLOCKS` is **65**, not a small constant: it must
   exceed one full loop period in blocks, or the bot steps straight over the band.
   Measured on the ops box a loop period is 42–65 blocks (each RPC ~1.5 s, several
   calls per step) — see §6 for the batching that shortens it.

6. **Already shipped on this branch (keep):** bounded own-quote bookkeeping
   (`82af95e`), revert-nonce advance in `_send`, and the `[latency]` instrumentation
   (`decision_block`, `decision_ts`, `dt_send_s`, `incl_gap_blocks`,
   `post_send_gap_blocks`, `wait_s` at DEBUG) used for verification (§9).

### 4b. Per-step read batching (Multicall3) — added after live verification

Live runs on the AWS box showed the settlement-window fix working (0 reverts,
canonical handed over by the settlement quote) but the **at-lead path never
firing**: the final settlement quote was still submitted *after* `E`, so the
round's price was read seconds past the bell instead of ~0.9 s before it.

Cause — not the band width, the **cost of one `step()`**:

| quantity | measured (AWS → paid QuickNode) |
|---|---|
| one `eth_call` | ~1.5 s |
| RPC calls per `step()` | 3–10+ (`_market`, `block_number`, `_quote` × tracked ids) |
| wall-clock per `step()` | ~10–15 s ≈ **35–50 blocks** |

The near-expiry band is 68 blocks, but one step already spanned most of it, so the
bot could not observe `E - lead`. Widening the band cannot fix that.

Fix (`7213e9b`): `_read_snapshot()` folds `markets(marketId)` +
`quotes(qid)` for every tracked own id (`_own_current | _pending_own`) into **one**
Multicall3 `aggregate3` call and fills `_read_cache`, so `_active_own_quote` and
`watch_vetoes` read the snapshot instead of one `eth_call` each. n3 is the
canonical Monad deployment `web/src/lib/wagmi.ts` already uses
(`0xcA11bde05977b3631167028862bE2a173976CA11`, overridable via
`MULTICALL3_ADDRESS`).

Measured on the live stack: **3 calls / 10.35 s → 1 call / 1.18 s (8.8×)**, i.e. a
step of ~20 blocks — comfortably inside the band, so the at-lead path is reachable.

Correctness:
- The snapshot is read at the current block, so a decision taken from it is as
  fresh as a single `eth_call`; `_read_cache` is cleared at the top of every step,
  so nothing survives across steps.
- Send-gating readers (`settle_round`, `settle_settlement_quote`,
  `_resolve_own_quote`) keep their fresh single reads.
- `watch_vetoes` now reads from the snapshot: quote statuses only move forward
  (ACTIVE → vetoed/settled → withdrawn) and only we can withdraw, so a same-block
  snapshot can at worst make us miss an action for one step, never perform a wrong
  one.
- If n3 is absent or the call fails, `_read_snapshot()` returns `None` and `step()`
  falls back to the sequential reads — behaviour identical to before.
- web3 v7 note: use `encode_abi(name, args)` + `eth_abi.decode`, not
  `encodeABI`/`decode_function_result` (renamed in v7); `quotes()` returns ten
  **flat** outputs, matching `_QUOTE_FIELDS`.

## 5. Change B — IRMarket wrapper (1 check + 1 error)

Without a gate, the `E + G` quote is tradeable through `openLong/openShort` during
`[E, E + G]`, because `_checkTradeable` (IRMarket.sol:244-253) only checks
`q.expiryBlock` and never `m.expiryBlock`. That would allow trading after the round
ended, and would allow the round's settlement quote to be vetoed through the wrapper.

```solidity
error MarketWindowExpired();
// in _checkTradeable, after the pair check:
if (block.number > m.expiryBlock) revert MarketWindowExpired();
```

- `m` is already loaded; ~0 extra gas. No struct/ABI/event change; no new
  `Market` field (`G` stays a bot config).
- Tests: existing window tests unaffected; add one case (settlement quote with
  `expiry + 60`, past `E`, both directions revert `MarketWindowExpired`).
- Web: no mandatory change (optional polish: hide quotes whose `expiryBlock`
  exceeds the market's from the tradeable lists during the settlement window).
- Redeploy checklist (wrapper is immutably bound to the oracle): force a fresh
  wrapper in `script/deploy-market-stack.js` (clear the reused `market` entry in
  `deployment-assets.json`) → rerun the deployer → update
  `web/.env.local` `NEXT_PUBLIC_MARKET_ADDRESS` / `NEXT_PUBLIC_DEMO_MARKET_ID`,
  Vercel production env + `npx vercel --prod --yes` from `web/` → update
  `bot/.env` `MARKET_ADDRESS`.

## 6. Vault — no change

`IRMarketVault.settlePosition` reads the canonical price at call time (American
settlement, accepted MVP limitation, tech-spec §1.4). Because the final trading
quote settles within ~1 block of `E`, the canonical price during the settlement
window is already the round-expiry price, so no pinning is needed for MVP.

## 7. Upstream Monoracle — next cycle (not required for this fix)

Answers the design questions: *would separating quote from verification make it
easier? and can settlement be automatic — considered settled after a certain block?*

**7.1 Separating trading from settlement.** Already achieved by Change B: the
wrapper gate makes the settlement quote untradeable, so no new quote "type" or
upstream concept is needed. Trading quotes and the settlement quote differ only in
their `expiryBlock` and in what the wrapper allows.

**7.2 Automatic settlement (recommended upstream change).** Today a quote becomes
canonical only when some external transaction calls `settleValidQuote`, and the
stored pointer `latestValidQuoteId` is overwritten in call order (last call wins).
That is why the bot must settle oldest-first and keep the settlement quote for last,
and why any third party can settle quotes out of order.

Make settlement **implicit**: a quote is *considered settled* once
`block.number > quote.expiryBlock` and it was never vetoed — no settle transaction
needed. Concretely, in `Monoracle.sol`:

- on `submitQuote`: link the quote into a per-pair list
  (`quote.prevQuoteId = latestQuoteId[pair]; latestQuoteId[pair] = quoteId`);
- `getLatestPrice`: walk backward from `latestQuoteId[pair]`, skipping quotes whose
  window has not passed or whose status is not `ACTIVE`, and return the first
  surviving quote (cap the walk, e.g. 16, to bound gas);
- `withdrawProviderFunds`: additionally accept `status == ACTIVE &&
  block.number > expiryBlock` (return base + quote);
- `settleValidQuote` may remain for compatibility/events but no longer gates the
  canonical price.

Effects: the canonical price becomes a pure function of chain state (no ordering
fragility, no late-settle rewrite), the bot's entire settle/withdraw ordering logic
disappears, and one settle transaction (~100k gas per quote) is saved per quote.
The veto window — the actual price-integrity mechanism — is unchanged.

Cost: oracle bytecode changes → new oracle address → per repo rule ②, wrapper and
vault must be redeployed and the web env re-pointed. The ABI is unchanged, so
`oracle-doctor.js` and `sync-oracle-abi.js` stay green. Sequence this as its own
migration (same shape as `docs/plan/monoracle-upstream-migration-plan.md`), not as
part of this bug fix.

**Minimal alternative** if 7.2 is deferred: a 3-line guard in `settleValidQuote` —
`if (quoteId > latestValidQuoteId[pair]) latestValidQuoteId[pair] = quoteId;` —
which removes the late-settle rewrite while keeping manual settlement. ABI-silent,
~neutral gas. Do not use a lexicographic `(expiryBlock, quoteId)` comparison: it
lets a pre-submitted long-window quote outrank the settlement quote.

**7.3 Read-side views to add (same upstream cycle; ABI-additive).**

Storage prerequisite: one backward link per quote (`prevQuoteId`, set at submit from
the pair's previous newest id) plus `latestQuoteId[pair]` — ~+20k gas on
`submitQuote`. The views are derived from that list.

| view | returns | what it unblocks |
|---|---|---|
| `getCanonicalQuote(base, quote)` | `(id, provider, price, expiryBlock, settledSlot, exists)` | the full effective settlement quote, not just the price — vault/web can verify the price belongs to the current round |
| `recentQuotes(base, quote, maxCount)` | `(id, provider, price, expiryBlock, status)`[] | one call replaces the bot's backward ledger scan (boot recovery) and the web's per-id `quotes()` reads |
| `quotesByExpiry(base, quote, expiryBlock, maxCount)` | same shape, restricted to one round | makes "settle this round" and restart recovery round-scoped with zero local bookkeeping, and exposes other providers' quotes (invisible today without a full scan) |

Notes:

- `quotesByExpiry` needs its own per-`(pair, expiry)` head mapping: one more SSTORE
  on submit (+~20k gas, ≈ +5% per quote). Optional — `recentQuotes` plus
  client-side filtering on `expiryBlock` is enough for a single-provider bot.
- Do not add unbounded per-provider arrays or full-ledger enumeration; the walk cap
  is what keeps `getLatestPrice` and these views gas-bounded.
- All three are ABI-additive; ship them in the same redeploy cycle as §7.2 (the
  bytecode changes there anyway).
- With these views the bot's local bookkeeping reduces to: read
  `recentQuotes(pair, 16)`, filter `provider == self` and `expiryBlock == E` — no
  restart scan, no `_own_quotes` growth, and `settle_round` walks
  `quotesByExpiry(E)` directly.

## 8. What we deliberately do not do

- **Continuous sub-second on-chain price updates.** One on-chain price update is one
  Monoracle quote: `submitQuote` 400k + `settle` 100k + `withdraw` 200k ≈ 700k gas
  ≈ 0.07 MON at the measured 102 gwei → ~6,000 MON/day at 1 update/s, and each
  ACTIVE quote locks bilateral collateral. Sub-second *display* prices mid-round are
  an off-chain concern (the web already prices from the latest ACTIVE quote, B12).
- **Complete bot rewrite.** The phase split is a contained change to `step()` plus
  two helpers on top of the already-bounded bookkeeping.
- **New `Market` struct field** for the settlement window (~8 artifacts touched,
  buys nothing over the wrapper gate).

## 9. Verification plan

Funding: the stage bot wallet `0x5ceF21c2977470Fa4fBa3C6b87203268003Ef498`
holds ~2.5 MON — enough for ~10 verification rounds (one round costs ~0.21 MON,
§10). Below 10 MON, Monad rate-limits an EOA to about one send per 3 blocks; the
bot sends serially and waits for each receipt anyway, so this does not constrain
the run. Only keep the balance from reaching ~0.

1. `LOG_LEVEL=DEBUG`, `ROUND_BLOCKS=600`, one pair, run ≥ 3 rounds.
2. Expect per round, from the `[latency]` lines:
   - final trading quote and settlement quote submitted at `E - 3 ± 1`;
   - `dt_send_s` < 1 s; `post_send_gap_blocks` ≤ 2;
   - settlement quote receipt block ≤ `E + G`;
   - canonical price updates within ~1 block after `E` (final trading quote), and is
     the settlement quote's price after `E + G` (same value);
   - `step: N RPC reads (batched)` — **N = 1–2**, not the 3–10 of the unbached path.
3. Hardhat: `npx hardhat test` (55 baseline + the new gate test). Bot: import check.

### Done so far (live, AWS ops box)

| check | result |
|---|---|
| reverted txs across all observed rounds | **0** |
| `post_send_gap_blocks` (broadcast → inclusion) | −1…1 |
| `dt_send_s` from AWS | **0.52–0.9 s** (vs 1.0–3.3 s from a laptop) |
| canonical handover | E-quote settles first, settlement quote settles last → canonical becomes the settlement quote's price |
| late-submit recovery path | exercised live (submitted at ~E+21, included inside the window) |
| per-step cost after Multicall3 batching | **1 call / 1.18 s** vs 3 calls / 10.35 s (8.8×) |
| `step: N RPC reads` | 1 (batched) |
| at-lead submission | **partially achieved** — see below |

At-lead observation after deploying the batched reads (2026-10-21, three pairs
rolling back-to-back, expiries clustered within ~42 blocks):

| pair | label | price read at |
|---|---|---|
| NVDA | `final settlement quote` (no `(late)`) | **~E−3 blocks** — the true bell price |
| GLM | `final settlement quote (late)` | ~E+30 blocks (~9 s past the bell) |
| DEEPSEEK | `final settlement quote (late)` | ~E+30 blocks (~9 s past the bell) |

All three still: settle order correct, canonical handed over by the settlement
quote, 0 reverts, rounds rolled. The residual intermittency is the **multi-pair
phase** (plan risk 5), not the step cost: the three pairs' expiries cluster within
~42 blocks because they are rolled back-to-back, so all three enter their windows
at once; during the window each pair issues ~4 transactions, so one full cycle
through three pairs spans ~50–65 blocks — marginal against the 68-block band.
Closing it fully needs the round expiries **staggered** (e.g. offset each pair's
roll by `ROUND_BLOCKS / n_pairs`), not more batching.

## 10. Gas budget per round (at 102 gwei, measured)

Monad bills the gas **limit**, not the gas used, so the limit table *is* the cost.
The old limits carried 30–50 % head-room per operation, which the bot paid on every
send. Re-measured 2026-10-21 against the production contracts (`eth_estimateGas` on
the exact calldata) and against the local Hardhat gas test (which also covers the
first-call state: a fresh allowance slot):

| op | live cold | mock first | old limit | adopted | MON / send |
|---|---|---|---|---|---|
| approve | 33,586 | 47,242 | 60,000 | **56,691** | 0.0058 |
| submit_quote | 287,219 | 262,844 | 400,000 | **315,413** | 0.0322 |
| settle | 48,192 | 60,796 | 100,000 | **72,956** | 0.0074 |
| withdraw | 123,206 | ~49,000 | 200,000 | **129,367** | 0.0132 |
| create_market | 172,678 | 182,324 | 250,000 | **218,789** | 0.0223 |

Adopted = max(live × 1.05, mock × 1.20). Two empirical lessons behind that:

1. **The exact measured value is not safe.** A test run with the limits set to the
   live measurements succeeded for `settle`/`withdraw` but reverted out of gas for
   `createMarket` and one final settlement quote. Replaying the failed txs at
   `block−1` with a 2 M gas cap succeeded — proof it was out of gas, not a logic
   revert. `createMarket` re-estimated 172,678 (not the 160,575 of a warm state),
   a 7.5 % swing from storage warmth.
2. **The mock's first-call cost is a real state.** `test/gas.test.js` measures the
   first `approve` (47,242 — a fresh SSTORE) and the first `createMarket`
   (182,324 — the two allowance SSTOREs). Both exceed a warm live estimate, so the
   120 % tripwire correctly rejected the +5 %-only values.

Re-measure method (repeatable): take a real tx hash per op from the bot log, then
`eth_estimateGas({from,to,data}, block_identifier=tx.blockNumber-1)`; for ops with
no live tx of that shape, build the calldata with a future expiry and estimate at
`latest`. `receipt.gasUsed` is useless on Monad — it echoes the limit.

Per round with the adopted limits (3 submits + 2 settles + 2 withdraws + 1 createMarket):

| op | gas | MON |
|---|---|---|
| 3 × submitQuote | 946 k | ~0.097 |
| 2 × settle | 146 k | ~0.015 |
| 2 × withdraw | 259 k | ~0.026 |
| createMarket | 219 k | ~0.022 |
| **total** | **~1.57 M** | **~0.160** |

vs ~0.21 MON/round before (**~24 % cut**). The burn measured over a live afternoon
with the old limits was ~0.87 MON/h (three pairs); the new table brings that toward
~0.66 MON/h. The remaining cost is structural (every round pays for a createMarket,
a restock, and a settle+withdraw pair) — the next lever is the upstream lazy
settlement (§7.2), which removes the settle transactions entirely.

## 11. Risks

1. Settlement quote vetoed during `[E, E+G]` → canonical falls back to the final
   trading quote, which carries the same price (read at the same step). Log loudly;
   optionally resubmit a replacement settlement quote if vetoed early in the window.
2. Third-party out-of-order settles (last-write-wins) — inherent to permissionless
   Monoracle until §7.2 lands; exposure widens by `G` blocks.
3. Direct-oracle veto of the settlement quote during the window (bypasses the
   wrapper gate) — mitigated economically by collateral sizing, not by contract.
4. Two bot instances on one wallet → nonce races; unchanged, keep the one-instance rule.
5. Multi-pair serial sends: a settle/withdraw burst on one pair delays another pair's
   step; the adaptive loop period mitigates the near-expiry case only.