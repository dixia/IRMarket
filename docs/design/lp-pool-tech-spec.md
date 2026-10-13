# IRMarket — LP Pool Technical Specification (V1.0, draft for implementation)

> **Status:** Draft (V1.0). This document is the **target design**. A reduced **MVP cut**
> is defined in §1.4 and is **implemented** (`contracts/IRMarketVault.sol`, unit + E2E tests,
> `script/deploy-vault.js`, `script/vault-demo.js`); the implementation plan lives in
> `docs/design/lp-pool-mvp-impl-plan.md`.
>
> **Companion documents**
> - `docs/sc-tech-spec.md` — V0.9 **veto-market** (deployed): trading = Monoracle veto, bot is
>   the counterparty, no pool. This document does **not** replace it; the LP pool is a new,
>   additive module (§2.3).
> - `docs/prd.md` — product requirements. Note the V0.7 "liquidity pool + linear option"
>   model was overturned in V0.8; **this is a new design**, not a resurrection of V0.7.
> - Upstream `github.com/dixia/monoracle` — price verification primitive. Semantics used here:
>   `submitQuote`, `vetoUnderpriced/Overpriced`, `settleValidQuote`, `getLatestPrice`,
>   public `latestValidQuoteId(pairKey)`, public `quotes(id)`.
>
> **中文摘要（给快速阅读）**
> 当前仓库没有资金池：V0.9 里 bot 用双边抵押当对手方，交易本身就是 veto（LP-00）。本 spec 设计
> **Vault（每市场一个独立资金池）**：LP 存入计价代币换份额，trader 付权利金开多/空，池子做对手方，
> 到期按 Monoracle 的 canonical price 结算。三条硬约束保证池子永不资不抵债：
> ① 单笔赔付封顶（`payout ≤ 2 × notional`）；② 准入控制（利用率 / 单边敞口 / 单笔上限）；
> ③ 结算价必须来自**带抵押背书**的报价（`minQuoteNotional` + 时效性 + 熔断）。
> 最关键的一节是 §8 PriceAdapter：Monoracle 的 canonical price 是「最后一个未被否决的报价」，
> 小额报价也能成为 canonical，**直接拿来结算会被操纵**。必须加最小名义额过滤——操纵成本
> ≈ `quoteAmount × d/(1+d)`，由此推出 `minQuoteNotional` 必须 ≥ 2× **攻击者的 aggregate 净收益**
> （按 skew + 利用率上限共同约束，并计入 honest counterflow 的放大效应，§8.4；V1 默认参数下 ≈ 0.7 × equity）。

---

## 1. Scope

### 1.1 In scope (V1)

| # | Item |
|---|---|
| 1 | Per-market **isolated vault** holding settlement-token liquidity, with LP shares (ERC20) |
| 2 | **Capped linear exotic option**: trader pays premium, pool is counterparty, payoff capped |
| 3 | Open / early-close / expiry-settlement lifecycle |
| 4 | **Price adapter** over Monoracle with minimum-bonded-notional, freshness, circuit breaker |
| 5 | Admission control: utilization, net skew, per-position caps |
| 6 | Per-vault risk parameters (immutable, timelocked update path); factory for permissionless vault creation |
| 7 | Settlement deferral → refund path when no trustworthy price exists |
| 8 | Operational: the vault operator runs a **veto bot** (§8.5) |

### 1.2 Out of scope (V1)

Order book / limit orders (PRD V2, grant §9); cross-margin between markets; perpetual or
uncapped payoffs; liquidations and margin (there is none by construction); delta hedging
(there is no external venue for these assets — that is the entire premise, §8.6);
meta-pool that allocates across vaults (V2).

### 1.3 Non-goals

The pool must **never** be the sole provider of the price it settles against (LP-06) —
**except** for an asset with no crypto-native on-chain asset and no RWA-mapping token, where
the LP is the only possible provider (§8.6.1).
The pool must **never** take unbounded liability on a single position (LP-02).
There is no admin, owner, upgrade hook, or kill switch over **user funds** — consistent
with the ownerless convention in `docs/sc-tech-spec.md` §10. The one exception is the
timelocked risk-parameter path (§7): a param owner (initially the vault creator, LP-D6)
may change risk parameters after `paramDelayBlocks`, and can never move LP or trader
funds.

### 1.4 MVP cut (V1.0-mvp) — the build target for review

The full V1 design above (§1.1) is the destination. The **MVP** is everything needed to
demonstrate the core claim — *a pool is the counterparty and positions settle at
Monoracle's canonical price* — in a few hours, and is what the implementation plan
(`docs/design/lp-pool-mvp-impl-plan.md`) delivers.

| Area | MVP | Deferred to V1 |
|---|---|---|
| Vault topology | one vault, constructor-configured (`oracle`, `priceBase`, `settlementToken`, `feeBps`); **single-asset** — only `settlementToken` is custodied | factory + permissionless vault creation (§3) |
| LP capital | `deposit` / `withdraw` immediately; internal share accounting; conservative `equity = balance − pendingPayout` (§6.2, §6.3) | ERC20 share token, two-step withdrawal queue (§6.4) |
| Product | capped linear LONG/SHORT, payoff §4.2, `maxProfitBps = 10_000` → `payout ∈ [0, 2N]` | early close / `closeFeeBps` (§9.2) |
| Size limits | **none** — any deposit/tenor accepted; the only bounds are the `Insolvent` check and token balances | `minDeposit` / `maxDeposit` / `maxTenorBlocks` (§7) |
| Settlement | `settlePosition` at expiry reads `IMonoracle.getLatestPrice` and pays the owner | deferral → refund (§9.4) |
| Solvency | per-open invariant `pendingPayout ≤ balance` (revert `Insolvent`) | utilization / skew / position caps (§7) |
| Price safety | **none** — reads the raw canonical price | PriceAdapter: bond floor, freshness, banned provider, circuit breaker (§8) |
| Params / ops | constructor constants | risk-param timelock, factory, veto bot, keeper, UI (§7, §8.5, §15) |

**The pool is single-asset.** The vault holds exactly one token: the settlement asset `Q`, called
`settlementToken` (e.g. USDC, or the test HKD token). Every deposit, premium, payoff and equity
figure is denominated in `Q`; only `Q` is ever transferred. The price-pair base `B`, called
`priceBase`, is **never held or moved** by the vault — it appears only as one half of the Monoracle
pair key `(B, Q)` (i.e. `(priceBase, settlementToken)`) used to read the price `P`. The oracle
needs two assets purely to *express a price* (a ratio); that does not make the pool multi-asset.
PnL is settled in the single unit `Q`. See §4.1.

**Explicitly accepted MVP risks** (state in review, do not hide):
- The MVP settlement price is the raw canonical price and is **manipulable** per §8.1;
  the MVP is a mechanics demo, not a production pool.
- With no deferral/refund, a position whose expiry has passed with no valid price cannot
  settle until a price appears — it is stuck, not refunded.
- No admission caps beyond the global solvency invariant: one large position can consume
  all free capital (it still cannot make the pool insolvent, by the invariant).
- **Settlement-timing optionality (American option).** `settlePosition` marks at the
  canonical price at *call* time, not at expiry, so a holder can settle late when the price
  is favourable; with a flat fee and a capped upside this is mispriced against the pool. Not
  covered by the manipulation risk above (the V1 adapter bounds staleness, not optionality).
  V1 must pin settlement to the expiry window (§9.3).
- **Overflow can strand a position.** A pathological price/amount reverts `_payout` (checked
  math); the position then never settles and its `maxPayout` stays reserved. Cost is ~1:1
  with the trader's own premium, so it is a bounded grief, not a solvency break.
- **Direct donations are stranded.** Quote tokens sent straight to the vault are not counted
  in `balance` and cannot be swept.

---

## 2. Why a pool, and what changes

### 2.1 The gap

The grant application states: *"A liquidity pool acts as the counterparty to traders,
allowing users to open and close long or short positions within the pool's available capital
and risk limits."* The deployed V0.9 system does not have this. In V0.9 the counterparty is
the **bot's bilateral collateral on a single Monoracle quote**: each trade consumes one whole
quote, position size equals quote size, and the bot must continuously restock quotes.

That model works for a demo and has one excellent property (zero-sum, no insolvency
possible). It does not scale:

| Limitation of V0.9 | Why it blocks the product |
|---|---|
| Size = quote size | A trader cannot choose a size; partial fills need fractional veto (explicitly out of scope) |
| Capital is locked per quote | Un-vetoed quotes lock collateral until expiry (`sc-tech-spec.md` §5.1, B12) |
| One counterparty, one operator | Not a permissionless liquidity venue; LP capital cannot participate |
| No risk-parameter surface | No place to express "how much directional risk will this market take" |

### 2.2 What the pool adds

- **Fractional, user-chosen size** within `[minDeposit, maxDeposit]`.
- **Pooled capital**: any LP can deposit settlement-token liquidity and earn the spread.
- **Explicit, enforceable risk limits**: utilization, net skew, per-position cap — the things
  a grant reviewer will ask about when the underlying has no external hedge.
- **Bounded, computable worst case**: at every block, the pool's maximum obligation is
  `pendingPayout`, readable on-chain. LP worst case per round is knowable in advance.

### 2.3 Relationship to the veto-market (V0.9)

**Additive, not a replacement.** Keep `contracts/IRMarket.sol` (veto wrapper) as-is for the
demo path. The pool is a separate module:

- **V0.9 path:** Monoracle is *both* the venue and the price. Trade = veto.
- **Pool path:** Monoracle is *only* the price. Trade = vault position.

Do not mix them in one position. A vault must not settle against a quote it submitted
(LP-06), and a vault must not use the veto wrapper as its liquidity mechanism.

---

## 3. Architecture

```
                    ┌───────────────────────────────┐
                    │  Monoracle (upstream)         │
                    │  quotes / veto / settleValid  │
                    │  latestValidQuoteId(pairKey)  │
                    └───────────┬───────────────────┘
                                │ price (bonded, WAD 1e18)
                                ▼
    ┌──────────────────────────────────────────────────────────────┐
    │  MonoraclePriceAdapter (per market)                          │
    │  • minQuoteNotional  • maxPriceAgeBlocks                     │
    │  • circuit breaker (maxJumpBps)  • bannedProvider            │
    │  • OWNS breaker state: lastAcceptedPrice / pausedUntil       │
    │  • peek() view (UI) / readAndUpdate() state-changing (gate)  │
    └───────────┬──────────────────────────────────────────────────┘
                │ readAndUpdate() → (price, observedAt, valid, reason)
               ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  Vault (one per market, isolated)          IRMarketVault.sol │
   │  • LP shares (ERC20)      • open/close/settle/refund         │
   │  • admission control      • pendingPayout accounting         │
   └───────┬──────────────────────────────────┬───────────────────┘
           │ deposit / withdraw               │ open / close / settle
           ▼                                  ▼
      ┌─────────┐                        ┌─────────┐
      │   LP    │                        │ Trader  │
      └─────────┘                        └─────────┘

   PoolFactory.sol — permissionless createVault(base, quote, adapter, riskParams)
   Operator (off-chain): veto bot + settlement keeper   ← see §8.5, §12
```

**Isolated vaults, not one global pool (LP-01).** Each market gets its own vault and its own
LP token. Rationale: markets are permissionless and the underlyings are heterogeneous and
partly toxic; a single shared pool would let one bad asset drain every LP. Isolation also
makes LP risk legible ("I am providing liquidity for AI compute, not for everything"). The
cost is fragmented liquidity, accepted for V1; a meta-pool allocator is a V2 concern.

---

## 4. Product contract: the capped linear option

### 4.1 Notation

| Symbol | Meaning |
|---|---|
| `Q` | settlement token (`settlementToken`; the Monoracle quote asset, e.g. HKD / USDC) — all amounts in **native units** |
| `P` | price, **WAD 1e18**, quote-native per base-native (`Monoracle.price`) |
| `D` | deposit paid by trader, native `Q` |
| `f` | `feeBps` — spread charged by the pool |
| `N` | notional at risk = `D − fee`, native `Q` |
| `U` | units = `N × 1e18 / P0` — base-native exposure shown in the UI (matches PRD "份数 = 投入 ÷ 开仓参考价") |
| `S0` | entry price, `S` | settlement / close price |

All arithmetic is in native units; the WAD price is never mixed with token decimals
(see §13.1 for the decimals trap).

**Single-asset pool.** Only `Q` (`settlementToken`) is ever held or moved; `B` (`priceBase`) is a
price-pair reference, not a pool asset. The oracle's `(B, Q)` pair — `(priceBase, settlementToken)`
on the vault — is how a price is *expressed* (a ratio), not an indication that the vault is
multi-asset: the vault has no balance of `B` and never transfers it. The payoff is computed from
`P` but paid entirely in `Q`.

### 4.2 Payoff (LP-02, LP-03)

```
fee        = D × feeBps / 10_000                    // floor, accrues to LP equity at open
notional N = D − fee
units    U = N × 1e18 / S0                          // informational, base-native

r    = (S − S0) / S0                                // WAD return
pnl  = LONG  ? N × r : N × (−r)                     // native Q, signed
pnl  = clamp(pnl, −N, +N × maxProfitBps / 10_000)   // ← the cap
payout = N + pnl                                    // ∈ [0, N × (1 + maxProfitBps/10_000)]
```

With `maxProfitBps = 10_000` (V1 default, LP-03): `payout ∈ [0, 2N]`.

| Scenario | `S` | LONG payout | SHORT payout |
|---|---|---|---|
| Flat | `S0` | `N` (trader loses the fee) | `N` |
| Long wins the cap | `2·S0` | `2N` | `0` |
| Long wins beyond cap | `5·S0` | `2N` (**capped**) | `0` |
| Underlying to zero | `0` | `0` | `2N` (**capped**) |

**The `S = 0` row is a limit, not a reachable state.** On-chain a canonical `settlePrice == 0`
means "no trustworthy quote": it reverts `PriceUnavailable` rather than paying the `S = 0`
payout, and integer flooring keeps `payout` strictly inside `[0, 2N]` for every positive price
(at the closest reachable point, `S = 1 wei`, a LONG floors to `1 wei` and a SHORT to
`2N − 1 wei`). The row is the continuous mathematical limit as `S → 0⁺`.

**Why the cap is not cosmetic.** Without it the pool's liability on a single position is
unbounded, on assets that by hypothesis have no external hedge. With it, the pool's
obligation is bounded at open time, which is what makes `pendingPayout` a meaningful number
and what makes LP risk quotable. The economic trade is honest: the trader gives up the
right tail in exchange for a product that exists at all on an asset with no venue.

### 4.3 What the trader is buying

A **1× notional, capped-linear payoff with max loss = premium paid**. No liquidation, no
margin call, no forced close — matching the README's "无爆仓、无保证金追缴，最大亏损即本金".
Because max loss is prepaid, the position cannot become a liability to anyone; the pool's
worst case is that it pays `2N` and keeps `fee`.

### 4.4 What the LP is selling

LPs are short a bounded, short-dated payoff on an asset with **no external hedge**
(§8.6). Their expected return is the fee minus realized losses. Because the payoff is
capped and symmetric around the entry price, and because the underlying over a 3-minute
tenor is close to a martingale, the pool's edge is the fee — **but only if flow is not
adversely selected**. Adverse selection (a trader who knows news is about to drop) is
the dominant residual risk and is bounded, not eliminated, by §7.

---

## 5. Fees

| Field | Rule |
|---|---|
| Base | `D` (deposit), in settlement token |
| `feeBps` | per-market risk parameter; V1 default 100 (1%), consistent with the V0.9 wrapper |
| Accrual | **At open.** `fee` is retained by the pool immediately; only `N` is at risk. Note accounting equity still *drops* by `2N − D` at open (worst-case reservation, §6.5) and recovers at settlement — the fee is realised, the dip is not |
| Close fee | `closeFeeBps` additionally on early close (LP-07); V1 default 50 (0.5%) |
| Protocol cut | `protocolFeeBps` of the fee, to a `treasury` address (a `RiskParams` field, changeable only via the timelocked path §7); V1 default 0 (**LP-D4**) |
| Rounding | fee rounds **down** (favours trader); payout rounds **down** (favours pool) |

Rationale for accruing at open rather than at settlement: it keeps `equity` monotone with
respect to realised business and prevents a trader from reclaiming fee income by holding a
position through a settlement that never arrives.

---

## 6. Pool accounting and LP shares

### 6.1 State (per vault)

```solidity
struct PoolState {
    uint256 balance;             // cached counter; token.balanceOf(vault) ≥ balance always
                                // (direct donations only add, never desync the accounting)
    uint256 pendingPayout;       // Σ over OPEN positions of maxPayout_i
    uint256 openLongNotional;    // Σ notional of OPEN LONG
    uint256 openShortNotional;   // Σ notional of OPEN SHORT
    int256  realizedPnl;         // cumulative (fees − net payouts), signed, for analytics
}
// Circuit-breaker state (lastAcceptedPrice, pausedUntil) and the adapter's price
// parameters live in the PriceAdapter (§8.3) — the vault reads them through the
// adapter and does not mirror them.
```

Per position: `maxPayout = N × (10_000 + maxProfitBps) / 10_000`.

### 6.2 Equity — conservative, not mark-to-market (LP-04)

```
equity = balance − pendingPayout
```

`pendingPayout` is the **worst-case** obligation (every open position resolves maximally
against the pool), not the marked obligation. Consequences:

- **Pro:** LP share value cannot be moved by the price feed. There is no "withdraw just
  before the mark" exploit, no keeper, no per-position marking pass. Share value changes
  only through deposits, withdrawals, settlements and fees.
- **Con:** capital efficiency is lower than MTM. This is bounded by the utilization cap
  (§7): with `utilizationCapBps = 5_000`, `equity ≥ 50% × balance` at all times, so LPs can
  always withdraw at least half the pool's token balance.
- **V1.1 option:** MTM equity with a keeper-updated obligation accumulator and
  snapshot-on-request withdrawals. Deferred; it reintroduces feed dependence into the share
  price.

### 6.3 Shares

Standard pro-rata, first-depositor-safe (mint `shares = amount` when `totalShares == 0`;
optionally burn a minimal seed on creation to make inflation attacks uneconomic — **LP-D5**).

```
deposit:  shares = amount × totalShares / equity      (equity measured before the deposit)
burn:     amount = shares × equity / totalShares      (equity measured at claim, not request)
```

When `totalShares > 0` but `equity == 0` (the pool is fully reserved or fully lost), a 1:1
mint would silently donate most of a new deposit to incumbent LPs; the MVP `deposit` reverts
`DepositAtZeroEquity` instead.

### 6.4 Withdrawal queue (LP-05)

Two-step: `requestWithdraw(shares)` → `claimWithdraw()`.

- `unlockBlock = block.number + withdrawDelayBlocks`, where
  `withdrawDelayBlocks ≥ maxTenorBlocks + settlementGraceBlocks`.
- **No amount snapshot at request time** — the claim values shares at claim-time equity, so
  the LP (not the pool) carries whatever settles during the delay. Combined with conservative
  equity (§6.2) this makes the pool safe under every ordering.
- Free-capital check at claim: `amount ≤ balance − pendingPayout`. Because
  `equity ≡ balance − pendingPayout` (§6.2) and `shares ≤ totalShares`, this can never
  bind — it is kept as an **assertion** (an invariant to test, §14), not a separate rule.
- `withdrawDelayBlocks` also removes the "deposit → open a huge position → withdraw" round
  trip inside one block, and any same-block share-price manipulation.

### 6.5 The equity dip at open — and deposit-side dilution

Opening a position adds `D` to `balance` and `2N` to `pendingPayout`, so:

```
Δequity(open)        = D − 2N = 2·fee − D      ≈ −D    (worst-case reservation)
Δequity(open→settle) = fee − pnl                      (recovers to realized P&L)
```

The fee is realized immediately, but accounting equity *drops* by almost the full deposit at
every open. This has a consequence that must be stated rather than hidden:

**Deposit-side dilution.** Anyone may deposit while positions are open and buy shares at
the dipped, worst-case equity. When those positions settle better than worst case (almost
always), the recovery is shared pro-rata with the newcomer — a wealth transfer from
incumbent LPs to whoever deposits into an open window. The newcomer's worst case is roughly
break-even (the reservation realizes fully) and the expected value is positive, so on a
permissionless vault this is a repeatable harvest. **The two-step withdrawal queue (§6.4)
does not address it — it is a deposit-side problem.**

Worked example (numbers from the MVP tests): LP1 deposits 1000 (1000 shares); a LONG opens
with `D = 100` → equity dips to 902; LP2 deposits 902 and mints 1000 shares; flat settle →
LP1 claims 951.5 (−48.5) while LP2 claims 951.5 (+49.5) — LP2 harvested LP1's reservation
recovery at near-zero risk.

Mitigations (choose one before V1 — LP-D14):

1. mint deposit shares against **marked** (not worst-case) equity — reintroduces feed
   dependence into the share price (§6.2 V1.1);
2. **epoch accounting**: mint at the equity of the last block with no open positions;
3. **deposit delay** symmetric to withdrawals (request → wait → shares at claim-time equity);
4. accept and disclose (demo scale only).

**MVP decision: accept and disclose** — the MVP has instant, permissionless
deposit/withdraw, so the harvest is a two-transaction pair; it is accepted for the demo
(plan §6, risk 8) and covered by an explicit M5 test so the behaviour is visible.

---

## 7. Admission control and risk parameters

Every check below runs in `openPosition`. Failing any one reverts with a distinct error.

| Parameter | Default | Rule |
|---|---|---|
| `minDeposit` / `maxDeposit` | market-specific | bounds `[minDeposit, maxDeposit]` |
| `maxTenorBlocks` | 600 @300ms (3 min) | tenor ≤ cap; longer tenor = more drift, more adverse selection |
| `utilizationCapBps` | 5 000 | `pendingPayout + maxPayout_new ≤ (balance + D) × cap / 10_000` |
| `maxPositionBps` | 500 (5%) | `maxPayout_new ≤ equity_after × cap / 10_000` |
| `maxSkewBps` | 2 000 (20%) | `|longNotional − shortNotional|_after ≤ equity_after × cap / 10_000` |
| `maxGrossOiBps` | — | **not a stored param**: derived on-chain as `(openLongNotional + openShortNotional) × 10_000 / equity`; utilization is the binding constraint |

**Net skew is the risk that matters (LP-08).** Long and short notional of equal size cancel:
the pool pays the winners out of the losers' notional. Only the *net* is directional
exposure, and it is exposure the pool **cannot hedge** — for the target assets there is no
venue to hedge in (§8.6). So the skew cap, not the gross cap, is the control that actually
bounds the pool's real risk. Gross exposure matters only because it consumes capital
(utilization).

**Utilization is what keeps withdrawals available (LP-09).** Because equity is measured
conservatively, an uncapped `pendingPayout` could drive equity to zero and freeze all LP
withdrawals. The utilization cap makes `equity ≥ (1 − cap) × balance` an invariant.

Parameters are set at vault creation and changeable only through a **timelocked, vault-local
update path** (propose → wait `paramDelayBlocks` → apply) so that LPs cannot have the terms of
their existing capital changed under them (**LP-D6**: exact governance shape — per-vault
param owner elected by LP shares, vs immutable params with new vaults for new terms).
`paramDelayBlocks` and `treasury` are fields of `RiskParams` (§10); the param owner can
never move user funds (§1.3).

---

## 8. Price adapter — the crux of the design

### 8.1 The problem

Monoracle's canonical price is `latestValidQuoteId[pair]` — the **most recently settled
quote that nobody vetoed**. Submission is permissionless and settlement is permissionless,
and nothing requires the quote to be large:

> An attacker can `submitQuote` at any price with minimal collateral, wait out the window,
> call `settleValidQuote`, and `getLatestPrice` now returns that price. (Upstream's
> `QuoteAmountTooSmall` floor makes "1 wei" literally impossible — the value is not
> recorded in this repo yet, see §8.2.1 — but the floor is a convenience, not a control.)

For a UI display this is tolerable. For a pool that pays out real money against this number
it is fatal: open a large long, push the canonical price up, settle, collect. **The pool must
not consume the raw canonical price.** This is the single most important constraint in the
whole design.

### 8.2 What Monoracle actually guarantees

The veto mechanism makes a *wrong* quote a *profitable arbitrage* for anyone watching.
Provider quotes `price = P(1+d)` with collateral `baseAmount B`, `quoteAmount Q`:

- Veto (`vetoOverpriced`): verifier pays `B` base, receives `Q` quote.
  Verifier profit `= Q − Q/(1+d) = Q × d/(1+d)`.
- Symmetrically for underpricing by `d'`: profit `= Q × d'/(1−d')`.

So **the cost of publishing a false price is `quoteAmount × d/(1+d)`, paid to the first
verifier who notices**. That is the property the pool must exploit: the price is not trusted,
it is *bonded*. The adapter's job is to require the bond to be big enough.

### 8.2.1 Upstream gates that already exist (and the ones we add)

The upstream ABI pinned in `abi/Monoracle.abi.json` already enforces gates this design must
not assume away:

| Gate | Value / semantics | Consequence for the adapter |
|---|---|---|
| `VERIFICATION_SLOTS` | `2` blocks (~600 ms @300 ms) — the veto window is **fixed and short** upstream | a watching verifier has ~2 blocks to veto; see §8.5.1 |
| `MAX_VERIFICATION_SLOTS` + `ExpiryTooFar` | `expiryBlock` is bounded, not arbitrary | no long-window quotes on upstream; the deprecated IRMarket fork (per-quote `expiryBlock`) no longer exists in this repo (removed in CWV-01, `todo.md`) |
| `QuoteAmountTooSmall` | upstream rejects small `quoteAmount` at `submitQuote`; the floor value is **not recorded in this repo** | §8.1's "1 wei" attack is likely impossible upstream; record the floor value from upstream source during P0 — our `minQuoteNotional` (§8.4) is set well above it, so both gates apply |

Net effect: the attacker must clear the upstream floor **and** our bond floor. The upstream
floor is a convenience, not a control — it is undocumented here and can change; the
adapter's own `minQuoteNotional` check remains mandatory.

### 8.3 Adapter rules (V1, fully on-chain; one permissionless state-changing read)

The adapter is the **single source of truth** for every price parameter and for the
circuit-breaker state. The vault never stores a price, a baseline, or a pause flag.

```solidity
enum RejectReason {
    NONE, NO_QUOTE, NOT_SETTLED, BANNED_PROVIDER, BELOW_BOND, STALE, PAUSED, TRIPPED_QUOTE
}

// View — for the UI and quoteOpen only. Never gate money on this alone: it cannot trip
// the breaker and cannot emit PriceRejected.
function peek() external view returns (uint256 price, uint64 observedAt, bool valid, RejectReason reason);

// State-changing — the ONLY price path openPosition / closePosition / settlePosition may use.
// Permissionless: anyone (keeper, trader, operator) may call it; it holds no funds.
function readAndUpdate() external returns (uint256 price, uint64 observedAt, bool valid, RejectReason reason) {
    (uint256 qid, price, observedAt, valid, reason) = _read();
    if (!valid) { emit PriceRejected(qid, reason); return (0, 0, false, reason); }

    if (trippedQuoteId != 0) {
        // resuming: the first canonical quote that is NOT the tripped one becomes the new
        // baseline, with the jump check bypassed exactly once (§8.8).
        trippedQuoteId = 0;
    } else if (lastAcceptedPrice != 0 && _deviationBps(price, lastAcceptedPrice) > maxJumpBps) {
        pausedUntil = uint64(block.number) + circuitBreakerCooldownBlocks;
        trippedQuoteId = qid;                        // §8.8: never accept this quote again
        emit CircuitBreakerTripped(price, lastAcceptedPrice, pausedUntil);
        return (0, 0, false, RejectReason.PAUSED);   // this call fails closed
    }

    lastAcceptedPrice = price;                       // baseline advances only on accept
    return (price, observedAt, true, RejectReason.NONE);
}

function _read() internal view returns (uint256 qid, uint256 price, uint64 observedAt, bool valid, RejectReason reason) {
    if (block.number < pausedUntil) return (0, 0, 0, false, RejectReason.PAUSED);
    bytes32 key = keccak256(abi.encodePacked(priceBase, settlementToken));
    qid = IMonoracle(oracle).latestValidQuoteId(key);         // public mapping
    if (qid == 0) return (0, 0, 0, false, RejectReason.NO_QUOTE);

    Quote memory q = IMonoracle(oracle).quotes(qid);
    if (qid == trippedQuoteId)                  return (0, 0, 0, false, RejectReason.TRIPPED_QUOTE); // §8.8
    if (q.status != QuoteStatus.SETTLED_VALID) return (qid, 0, 0, false, RejectReason.NOT_SETTLED);
    if (q.provider == bannedProvider)          return (qid, 0, 0, false, RejectReason.BANNED_PROVIDER); // LP-06
    if (q.quoteAmount < minQuoteNotional)      return (qid, 0, 0, false, RejectReason.BELOW_BOND);    // LP-10, the bond
    if (block.number > q.settledSlot + maxPriceAgeBlocks) return (qid, 0, 0, false, RejectReason.STALE);
    return (qid, q.price, q.settledSlot, true, RejectReason.NONE);
}
```

| Rule | ID | Purpose |
|---|---|---|
| `status == SETTLED_VALID` | — | only a survived-the-window quote is canonical |
| `quoteAmount ≥ minQuoteNotional` | LP-10 | **bond floor** — see §8.4 |
| `block.number − settledSlot ≤ maxPriceAgeBlocks` | LP-11 | refuse stale marks |
| `provider ≠ bannedProvider` | LP-06 | the vault's operator must not price its own book — see below |
| circuit breaker on `\|Δ\| > maxJumpBps` | LP-12 | pause on implausible jumps; the tripped quote is never re-accepted (§8.8) |

**Adapter state and parameters** (immutable unless noted): `oracle`, `priceBase`,
`settlementToken`, `minQuoteNotional`, `maxPriceAgeBlocks`, `maxJumpBps`,
`circuitBreakerCooldownBlocks`, `bannedProvider`. Mutable: `lastAcceptedPrice`,
`pausedUntil`, `trippedQuoteId`, and `vault` (set once via `bindVault`). The factory
validates `adapter.priceBase()/settlementToken()` against the vault's pair and calls `bindVault`
exactly once — an adapter serves exactly one vault, and a vault one adapter.

**Event spam:** `readAndUpdate()` is permissionless, so anyone can emit `PriceRejected`.
Indexers must dedupe on `(quoteId, reason)`; the adapter may rate-limit emissions to one per
`(quoteId, reason)` pair (implementation detail).

**LP-06 semantics.** A contract cannot `submitQuote` (it holds no trading collateral), so
"the vault's own quote" is operationally "a quote from the vault's **operator**" — the one
entity that both provides quotes and runs the vault. `bannedProvider` is therefore the
operator EOA, fixed at adapter creation and surfaced in the UI. The adapter is created
before the vault (factory order), so it cannot ban the vault address itself; banning the
operator covers the real conflict. **Exception (§8.6.1):** for an asset with no crypto-native
on-chain token and no RWA-mapping token there is no independent provider, so the LP is the
only permitted price provider and `bannedProvider` is left unset for that vault.

**Integration status (LP-D1 — resolved from local artifacts):** `latestValidQuoteId(bytes32)`
and `quotes(uint256)` are both public on the upstream Monoracle — see
`abi/Monoracle.abi.json` (view, `bytes32 → uint256`; full `Quote` tuple). The pair key is
`keccak256(abi.encodePacked(priceBase, settlementToken))`, confirmed by
`test/MonoracleMock.test.js` and `contracts/test/MonoracleMock.sol`. The earlier note about
`contracts/Monoracle.sol` is obsolete: the fork was deleted in CWV-01 (`todo.md`); the
adapter is pinned to the **upstream ABI only**. Remaining P0 work is operational, not
structural: an on-chain `eth_call` against the deployment the vault will use (currently
`0x2b5a…`, `web/tests/helpers/addresses.json`) plus the deployment/window decision recorded
in §8.5.1. If a future deployment ever drops `latestValidQuoteId`, fall back to §8.7
(QuorumAdapter) rather than weakening the bond check.

### 8.4 Sizing `minQuoteNotional` (LP-10)

Let `M` = the attacker's **aggregate net gain** — not the per-position cap, and not the pool's
loss. One manipulated canonical price settles *every* position the attacker holds on the
pair at once, and §7's caps are enforced on the vault's aggregate state (splitting across
EOAs does not help). `M` must be derived under two cases, because the skew cap alone does not
bound it:

**(a) No counterflow (attacker is the whole book).** Skew caps net notional directly:

```
M_a = maxProfitBps/10_000 × maxSkewBps/10_000 × equity
    = 0.20 × equity                      (V1 defaults: maxSkewBps = 2 000, maxProfitBps = 10 000)
```

**(b) With honest counterflow (the binding case).** Skew caps *net* notional
(`L − S ≤ maxSkewBps/10_000 × equity`), so honest SHORT flow lets an attacker's long book
exceed the skew bound: `L ≤ (N_total + skew)/2`, while utilization caps the gross book
(`pendingPayout = 2·N_total ≤ utilizationCapBps/10_000 × balance`, and
`equity ≥ (1 − utilizationCapBps/10_000) × balance`):

```
L    ≤ (utilCap/(2·(1 − utilCap)) + maxSkewBps/10_000)/2 × equity
     = (0.50 + 0.20)/2 × equity = 0.35 × equity        (V1 defaults: utilCap = 5 000)
M_b  = maxProfitBps/10_000 × L ≈ 0.35 × equity
```

The attacker's gain in (b) is partly funded by the honest shorts' losses — the pool's own
loss stays bounded by skew (≤ 0.20 × equity) — but the *deterrence* condition is on the
attacker's gain, not the pool's loss, so **case (b) is the sizing case**. (Attacker-funded
shorts do not expand the book: their longs' gain cancels 1:1 against their shorts' loss.)

The attack is unprofitable when `minQuoteNotional × d/(1+d) > M` for the `d` the attacker
needs; the worst case is the payoff cap `d = maxProfitBps/10_000` (= 1 at the V1 default):

```
minQuoteNotional  ≥  M × (1 + d) / d     with d = maxProfitBps / 10_000
                  =  2 × M   at the V1 default
                  =  0.40 × equity   without counterflow (case a)
                  =  0.70 × equity   with full counterflow (case b)
```

**Default rule — always size against case (b):**

```
minQuoteNotional ≥ (1+d)/d × maxProfitBps/10_000
                 × (utilCapBps/10_000/(2·(1 − utilCapBps/10_000)) + maxSkewBps/10_000)/2
                 × equity                                 // ≈ 0.70 × equity at V1 defaults
```

The naive per-position reading (`2 × maxPositionBps × equity` = 0.10 × equity) is 4–7×
too small — the per-position cap is *not* the binding constraint on attack gain, the
aggregate book is. This is only affordable if LPs accept a bond floor of the same order as
vault equity; if that is unacceptable, the alternatives are a lower `maxSkewBps`, a lower
`maxProfitBps`, a lower `utilizationCapBps`, or the QuorumAdapter (§8.7) — see LP-D11.

**The cross-vault gap (LP-D12).** The canonical price is **global to the pair**, while
vaults are per-market and the factory is permissionless with no pair dedup: anyone can
deploy a second vault on the same pair. Each vault sizes its own bond floor against its own
equity, so in aggregate the bond can sit far below the pair-wide exposure an attacker can
farm. V1 mitigations (both required, neither sufficient alone): the factory/UI must warn on
and deprioritize duplicate-pair vaults, and `minQuoteNotional` must be sized against the
*largest* vault on the pair, not the deploying vault's equity. The structural fix is the
per-pair QuorumAdapter (§8.7), promoted from V1.1 if duplicate-pair vaults become common.

Two caveats to state honestly rather than hide:

1. **The bound assumes at least one honest, solvent, watching verifier.** It is not a
   cryptographic guarantee — and on upstream the window is only ~2 blocks (§8.2.1), which
   makes this assumption weaker than it looks. See §8.5.1.
2. **Front-loading does not help the attacker.** Submitting the false quote *before* opening
   the position moves the entry price too, so the required deviation from `S0` is unchanged.

### 8.5 The vault operator must run a veto bot (LP-13)

The pool is the party with the most to lose from a corrupted price, so the pool is the party
that must watch. Running a `bot/verifier.py`-style veto bot against every quote on the
vault's pair raises the attacker's expected cost by the `Q × d/(1+d)` penalty. This is an
**operational requirement of the vault, not an optional extra**, and belongs in the runbook
and in the grant's risk section. §8.5.1 states honestly what it can and cannot guarantee.

### 8.5.1 What the veto bot can actually guarantee (LP-13, sharpened)

The current bot polls every `QUOTE_INTERVAL_SECONDS` (default **5 s**, `bot/verifier.py`).
Upstream Monoracle's veto window is `VERIFICATION_SLOTS = 2` blocks ≈ **600 ms** (§8.2.1).
A 5-second poll therefore **cannot reliably veto inside the window** — assumption (1) in
§8.4 is, with today's bot, closer to a hope than a guarantee. Closing the gap requires one
of:

1. **Re-architect the bot for sub-second reaction** (streaming RPC / mempool watch instead
   of polling) — required if the vault targets upstream Monoracle;
2. **Target a long-window deployment** (per-quote `expiryBlock` in the minutes) — the
   deprecated IRMarket fork is gone (CWV-01), so this means a new upstream flag or a
   re-fork, both out of V1 scope;
3. **Accept the weaker guarantee** and compensate with a larger `minQuoteNotional` (§8.4)
   and lower `maxSkewBps` / `maxProfitBps`.

**P0 must record which deployment the vault targets and which of (1)–(3) is chosen.**
Until then, treat the bond floor — not the bot — as the primary control (LP-D10).

### 8.6 Why there is no hedge — and why that is stated, not solved (LP-14)

For the target assets (AI compute, frontier labs, pre-listing equities, RWA) there is
**no external venue to hedge in**. That is the premise of the whole project. Therefore:

- The pool's directional exposure is real and unhedgeable.
- The only controls are structural: bounded per-position payout, skew caps, short tenor,
  bonded settlement price, utilization caps.
- This must be disclosed to LPs and stated plainly in the grant. A pool that claimed to be
  delta-neutral on these assets would be lying.

### 8.6.1 Who may provide the price — tokenless assets (the LP-06 exception)

Price provision depends on whether the asset has an on-chain representation:

| Asset kind | Independent provider possible? | Who provides the price |
|---|---|---|
| Crypto-native on-chain token | yes — anyone can quote the `(base, quote)` pair | independent providers; the LP/operator is **banned** (`bannedProvider`, LP-06) |
| RWA-mapped token (tokenized stock / RWA) | yes — a token exists to quote | independent providers; the LP/operator is banned |
| **No crypto-native token and no RWA mapping** | **no** — there is no ERC20 to quote and no external venue | **only the LP** (the vault's liquidity provider / operator) |

For an asset with **no crypto-native on-chain asset and no RWA-mapping token**, there is no
independent price source: no token pair exists for a third party to quote and no external
venue exists (§8.6). Therefore **only the LP is allowed to provide the price** — the LP
submits the Monoracle quotes for the pair — and this is the **single deliberate exception to
LP-06** (the pool must not price its own book). `bannedProvider` is left unset for such a
vault.

Safety for these assets rests entirely on the bonded, veto-arbitraged mechanism, so all of
it still applies: the `minQuoteNotional` bond floor (§8.4), freshness (§8.3), the circuit
breaker (§8.8), and the operator veto bot (§8.5). Because the LP is simultaneously
counterparty *and* price provider, the conflict is concentrated and must be disclosed: the
only defence is that a wrong quote is a profitable veto for any watcher, and the LP's own
exposure is bounded by the §7 risk caps. Where a crypto-native or RWA-mapped token *does*
exist, LP-06 applies in full and the LP/operator must not be the quote provider.

### 8.7 V1.1: QuorumAdapter (median across providers)

Single-provider canonical price is still one point of failure. V1.1 adds an on-chain ring
buffer of accepted observations, fed permissionlessly:

```
acceptObservation(quoteId)   // keeper: verifies status, quoteAmount ≥ minQuoteNotional,
                             // provider not already present in the current window
getConsensusPrice()          // median of observations in [now − windowBlocks, now],
                             // requires ≥ minProviders distinct providers
```

Median (not VWAP) so that a single large attacker cannot outweigh honest providers. Ship
only after V1 is live and instrumented.

### 8.8 Circuit breaker (LP-12)

The breaker state (`lastAcceptedPrice`, `pausedUntil`, `trippedQuoteId`) lives in the
**adapter** (§8.3) and is advanced only inside `readAndUpdate()`. If an accepted price
deviates from `lastAcceptedPrice` by more than `maxJumpBps`:

- set `pausedUntil = block.number + circuitBreakerCooldownBlocks` and
  `trippedQuoteId = qid`, and return `PAUSED` — the triggering call fails closed;
- while paused: `openPosition` and `closePosition` revert with `MarketPaused`;
  `settlePosition` **also reverts** (see §9.4 — settlement falls through to deferral, never
  to a bad price);
- **the tripped quote is never accepted again**: after the cooldown, `_read()` keeps
  returning `TRIPPED_QUOTE` for it while it remains canonical, so a manipulated price cannot
  be settled against merely by waiting out the pause — affected positions fall through to
  deferral → refund (§9.4), which is the intended fail-closed behaviour;
- **resume with one bypass:** the first *different* canonical quote that passes the §8.3
  rules becomes the new baseline, with the jump check bypassed exactly once. A legitimate
  large move therefore recovers with a single fresh quote (the provider/bot's steady-state
  job). An attacker can also resume by re-submitting the same false price as a *new* quote —
  but that costs a **second full bond** and must survive a **second veto window** (§8.4,
  §8.5), so the breaker's job is to force that cost and to fail-close in between, while the
  bond floor remains the economic control.

Because only `readAndUpdate()` can trip or advance the breaker, the baseline can never move
without a real, validated price read — a view-only `peek()` cannot groom it.

---

## 9. Lifecycle

### 9.1 Open

1. `adapter.readAndUpdate()` → valid, fresh, not paused. Else revert with the mapped error
   (`PriceUnavailable` for `NO_QUOTE`/`NOT_SETTLED`, `QuoteBelowBondFloor`, `PriceStale`,
   `SelfQuotedPrice`, `MarketPaused`, `QuoteBannedByBreaker` — §8.3 reason codes).
2. Validate `D ∈ [minDeposit, maxDeposit]`, `tenor ≤ maxTenorBlocks`.
3. Compute `fee`, `N`, `U`; compute `maxPayout`.
4. Run §7 admission checks; revert with the specific error on failure.
5. `safeTransferFrom(trader, vault, D)`; `balance += D`; `pendingPayout += maxPayout`;
   update side notionals; credit `fee` to equity (implicitly: it is in `balance` but not in
   `pendingPayout`).
6. Store `Position`; emit `PositionOpened`.

### 9.2 Early close (LP-07)

`closePosition(positionId)`: mark at the current valid price, compute payout per §4.2, deduct
the close fee, transfer, release `pendingPayout`. Same price rules and same pause rules as
open. Permissionless (anyone may close a position; proceeds go to the owner) so that keeper
infrastructure can enforce risk limits — but note the griefing consideration in §12.

```
closeFee = min(N × closeFeeBps / 10_000, payout)     // clamped: a 0-payout close pays no fee
payout   = payout − closeFee                          // closeFee accrues to LP equity (§5)
```

### 9.3 Settlement at expiry

`settlePosition(positionId)` — permissionless keeper call, `block.number ≥ expiryBlock`:

1. `adapter.readAndUpdate()` → if valid: compute payout, transfer to owner, release
   `pendingPayout`, update `realizedPnl`, emit `PositionSettled(positionId, price, payout)`.
2. If not valid: **do not settle.** Go to §9.4.

### 9.4 Deferral and refund (LP-15)

A position whose expiry has passed but for which no trustworthy price exists enters
`AWAITING_PRICE`. A keeper retries. If `block.number > expiryBlock + settlementGraceBlocks`
still without a valid price, `refundPosition(positionId)` becomes callable:

> **Refund = return `notional` to the trader, no P&L, fee retained by the pool.**

Rationale: settling at an unbonded price is catastrophic; refusing to settle forever is a
grief. Refunding the stake is the bounded, honest failure mode, and the trader's downside is
limited to the fee. `settlementGraceBlocks` should be short (a few minutes) so positions do
not sit open indefinitely.

---

## 10. Contract surface (sketch)

```solidity
// --- PoolFactory -------------------------------------------------------------
function createVault(
    address priceBase,
    address settlementToken,
    address priceAdapter,       // Monoracle-backed, per market; factory asserts
                                // adapter.priceBase()==priceBase, adapter.settlementToken()==settlementToken,
                                // adapter.vault()==0, then calls adapter.bindVault(vault) once
    RiskParams calldata params
) external returns (address vault);

// --- MonoraclePriceAdapter ---------------------------------------------------
function peek() external view returns (uint256 price, uint64 observedAt, bool valid, RejectReason reason);
function readAndUpdate() external returns (uint256 price, uint64 observedAt, bool valid, RejectReason reason);
function bindVault(address vault) external;          // factory-only, one-shot
function pausedUntil() external view returns (uint64);
function lastAcceptedPrice() external view returns (uint256);

// --- IRMarketVault -----------------------------------------------------------
function deposit(uint256 amount) external returns (uint256 shares);
function requestWithdraw(uint256 shares) external;
function claimWithdraw() external returns (uint256 amount);

function openPosition(uint8 side, uint256 depositAmount, uint64 tenorBlocks)
    external returns (uint256 positionId);
function closePosition(uint256 positionId) external returns (uint256 payout);
function settlePosition(uint256 positionId) external returns (uint256 payout);
function refundPosition(uint256 positionId) external returns (uint256 amount);

function proposeParams(RiskParams calldata params) external;   // param owner only (§7)
function applyParams() external;                               // after paramDelayBlocks

function equity() external view returns (uint256);
function pendingPayout() external view returns (uint256);
function positions(uint256 positionId) external view returns (Position memory);
function quoteOpen(uint8 side, uint256 depositAmount) external view returns (uint256 fee, uint256 notional, uint256 units);

// --- Position ----------------------------------------------------------------
enum PositionStatus { OPEN, CLOSED, SETTLED, AWAITING_PRICE, REFUNDED }
struct Position {
    address owner; uint8 side;                 // 0 = LONG, 1 = SHORT
    uint256 deposit; uint256 fee; uint256 notional;
    uint256 entryPrice;                        // WAD 1e18
    uint64 openBlock; uint64 expiryBlock;
    PositionStatus status;
}

// --- RiskParams --------------------------------------------------------------
struct RiskParams {
    uint16 feeBps; uint16 closeFeeBps; uint16 protocolFeeBps;
    uint16 maxProfitBps;          // payoff cap, 10_000 = 1× notional
    uint16 utilizationCapBps; uint16 maxPositionBps; uint16 maxSkewBps;
    uint16 maxJumpBps;            // circuit breaker
    uint32 maxTenorBlocks; uint32 settlementGraceBlocks; uint32 withdrawDelayBlocks;
    uint32 maxPriceAgeBlocks; uint32 circuitBreakerCooldownBlocks;
    uint32 paramDelayBlocks;      // timelock on proposeParams → applyParams (§7)
    uint256 minDeposit; uint256 maxDeposit;
    uint256 minQuoteNotional;     // adapter bond floor, §8.4
    address treasury;             // protocolFeeBps recipient (LP-D4)
}
```

**MVP surface (implemented, §1.4).** The MVP is a strict subset — `IRMarketVault` with the
constructor `(oracle, priceBase, settlementToken, feeBps)`, `deposit`/`withdraw`,
`openPosition(Side, uint256, uint64)`, `settlePosition(uint256)`, `equity()`,
`pendingPayout()`, `positions(uint256)`, `positionCount()`. No adapter/factory/queue/params.
See `contracts/IRMarketVault.sol`.

Errors: `PriceUnavailable`, `PriceStale`, `QuoteBelowBondFloor`, `SelfQuotedPrice`,
`MarketPaused`, `DepositOutOfRange`, `TenorTooLong`, `UtilizationCapExceeded`,
`PositionCapExceeded`, `SkewCapExceeded`, `NotPositionOwner`, `NotExpired`,
`GracePeriodActive`, `AlreadySettled`, `InsufficientFreeCapital`, `AdapterPairMismatch`,
`VaultAlreadyBound`, `NotParamOwner`, `ParamsNotYetApplicable`, `QuoteBannedByBreaker`.

Events: `VaultCreated`, `VaultBound`, `Deposit`, `WithdrawRequested`, `WithdrawClaimed`,
`PositionOpened`, `PositionClosed`, `PositionSettled`, `PositionRefunded`,
`PriceRejected(uint256 quoteId, RejectReason reason)`, `CircuitBreakerTripped`,
`ParamsProposed`, `ParamsApplied`.

---

## 11. Chains: Monad vs Avalanche

The pool is chain-agnostic; **every block-based parameter must be re-derived per chain.**

| | Monad | Avalanche C-Chain |
|---|---|---|
| Block time | ~300 ms | ~2 s |
| 3-minute tenor | ~600 blocks | ~90 blocks |
| `maxPriceAgeBlocks` for a 30 s freshness budget | ~100 | ~15 |
| Fee model | billed by **gas limit** (set fixed limits) | dynamic base fee (post-ACP) |
| Mempool | no public mempool | public mempool → **front-running is live** (§12) |
| Settlement keeper latency | tight | looser |

Two consequences worth calling out for the grant:

- **Front-running.** Monad's local mempools mean `quoteId`-anchored fills are effectively
  see-what-you-sign (the V0.9 model). On a public-mempool chain, `openPosition` reads the
  canonical price at execution time, so a stale-but-valid price can be sandwiched between
  simulation and inclusion. Mitigations: strict `maxPriceAgeBlocks`, short tenors, and the
  optional `minPayoutOut` slippage argument on open/close — **not in the V1 surface
  (§10)**, promoted from the V1.1 list if a public-mempool chain is targeted.
- **Parameter portability.** Do not hard-code block counts. Store durations in seconds and
  convert with a per-chain `blocksPerSecond` estimate, or set params explicitly at vault
  creation.

---

## 12. Security analysis

| Vector | Mitigation |
|---|---|
| **Canonical price manipulation** (§8.1) | `minQuoteNotional` sized against aggregate attacker gain incl. counterflow (§8.4); upstream floor (§8.2.1); freshness; circuit breaker that never re-accepts the tripped quote (§8.8); operator veto bot with the §8.5.1 caveat |
| Unbounded liability | payoff cap (§4.2); `pendingPayout` accounting; per-position cap |
| LP exit ahead of losses | conservative equity (§6.2); withdraw delay (§6.4); no request-time snapshot |
| Deposit-side dilution of incumbent LPs (§6.5) | disclosed + tested; mitigation (marked equity / epoch accounting / deposit delay) must be chosen before V1 (**LP-D14**) |
| Insolvency | invariant `balance ≥ pendingPayout` enforced by admission control; assert in tests |
| Share-price manipulation | equity independent of the price feed by construction (§6.2) |
| Stale price at open | `maxPriceAgeBlocks` + `PriceStale` |
| Forced settlement at a bad price | settlement requires a valid price; otherwise deferral → refund (§9.4) |
| Griefing by permissionless close | close pays the owner and releases capital; only cost is the close fee. Consider owner-only close in V1 (**LP-D7**) if griefing is judged worse than stuck positions |
| Reentrancy | `nonReentrant` on all state-changing entries; state updated before transfers |
| Token decimals mismatch | never mix native units with WAD price (§13.1); `quoteOpen`/`quoteSettle` are pure views that the UI must reuse, not reimplement |
| Front-running (public-mempool chains) | not applicable on Monad (local mempools); elsewhere mitigated per §11 — `maxPriceAgeBlocks`, short tenors, V1.1 `minPayoutOut` |
| Adapter/vault pair mismatch | factory asserts adapter pair == vault pair; `bindVault` one-shot (`AdapterPairMismatch`, `VaultAlreadyBound`) |
| Duplicate-pair vaults dilute the bond floor | `minQuoteNotional` sized against the largest vault on the pair; UI/factory duplicate-pair warning; structural fix = per-pair QuorumAdapter (§8.4, LP-D12) |
| Breaker baseline grooming | only `readAndUpdate()` (state-changing, validated) can advance `lastAcceptedPrice` or trip the breaker (§8.3, §8.8) |
| Param changes against existing LPs | timelocked `proposeParams → paramDelayBlocks → applyParams`; param owner can never touch funds (§7, §1.3) |
| Malicious vault creator | vaults are isolated (LP-01); LPs choose a vault and inherit only its risk. UI must surface `minQuoteNotional` and caps prominently |
| First-depositor share inflation | minimal seed burn at vault creation (**LP-D5**) |
| Keeper liveness | settlement and refund are permissionless; anyone can call |

---

## 13. Numerical conventions (easy to get wrong)

1. **Price is WAD 1e18, amounts are native.** `Monoracle.price = quoteAmount × 1e18 / baseAmount`
   in native units of each token. Never assume 18-decimal tokens.
2. **Units are base-native:** `U = N × 1e18 / S0`. The UI divides by `1e18` only for display
   of the price, never of amounts (existing convention: `web/src/lib/format.ts`).
3. **Payout via return, not via units:** `pnl = N × (S − S0)/S0` for LONG. Computing
   `pnl = U × (S − S0)/1e18` is algebraically identical but accumulates different rounding;
   pick one and test both agree within 1 unit.
4. **Rounding direction:** fee down (favours trader), payout down (favours pool).
5. **Overflow:** `N × 1e18` and `N × (S − S0)` can exceed `uint256` only for absurd values;
   Solidity 0.8 checked arithmetic reverts, and `maxDeposit` should be set well below that.

---

## 14. Testing strategy and invariants

Unit:
- Payoff matrix: flat, `2×`, `5×`, the `0` limit, and exactly at the cap boundary; both sides.
  The `0` row is the `S → 0⁺` limit (§4.2), not on-chain state — the MVP tests cover the closest
  reachable point (`S = 1 wei`) plus a zero-price-rejection test (`settlePrice == 0` →
  `PriceUnavailable`).
- Fee accrual at open; `balance − pendingPayout` moves as expected; the §6.5 equity dip
  (`2N − D`) and recovery (`fee − pnl`).
- Share math: first deposit, second deposit at a changed equity, full exit, partial exit,
  withdraw-delay enforcement, free-capital assertion, deposit-into-dipped-equity shows the
  §6.5 transfer (or its absence once mitigated).
- Admission: each of the six caps reverts with its own error at its exact boundary.
- Adapter: rejects `quoteAmount < minQuoteNotional`, rejects stale, rejects non-`SETTLED_VALID`,
  rejects banned provider; `readAndUpdate()` trips the breaker on a `> maxJumpBps` jump and the
  triggering call reverts; the tripped quote is rejected after cooldown (`TRIPPED_QUOTE`) even
  while it remains canonical; a *different* canonical quote is then accepted as the new
  baseline with the jump check bypassed once; `peek()` never mutates baseline/pause;
  `bindVault` is one-shot; the factory rejects an adapter whose pair differs from the vault's.
- Settlement: happy path; deferral when price invalid; refund after grace; refund is not
  callable before grace.

Integration:
- Full lifecycle: create vault → LP deposit → open long → price up → settle → payout;
  LP equity increased by the fee minus the loss.
- Attack test (must pass): attacker opens max-skew long (20% of equity, §8.4), submits a quote
  above the bond floor at `2×` price, a verifier vetoes it → attacker's quote is vetoed,
  canonical unchanged, position settles normally.
- Negative control (deliberately fails closed): same, but with `minQuoteNotional` misconfigured
  below the §8.4 floor → settlement price changes. This exists to prove the adapter is what stops
  the attack; keep it in a separate file (e.g. `test/vault-attack.negative.test.js`) whose
  failure is the documented expected outcome, and gate it out of CI (`--grep-invert` or a
  dedicated script), so a green suite still means "attacks are blocked".

Invariants (fuzz):
- `balance ≥ pendingPayout` at all times.
- `Σ position.maxPayout == pendingPayout`.
- `equity` never decreases from fees; never increases from an open; decreases by exactly
  `2N − D` at every open and nets to `fee − pnl` vs pre-open at settle (§6.5).
- No settlement token is ever transferred out except via payout, withdrawal, or fee routing.

---

## 15. Roadmap — MVP track, then V1

The MVP track (M0–M4) is the review/build target (§1.4); its detailed task breakdown,
acceptance criteria and test plan live in `docs/design/lp-pool-mvp-impl-plan.md`. The V1
track (P0–P6) is the full design.

### 15.1 MVP track (V1.0-mvp)

| Phase | Deliverable | Files | Status |
|---|---|---|---|
| **M0** | Vault skeleton: constructor, `deposit`/`withdraw`, conservative equity, share math | `contracts/IRMarketVault.sol` | done |
| **M1** | Product: capped linear LONG/SHORT, payoff §4.2, solvency invariant | `contracts/IRMarketVault.sol` | done |
| **M2** | Settlement at expiry off `IMonoracle.getLatestPrice` | `contracts/IRMarketVault.sol` | done |
| **M3** | Tests: deposit/shares, long cap, flat, short, pre-expiry, insolvency, no-price, withdraw | `test/IRMarketVault.test.js` | done (21 passing) |
| **M4** | Demo glue: deploy script + scripted price→open→settle walkthrough | `script/deploy-vault.js`, `script/vault-demo.js` | done |
| **M5** | Hardening + E2E: payoff boundaries, dilution, fuzz invariants, overflow; contract-level E2E suite | `test/IRMarketVault.test.js`, `test/IRMarketVault.e2e.test.js` | done (54 passing total, 9 E2E) |

### 15.2 V1 track (full design)

| Phase | Deliverable | Files (new) | Acceptance |
|---|---|---|---|
| **P0** | Pin the target Monoracle deployment + ABI (LP-D1 resolved from local artifacts; record the `eth_call` proof), record the upstream gates (`VERIFICATION_SLOTS`, `QuoteAmountTooSmall` floor value), decide §8.5.1 (1)/(2)/(3) | `contracts/IMonoracleExtended.sol`, `docs/chain-params.md` | on-chain `eth_call` proof + deployment/breaker decision recorded in this doc |
| **P1** | Price adapter + fake oracle | `contracts/PriceAdapter.sol`, `contracts/test/MonoracleStub.sol`, `test/adapter.test.js` | §8.3 rules all covered; breaker trips and resumes |
| **P2** | Vault: ERC20 shares, deposit / withdraw queue, conservative equity | `contracts/VaultShare.sol`, extend `IRMarketVault.sol`, `test/vault-lp.test.js` | share math + delay |
| **P3** | Positions: early close / refund, payoff math hardening | extend `IRMarketVault.sol`, `test/vault-positions.test.js` | payoff matrix + deferral/refund |
| **P4** | Risk params, admission control, factory, param timelock | `contracts/PoolFactory.sol`, `test/risk.test.js` | each cap reverts at its boundary; invariant fuzz green |
| **P5** | Operator: veto bot + settlement keeper; indexer + UI | `bot/vault_keeper.py`, `web/src/lib/vault/*` | one full market lifecycle end-to-end on testnet |
| **P6** | Chain parameterization + Avalanche evaluation (grant Milestone 3) | `docs/chain-params.md` | params derived per chain; §11 table filled with measured values |

Build order: M0–M4 (MVP) first; then P1 → P2 → P3 (the payoff math depends on the adapter,
the share math on neither). Budget the majority of review effort to P1 and P4 — they are
where the money is.

---

## 16. Open decisions (need a call before P4)

| ID | Question | Tentative answer |
|---|---|---|
| LP-D1 | Is `latestValidQuoteId` public on the deployment we will use? | **RESOLVED (local artifacts): yes** — `abi/Monoracle.abi.json`; P0 records the on-chain `eth_call` + pins the ABI |
| LP-D2 | `maxProfitBps` = 10 000 (1×) — right default? | yes; expose per market |
| LP-D3 | Early close in V1 or V1.1? | V1 (grant promises "open and close") |
| LP-D4 | Protocol fee cut | 0 in V1; add later |
| LP-D5 | Seed burn at vault creation | burn 1e6 shares-equivalent minimal deposit |
| LP-D6 | Parameter governance shape | per-vault timelocked update, owner = vault creator initially; LP-elected later |
| LP-D7 | Permissionless vs owner-only close | permissionless, revisit if griefed |
| LP-D8 | QuorumAdapter (§8.7) in V1 or V1.1? | V1.1 |
| LP-D9 | MTM equity (§6.2 V1.1) | V1.1 |
| LP-D10 | Does the vault need its own veto bot as a hard requirement or a runbook item? | runbook now; make it a funded requirement before mainnet |
| LP-D11 | Bond floor sized per-vault vs aggregate (§8.4) — is `~0.7 × equity` (case b) affordable, or do we lower `maxSkewBps`/`maxProfitBps`/`utilizationCapBps`? | always size against case (b); revisit with LPs |
| LP-D12 | Duplicate-pair vaults (§8.4) — factory warning, or hard pair-dedup? | warn + deprioritize in V1; QuorumAdapter is the structural fix |
| LP-D13 | Veto-bot reaction time (§8.5.1) — re-architect bot, long-window deployment, or accept weaker guarantee? | undecided; P0 must record the choice |
| LP-D14 | Deposit-side dilution (§6.5) — marked equity, epoch accounting, deposit delay, or accept? | must be decided before V1; MVP accepts + discloses |

---

## 17. Decision index

| ID | Decision |
|---|---|
| LP-01 | Isolated vault per market; no global pool |
| LP-02 | Payoff capped — pool liability bounded at open |
| LP-03 | `maxProfitBps = 10 000` default → `payout ∈ [0, 2N]` |
| LP-04 | Conservative equity (`balance − pendingPayout`), not mark-to-market |
| LP-05 | Two-step withdrawal, no request-time snapshot |
| LP-06 | Vault must not settle against its own quote — **except** an asset with no crypto-native on-chain token and no RWA-mapping token, where **only the LP** may provide the price (§8.6.1) |
| LP-07 | Early close supported, with `closeFeeBps` |
| LP-08 | Net skew is the binding risk control (unhedgeable exposure) |
| LP-09 | Utilization cap guarantees withdrawal availability |
| LP-10 | `minQuoteNotional ≥ 2 × M`, `M` = utilization+skew-bounded one-side attacker gain incl. counterflow (§8.4 case b) ≈ `0.7 × equity` at V1 defaults — never the per-position cap |
| LP-11 | Freshness bound on every price read |
| LP-12 | Circuit breaker with ownerless auto-resume; the tripped quote is never re-accepted; resume bypasses the jump check once for the first different quote (§8.8) |
| LP-13 | Operator veto bot is an operational requirement |
| LP-14 | No hedge exists; disclose, do not claim delta-neutrality |
| LP-15 | No valid price at settlement → deferral → refund of notional |
| LP-16 | Breaker state + price params live in the adapter; the vault reads, never mirrors (§8.3) |
| LP-17 | Only a state-changing validated read (`readAndUpdate`) may advance the breaker baseline (§8.3, §8.8) |
| LP-18 | Deposit-side dilution disclosed (§6.5); a mitigation (marked equity / epoch accounting / deposit delay) must be chosen before V1 (LP-D14) |
| LP-19 | Price provision: independent providers where a crypto-native/RWA-mapped token exists (LP/operator banned, LP-06); **only the LP** where the asset has no crypto-native token and no RWA mapping (§8.6.1) |
