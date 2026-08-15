# IRMarket — Smart Contract Technical Design (Monad | Veto-Market v0.9)

> **Status:** Written (V0.9 baseline). Implements PRD V0.8/V0.8.1 decisions D-01..D-16 and the
> ratified answers to Q1..Q8. Supersedes the V0.7 "liquidity pool + linear option" design —
> that model was overturned in V0.8: **trading = Monoracle veto arbitrage**, IRMarket is a
> thin factory + fee wrapper.
>
> **V0.9 change:** the veto window is now aligned with the option expiry (D-13). This required
> a fork of the upstream Monoracle contract (`contracts/MonoracleWindowed.sol`, derived from
> `github.com/dixia/monoracle`) because upstream hard-codes `VERIFICATION_SLOTS = 2`. The fork
> is the only contract-code exception to the "no vendored Monoracle code" rule (user-approved).
>
> Reference contracts: upstream `github.com/dixia/monoracle` (`contracts/Monoracle.sol`,
> `tech-spec.md`). IRMarket keeps the fork's ABI at `abi/Monoracle.abi.json`.

---

## 1. Overview

### 1.1 What the IRMarket contract is (and is not)

IRMarket does **NOT** price, match, settle, or hold pools. The whole trade lifecycle lives in
**MonoracleWindowed** (the IRMarket-deployed fork of Monoracle — users operate the *same*
contract that quotes and settles):

| Capability | Owner | Entry points |
|---|---|---|
| Quoting + bilateral collateral + quote ledger | 🔁 MonoracleWindowed | `submitQuote(..., expiryBlock)`, `quotes`, `QuoteSubmitted` |
| **Trade matching** (go long / go short) | 🔁 MonoracleWindowed | `vetoUnderpriced` / `vetoOverpriced` |
| **Settlement** (asset swap, immediate) | 🔁 MonoracleWindowed | done inside the veto tx — no second step |
| **Verification window = option expiry** | 🔁 MonoracleWindowed | per-quote `expiryBlock` (D-13) |
| Canonical price / read | 🔁 MonoracleWindowed | `settleValidQuote` / `getLatestPrice` |
| **Market factory (registry)** | IRMarket (thin) | `createMarket(base, quote, marketMaker, expiryBlock, feeBps)` — **no pair dedup** (D-14) |
| **Fee wrapper (1%, in HKD)** | IRMarket (thin) | `openLong` / `openShort` = veto + explicit fee (D-11/D-16) |
| Position index / valuation | IRMarket opt. + frontend | Monoracle events → local ledger; mark via ACTIVE quotes mid-round, `getLatestPrice` at expiry |

### 1.2 Roles

| Role | Who | What they may do |
|---|---|---|
| Market creator | Anyone (permissionless, `开市权` D-07) | `createMarket` for any token pair; multiple markets per pair allowed (D-14) |
| Market maker / provider (bot) | Bot EOA | `submitQuote(..., expiryBlock)` per market round (bilateral collateral) → `settleValidQuote` after expiry → `withdrawProviderFunds`; absorbs P&L as the mirror of users (zero-sum, D-10) |
| Trader (any wallet) | Anyone | Directly `vetoUnderpriced`/`vetoOverpriced` on any ACTIVE quote (any provider, D-15), or via the wrapper (fee'd) |
| MonoracleWindowed (self-deployed) | IRMarket-owned fork | The trading venue & price source; derived from upstream Monoracle |

### 1.3 Product semantics encoded (V0.8)

| PRD | Mapping |
|---|---|
| **看涨开仓 = long LLM** (D-08) | `vetoUnderpriced(quoteId)`: trader pays `quoteAmount` HKD → receives `baseAmount` LLM → holds LLM |
| **看跌开仓 = short LLM** (D-08) | `vetoOverpriced(quoteId)`: trader pays `baseAmount` LLM → receives `quoteAmount` HKD → holds HKD |
| **反向平仓** (D-08) | Reverse veto: long holder (LLM) does `vetoOverpriced` on a later quote to get HKD back; short holder does `vetoUnderpriced` |
| **窗口 = 期权到期** (D-13) | Every quote carries `expiryBlock` (= its market's expiry). Vetoable until then; settleable after. No more 600ms race (B8 closed) |
| **到期** (D-06/D-09) | Bot's final quote settles **last** at expiry → `getLatestPrice` = mark/终价. No on-chain settle/claim — assets already in wallet; UI only valuates |
| **对手方 / 风险** (D-10) | Bot's bilateral collateral fully backs every veto; user profit = bot mirror loss `|T−P|×size`; zero-sum, no pool, no insolvency |
| **手续费** (D-11/D-16) | 1% on nominal **in HKD** (`feeBps × quoteAmount / 10000`) — deducted by the wrapper (long: added to pay-in; short: deducted from pay-out). Fee can't live inside the quote — it would be arbitraged away (R14) |

---

## 2. Architecture

```
┌─────────────┐   openLong/openShort (1% fee)    ┌──────────────────┐
│  frontend   │ ──────▶  IRMarket.sol  ────────▶ │ MonoracleWindowed│ vetoUnderpriced /
│  (Next.js)  │ ◀────── (wrapper: fee in HKD)     │  (IRMarket fork) │ vetoOverpriced
└─────────────┘         ┌──────────────────┐     └──────────────────┘
       │ direct veto (no fee)              ▲             ▲
       └────────────────────────────────────┘        submitQuote(..., expiryBlock) /
      (reverse close / power users)               settleValidQuote / withdrawProviderFunds
                                                        ▲
                                                        │
                                                   ┌────┴─────┐
                                                   │ bot (Python) │  ← provider, real 06658.HK quote
                                                   └──────────┘
```

Data flow per trade:

1. Bot quotes (base=LLM, quote=HKD) at fair price `P` with `expiryBlock` = the market round's
   expiry; the quote stays vetoable for the whole round (D-13).
2. User picks an ACTIVE `quoteId` and a direction.
3. **With fee:** wrapper pulls `swapIn + fee` (long, both in HKD) or `baseAmount` LLM (short),
   forwards the swap into the veto, sends `fee` (HKD) to the market maker, forwards the
   swapped-out tokens to the user (short: `quoteAmount − fee` HKD).
   **Without fee (close / direct):** user calls `MonoracleWindowed` directly.
4. MonoracleWindowed atomically swaps in-window: asset lands in user's wallet. No further action.

---

## 3. `IRMarket.sol` — Design

### 3.1 Types & constants

```solidity
enum Side { LONG, SHORT }   // LONG  = vetoUnderpriced (pay quote, get base)
                            // SHORT = vetoOverpriced  (pay base,  get quote)

struct Market {
    address baseToken;      // e.g. LLM
    address quoteToken;     // e.g. HKD
    address marketMaker;    // fee recipient (bot)
    uint256 feeBps;         // 1% = 100
    uint256 expiryBlock;    // advisory (Demo 3 min ≈ 600 blocks) — bot sets quote.expiryBlock
                            // = this value; UI countdown source
    uint256 createdAtBlock;
}
```

- `MAX_FEE_BPS = 10000`; `feeBps` validated `< MAX_FEE_BPS` (rejects ≥100%).
- **No `enabled` kill-switch** — the contract is ownerless/adminless (consistent with §10).
- `oracle` is a constructor constant (single MonoracleWindowed instance).
- **No pair dedup** (D-14): the same underlying may list several option markets with
  different expiries/fees; each round = a new `marketId`.

### 3.2 State variables

```solidity
uint256 public nextMarketId;                       // starts at 1
mapping(uint256 => Market) public markets;         // marketId → market
```

No `marketIdByPair`, no `MarketExists`. `createMarket` always mints a new id. Frontend lists
markets per pair and filters by expiry/activeness.

### 3.3 `createMarket` — factory registry (D-07/D-14)

```solidity
function createMarket(
    address baseToken,
    address quoteToken,
    address marketMaker,
    uint256 expiryBlock,
    uint256 feeBps
) external returns (uint256 marketId)
```

- **Access:** anyone (开市权, D-07). **Requirements:** tokens non-zero & distinct;
  `feeBps < 10000`; `expiryBlock > block.number`.
- **Effects:** create `Market`; `nextMarketId++`; **grant the oracle allowance** so the
  wrapper can veto with this pair's tokens:
  `IERC20(baseToken).forceApprove(oracle, type(uint256).max)` and same for `quoteToken`
  (`forceApprove` rather than `approve` — safe for tokens that require zero-then-approve).
- **Emission:** `MarketCreated(marketId, baseToken, quoteToken, marketMaker, expiryBlock, feeBps)`.
- No tokens move in this call. `expiryBlock` is **advisory for the contract** (the wrapper has
  no settlement logic); it drives the bot's per-quote `expiryBlock` (D-13/D-06) and the UI
  countdown (D-01).

### 3.4 Fee wrapper — the two trade entries (D-11/D-16)

The veto swap is **whole-quote** (Monoracle exchanges the full `quoteAmount` ⇄ `baseAmount`;
no partial fills). The fee is charged **in HKD (quote token) on both directions**:

```
fee (HKD) = quote.quoteAmount × feeBps / 10000          (floor)

LONG:  user pays quoteAmount + fee  (HKD)  → receives baseAmount (LLM)
SHORT: user pays baseAmount (LLM)        → receives quoteAmount − fee (HKD)
```

#### `openLong`

```solidity
function openLong(uint256 marketId, uint256 quoteId) external nonReentrant
```

Maps to `vetoUnderpriced` (pay HKD, get LLM → 看涨).

1. Read market; quote via oracle `quotes[quoteId]`; assert `status == ACTIVE` and
   `block.number <= quote.expiryBlock` (friendly pre-checks; Monoracle's own modifiers are
   the backstop — passes through its errors).
2. `swapIn = quote.quoteAmount`; `fee = swapIn × feeBps / 10000` (HKD).
3. `IERC20(quoteToken).safeTransferFrom(msg.sender, address(this), swapIn + fee)` (gross, HKD).
4. If `fee > 0`: `IERC20(quoteToken).safeTransfer(marketMaker, fee)`.
5. `IMonoracleWindowed(oracle).vetoUnderpriced(quoteId)`
   — the oracle pulls `swapIn` (its quoteAmount) from this wrapper, sends `baseAmount` LLM to it.
6. `IERC20(baseToken).safeTransfer(msg.sender, baseAmount)` — LLM lands in user's wallet.
7. Emit `VetoWrapped(quoteId, marketId, msg.sender, LONG, quoteAmount, baseAmount, fee)`.

**Net user P&L basis:** paid `swapIn + fee` HKD, holds `baseAmount` LLM. Position value
marks to the ACTIVE quote price mid-round and `getLatestPrice` at expiry (LLM value − cost =
PNL, all frontend-side, D-09).

#### `openShort`

```solidity
function openShort(uint256 marketId, uint256 quoteId) external nonReentrant
```

Maps to `vetoOverpriced` (pay LLM, get HKD → 看跌):

- `fee` (HKD) = `quote.quoteAmount × feeBps / 10000`.
- Pull `baseAmount` LLM from user → `vetoOverpriced(quoteId)` → oracle sends `quoteAmount`
  HKD to the wrapper → wrapper forwards `quoteAmount − fee` HKD to the user and `fee` to the
  market maker.

#### Reverse close (平仓, D-08)

- **No extra contract code:** closing = the reverse veto, executed **directly on
  MonoracleWindowed** by the user. No fee on closes (the wrapper is open-only; a fee-on-close
  wrapper variant is out of demo scope — A5).
- Long holder (holds LLM) → `vetoOverpriced` on a fresh quote → gets HKD.
- Short holder (holds HKD) → `vetoUnderpriced` on a fresh quote → gets LLM.

#### Provider restriction (D-15)

The wrapper does **NOT** require `quote.provider == market.marketMaker`: users may trade
against any ACTIVE quote of the pair; the 1% fee always goes to the registered market maker.

### 3.5 Optional: position index & fee treasury

- **Position index:** NOT stored on-chain by default (D-09, R11 — assets live in user
  wallets). The frontend/bot indexes positions from `QuoteVetoedUnderpriced`/
  `QuoteVetoedOverpriced` (+ the wrapper's `VetoWrapped` for `trader` attribution). A
  contract-side index, if ever wanted, is a separate additive contract — not required for demo.
- **Fee treasury:** default is **forward-per-trade** (fee goes straight to `marketMaker` in
  the same tx — no stuck funds, no claim step).

### 3.6 Events

All key args `indexed` (Monad Streaming RPC):

```
MarketCreated(marketId, baseToken, quoteToken, marketMaker, expiryBlock, feeBps)
VetoWrapped(quoteId, marketId, trader, side, swapIn, swapOut, fee)   // quoteId/marketId/trader indexed
```
> Solidity caps non-anonymous events at **3 indexed args**; the wrapper indexes `quoteId`,
> `marketId`, `trader` (wallet-scoped + quote-join + market feeds) and keeps `side`/amounts/
> `fee` in `data`. The frontend ABI (`web/src/lib/abis/market.ts`) matches — `side` is
> `indexed: false`.
>
> MonoracleWindowed's own events (`QuoteSubmitted` — now with `expiryBlock`,
> `QuoteVetoedUnderpriced`, `QuoteVetoedOverpriced`, `QuoteSettledValid`, `FundsWithdrawn`)
> are the trading ledger — IRMarket mirrors `trader`/`fee` attribution for the UI.

### 3.7 Errors (custom, gas-efficient on Monad)

`MarketDoesNotExist`, `InvalidToken`, `IdenticalTokens`, `FeeTooHigh`, `ExpiryMustBeFuture`,
`QuotePairMismatch` (pre-check), `QuoteNotActive` (pre-check), `QuoteWindowExpired`
(pre-check), plus passthrough of oracle errors (`ExpiryMustBeFuture`,
`VerificationWindowExpired`, `QuoteDoesNotExist`, `QuoteNotActive`,
`ReentrancyGuardReentrantCall`, `SafeERC20FailedOperation`).

### 3.8 Interface to MonoracleWindowed (local `IMonoracleWindowed`)

Hand-written from the fork build (`abi/Monoracle.abi.json`), exposing only what IRMarket touches:

- `quotes(uint256) → (provider, baseToken, quoteToken, baseAmount, quoteAmount, price, startSlot, settledSlot, expiryBlock, status)` (audit + window checks)
- `vetoUnderpriced(uint256)`, `vetoOverpriced(uint256)`
- `getLatestPrice(address base, address quote) → (uint256 price, uint32 settledSlot, bool exists)`
- Events for the indexer.
- Note: the fork has **no** `VERIFICATION_SLOTS` constant (window is per-quote); the UI reads
  `quote.expiryBlock` for the window countdown (A4).

---

## 4. Fee accounting (D-11/D-16) — precise rules

| Field | Rule |
|---|---|
| Fee currency | **Always HKD (quote token)**, both directions |
| Fee base | `quote.quoteAmount` (the HKD leg of the vetoed quote) |
| `fee` | `quoteAmount × feeBps / 10000`, floor |
| LONG collection | gross pull `quoteAmount + fee` (HKD), single `safeTransferFrom` |
| SHORT collection | pull `baseAmount` LLM; forward `quoteAmount − fee` HKD to trader, `fee` to MM |
| Recipient | `market.marketMaker` immediately, same tx |
| Rounding | fee rounds down in the user's favor |
| Why not in-spread | any systematic markup is veto-arbitraged away on Monoracle (R14) — fee can only exist at the wrapper layer |

Boundary note (B4-derived): a veto consumes the **whole** quote (`quoteAmount` ⇄ `baseAmount`).
The UI "input amount" therefore reflects/walks the active quote's size rather than an
arbitrary partial fill; arbitrary sizes would require fractional-veto support (out of scope).

---

## 5. Lifecycle sequences

### 5.1 Bot continuous quoting (D-05/D-13, provider-owned)

1. Fetch real 06658.HK price → `submitQuote(LLM, HKD, baseAmount, quoteAmount, expiryBlock)`
   with `expiryBlock` = the market round's expiry (bilateral collateral).
2. Each quote stays vetoable until its `expiryBlock`; after a quote is vetoed, the bot
   withdraws (`2×` other side) and **re-quotes immediately** (restocking) so a tradeable
   quote is always available.
3. Un-vetoed quotes settle after expiry: `settleValidQuote` — **in order, oldest first,
   the round's final quote LAST**, so the canonical price = 终价 (D-06, B12).
4. `withdrawProviderFunds` to recycle collateral (B7/B12) → next round, configurable
   interval (`QUOTE_INTERVAL_SECONDS/BLOCKS`).
5. **Capital note (B12):** un-vetoed quotes lock collateral until expiry; bot budget =
   quotes-outstanding × size (demo mints plenty of test tokens).

### 5.2 Open (long example, via wrapper)

User approves wrapper for HKD (long) or LLM (short) → `openLong(marketId, quoteId)`:
`pull quoteAmount + fee` → `fee → MM` → `vetoUnderpriced` (LLM → user) → emit. User now
holds LLM. Done.

### 5.3 Reverse close (D-08)

User (holding LLM) approves MonoracleWindowed directly → `vetoOverpriced(newQuoteId)` →
receives HKD, closes exposure. No wrapper, no fee (A5).

### 5.4 Expiry (D-06/D-09) — valuation only

Bot's final quote settles last → `getLatestPrice` = 终价. UI shows per-position
`持仓市值 @ 终价 − 开仓成本 = 盈亏` against wallet balances (LLM for longs, HKD for shorts).
**No claim, no settle tx** (Q4: "No need"). Mid-round valuation uses the latest ACTIVE
quote's price (indexed from `QuoteSubmitted` events), since `getLatestPrice` only updates
when a quote settles (B12).

---

## 6. Security analysis

| Vector | Mitigation |
|---|---|
| Reentrancy | `nonReentrant` on both wrapper entries; oracle veto is also `nonReentrant`; wrapper holds no inter-tx funds |
| Quote window | ACTIVE-check + `block.number <= expiryBlock` pre-checked for friendly errors; oracle modifiers are the backstop (pass-through reverts) |
| Fee correctness | fee computed from the on-chain `quote` amounts (canonical), single gross pull means no double-spend of allowance |
| Stuck funds | every token either forwards out or pays MM in the same tx; no balances retained; approve-max only to the oracle |
| Stale/missing quote | frontend reads ACTIVE quote events → none ⇒ disable trade panel ("waiting for bot", B4 degrade state); `getLatestPrice` `exists=false` guard |
| Front-running | Monad has no public mempool (local mempools, 3 leaders); quoteId-anchored fills = see-what-you-sign price, zero slippage (B4); long windows (D-13) remove the timing race |
| Fee bypass | direct `MonoracleWindowed` vetoes are fee-free by design (power users / closes) — accepted demo limitation |
| Malicious creator / bad pairs | market registration is permissionless by design (D-07); caller risks only their own allowance; MM chosen by creator |
| Token safety | `SafeERC20`; only registered pair tokens ever touched; approve-max scalar per token |

---

## 7. Monad-specific considerations

- **Window:** per-quote `expiryBlock` (D-13) — no more 2-slot (~600ms) trade race (B8
  closed); the UI shows a market-level countdown instead of a per-quote one, plus a "no
  tradeable quote" fallback when the bot is off (B4).
- **Gas model:** Monad bills **gas limit**, not gas used. Set fixed limits: wrapper
  `openLong/openShort` ≈ 450k (wrapper transfers + oracle veto ≈ 250–300k); fork refs
  (upstream-consistent +1 storage write): `submitQuote` 600k, veto 300k, `settleValidQuote`
  150k, `withdrawProviderFunds` 200k.
- **Parallel execution:** per-quote storage (`quotes[]`) touches disjoint slots across ids;
  the wrapper adds no global contention.
- **Streaming RPC:** `VetoWrapped` + the fork's 5 events drive the indexer/UI; keep params
  indexed.
- **Reserve balance:** deployer + bot EOAs keep ≥ 10 MON reserve (network rule).

---

## 8. Integration guide

### 8.1 Frontend (`web/`)

- Markets: `MarketCreated` events / `markets()`; multiple markets per pair listed by expiry
  (D-14); price card from `getLatestPrice` (expiry) or latest ACTIVE quote (mid-round, B12).
- Trade: select ACTIVE `quoteId` (`quotes()` status + `expiryBlock`), sign
  `openLong`/`openShort` in the wrapper (fee shown explicitly in HKD; PRD §5.3 preview line)
  or direct oracle veto for closes.
- Positions: index `QuoteVetoedUnderpriced/Overpriced` + `VetoWrapped` per wallet; value =
  token balance × price; PNL = value − cost (all client-side, D-09).
- Expiry: show 终价 mark + PNL; **no claim button** (R11).

### 8.2 Bot (`bot/`, Python)

- Continuous `submitQuote(..., expiryBlock)` per active market round → vetoed ⇒ withdraw +
  re-quote; after expiry settle oldest-first, final quote last → `withdrawProviderFunds`
  (FR-BOT-001/002); veto watch for P&L logging (FR-BOT-004).
- Receives the 1% wrapper fee (HKD) at `marketMaker` set per market.
- Adapted from upstream `bot/verifier.py` (veto side) + `script/demo.js` (quoting side).

### 8.3 Market maker / creator

1. Deploy `MonoracleWindowed` + `IRMarket(oracle)` (`script/deploy.js`).
2. Mint `LLM`/`HKD` (`MockERC20`, `script/deploy-tokens.js`), fund faucet + bot.
3. Approve MonoracleWindowed (bot), `createMarket(LLM, HKD, botAddr, expiryBlock, feeBps=100)`.
4. Start quoting with `expiryBlock` = market expiry; keep the round alive for the 3-min demo.

---

## 9. Testing strategy

- **Registry:** `createMarket` happy path; **two markets for the same pair both succeed
  (no dedup, D-14)**; fee validation; expiry-in-future validation; oracle allowance granted.
- **Wrapper long/short:** long gross pull = `quoteAmount + fee` (HKD); short forwards
  `quoteAmount − fee` (HKD); fee lands at MM; swapOut forwarded to trader; fee=0 pass-through;
  reentrancy attempts revert.
- **Oracle passthrough:** ACTIVE/window pre-checks revert; expired quote reverts
  (`VerificationWindowExpired`); already-vetoed quote reverts; insufficient allowance
  reverts.
- **Windowed fork (see `test/MonoracleWindowed.test.js`, 6 cases):** price derivation +
  `ExpiryMustBeFuture`; veto any time inside the window; veto after expiry reverts; settle
  before expiry reverts; settle-after feeds `getLatestPrice`; last-settled quote wins
  canonical (final quote = mark, B12).
- **Zero-sum invariant test (D-10):** long user profit ≈ bot's `FundsWithdrawn` difference
  for a vetoed quote (`2×other-side` returns) — i.e., no value leaks.
- Run `npx hardhat test`.

---

## 10. Deployment

- Deploy `MonoracleWindowed` (own instance — the trading venue; upstream's live testnet
  deployment `0x1ABABc60...` is **not** used, its window is fixed 2 slots) then
  `IRMarket(oracle)` — `script/deploy.js`; write `deployment.json`; wire `.env`,
  `bot/.env`, `web/.env.local`.
- Deploy/mint `LLM` (`BASE_TOKEN`) + `HKD` (`QUOTE_TOKEN`) via `MockERC20`
  (`script/deploy-tokens.js`).
- `createMarket` for the demo pair; start bot quoting; run demo.
- Verify on Sourcify/BlockVision (Monad explorer). No upgrade/owner/admin on either contract.

---

## 11. Open items & PRD traceability

| PRD | Status | Design impact |
|---|---|---|
| D-07 | ✅ | registry + pair-as-market, permissionless (§3.3) |
| D-08 | ✅ | LONG=vetoUnderpriced / SHORT=vetoOverpriced; close=reverse veto (§3.4/§5.3) |
| D-09 / Q4 | ✅ | no on-chain settle/claim; assets in wallet; expiry = UI mark (§5.4) |
| D-10 / Q1 / Q2 | ✅ | zero-sum, bot-collateral-backed; no pool, no insolvency (§1.3/§6) |
| D-11 / Q3 / Q7 | ✅ | wrapper explicit 1%, gross-pull model (§4) |
| D-12 / Q5 | ✅ | 溜溜梅 (06658.HK / HKG:6658) narrative locked; real feed, data source pinned at dev time |
| D-13 / B8 | ✅ | per-quote `expiryBlock` fork (`contracts/MonoracleWindowed.sol`); no 600ms race |
| D-14 / B9 | ✅ | no pair dedup; multi-market per underlying (§3.2/§3.3) |
| D-15 / B10 | ✅ | wrapper accepts any provider's quotes (§3.4) |
| D-16 / B11 | ✅ | fee always in HKD = `feeBps × quoteAmount / 10000` (§4) |
| B4 (quote availability) | ⚠️ | "no tradeable quote" degrade state; whole-quote fill granularity (no partial veto) — flag for demo UX |
| B5 (real HP feed) | ⚠️ | bot data source for 06658.HK to be pinned at dev time (溜溜梅 narrative per D-12) |
| B12 (capital & marks) | ⚠️ | un-vetoed quotes lock collateral till expiry (bot budget); mid-round marks from ACTIVE quote events; settle order oldest-first, final quote last (§5) |

---

## 12. Reference: MonoracleWindowed fork (local, derived from upstream)

- **Source:** `contracts/MonoracleWindowed.sol` — fork of upstream
  `github.com/dixia/monoracle` (`contracts/Monoracle.sol`, MIT). **Single behavioral
  change:** per-quote `expiryBlock` window replaces the fixed `VERIFICATION_SLOTS = 2`.
  The fork is IRMarket's own deployed trading venue; upstream is untouched.
- **ABI:** `abi/Monoracle.abi.json` (regenerated from the fork build — `submitQuote` now
  takes `expiryBlock`, `QuoteSubmitted` carries it, no `VERIFICATION_SLOTS`).
- **Upstream live testnet (10143):** `0x1ABABc60Ca6950C94eA80F2f611AB06aAAAD28c0` —
  informational only; IRMarket deploys its own instance.
- Semantics preserved from upstream:
  - `submitQuote(base, quote, baseAmount, quoteAmount, expiryBlock)` →
    `price = quoteAmount·1e18/baseAmount`; bilateral collateral locked inside the oracle
    (IRMarket can never touch it).
  - `vetoUnderpriced(quoteId)`: verifier pays `quoteAmount` quote, receives `baseAmount`
    base — **this is the LONG trade**. Status → `VETOED_UNDERPRICED`.
  - `vetoOverpriced(quoteId)`: verifier pays `baseAmount` base, receives `quoteAmount`
    quote — **this is the SHORT trade**. Status → `VETOED_OVERPRICED`.
  - `settleValidQuote(quoteId)`: permissionless, after `expiryBlock` ⇒ canonical
    (`latestValidQuoteId[pair]`); `getLatestPrice` reads it.
  - `withdrawProviderFunds(quoteId)`: provider-only; valid ⇒ 1× back, underpriced veto ⇒
    2×quote, overpriced veto ⇒ 2×base (zero-sum with the vetoing trader).
  - Public `quotes(quoteId)` getter returns zero struct for unknown ids (callers treat
    `provider == address(0)` as "no quote").
- **D-06 feasibility:** a fresh `submitQuote` + `settleValidQuote` at expiry replaces the
  canonical price → `getLatestPrice` = 终价 for valuation. Deterministic when the bot
  settles oldest-first and its final quote last (B12). Multi-provider mark-pinning is out
  of scope.
