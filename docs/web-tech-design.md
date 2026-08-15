# IRMarket — Web Tech Design (Veto-Market)

> **Status:** Review ready. Mirrors `docs/prd.md` (V0.8) and **`docs/sc-tech-spec.md` (V0.9)**
> for the on-chain interface. The frontend is a **veto client**: users trade by vetoing ACTIVE
> quotes on **MonoracleWindowed** (the IRMarket-deployed fork of Monoracle) — bull via the fee
> wrapper `openLong`, bear via `openShort`; closes are direct reverse vetoes (D-08/D-11/D-16).
> No pool, no settlement, no claim (D-09). All decisions referenced are confirmed
> (D-01 … D-16, Q1 … Q8); flagged items are in §11.

---

## 1. Overview

### 1.1 Purpose & Scope

Technical design for the IRMarket web dapp (`web/`): architecture, data layer,
page/component specification, design system, Monad-specific behavior, flow walkthroughs, and
test strategy for the **confirmed** UI requirements in `docs/prd.md` V0.8 (§5.1–§5.4) and the
contract interface in `docs/sc-tech-spec.md` V0.9.

### 1.2 What the frontend is (V0.8/V0.9 architecture)

| User intent | On-chain action | Asset flow | Result |
|---|---|---|---|
| 看涨 open (long) | IRMarket `openLong(marketId, quoteId)` → via `vetoUnderpriced` | pay `quoteAmount + fee` HKD → receive `baseAmount` LLM | holds LLM |
| 看跌 open (short) | IRMarket `openShort(marketId, quoteId)` → `vetoOverpriced` | pay `baseAmount` LLM → receive `quoteAmount − fee` HKD | holds HKD |
| 平仓 close (D-08) | **direct** `vetoUnderpriced`/`vetoOverpriced` on MonoracleWindowed (no wrapper, no fee) | swaps back | flat |

Contract facts that constrain the UI:

- **Whole-quote fills (B4/veto semantics):** Monoracle's veto exchanges the quote's **full**
  `quoteAmount ⇄ baseAmount` — there are no partial fills. The trade size is the ACTIVE
  quote's size, not an arbitrary input (fractional-veto out of scope). The UI *walks* the
  quote and reflects how much that is (§5.3).
- **Window = option expiry (D-13):** every quote carries its market round's `expiryBlock`;
  it stays vetoable until then. There is **no ~600ms per-quote race** — the countdown is a
  market-level one (§4.2). Veto after `expiryBlock` reverts.
- **Fee is HKD-only (D-16):** `fee = quote.quoteAmount × feeBps / 10000`, floor. LONG pays
  `quoteAmount + fee` (gross pull); SHORT receives `quoteAmount − fee`. Fee goes straight to
  the market maker in the same tx. Closes bypass the wrapper entirely (no fee, power-user
  direct veto — accepted demo limitation).
- **No settlement, no claim (D-09):** the swap lands assets in the wallet; PNL is a UI-side
  valuation (`持仓市值 − 成本`). At expiry the UI shows 终价 mark only.
- **Positions are event-derived:** indexed from `VetoWrapped` (wrapper opens, attributes
  `trader`) + `QuoteVetoedUnderpriced/Overpriced` (direct closes verifier = user). No on-chain
  ledger (R15).

### 1.3 Source of truth

- Product + UI flow: `docs/prd.md` (V0.8)
- On-chain vocab & fee/window semantics: `docs/sc-tech-spec.md` (V0.9)
- ABI: `abi/Monoracle.abi.json` (regenerated from the **fork**, `MonoracleWindowed`) +
  IRMarket wrapper ABI from `artifacts/`
- Gas/realtime/finality: upstream `tech-spec.md` §5/§10 (adapted for the fork §7)

---

## 2. Tech Stack & Rationale

| Concern | Choice | Note |
|---|---|---|
| Framework | **Next.js 16** (App Router) | existing scaffold; client components |
| Output | **static export** (`output: "export"`) | no server runtime → all data fetching client-side; env must be `NEXT_PUBLIC_*` |
| UI | React 19 + TypeScript + **Tailwind v4** | `@theme` design tokens (§6) |
| Blockchain access | **wagmi v3 + viem v2** | account, chain, reads/writes, events, `watchBlockNumber` |
| Server state | **@tanstack/react-query** | polling + cache invalidation |
| Wallet | injected (Rabby / MetaMask) | existing `src/lib/wagmi.ts`; Monad testnet 10143 |
| Tests | Playwright (msedge) | `web/tests/`, §10 |

Unchanged Ethereum tooling, with Monad-specific behaviors encoded: gas is charged by limit
(§7.1), finality ~600ms (§7.3), realtime is WS-first with HTTP fallback (§7.4).

---

## 3. Architecture

### 3.1 Route tree

```
/                           market list (one card per marketId; multiple per pair per D-14)
/markets/[marketId]         market detail + trading panel (core trade page)
/positions                  positions (derived from veto + VetoWrapped events)
```

Markets are per-`marketId` (each `createMarket` mints a new id, **no pair dedup**, D-14); a
pair may appear as several cards sorted by expiry. `layout.tsx` hosts the nav shell (logo,
network badge, wallet, HKD/LLM balances, faucet entry — §5.1). `providers.tsx` is the
`WagmiProvider` + `QueryClientProvider` shell plus event wiring.

### 3.2 Module map

```
src/
├─ app/
│  ├─ layout.tsx             # nav shell (client)
│  ├─ page.tsx               # market list
│  ├─ markets/[marketId]/page.tsx  # detail + trading panel
│  └─ positions/page.tsx     # event-derived positions
├─ components/
│  ├─ wallet/                # WalletButton, NetworkBadge, FaucetModal
│  ├─ market/                # MarketCard, QuoteCard, CountdownTimer
│  ├─ trade/                 # SideTabs, TradePreview, OrderButton
│  ├─ position/              # PositionCard, EmptyState
│  └─ common/                # TxStatusCard (loading/success/fail), AddressPill
├─ hooks/
│  ├─ useMarkets.ts          # react-query: markets() / MarketCreated events
│  ├─ useActiveQuotes.ts     # ACTIVE quotes of a market + countdown
│  ├─ useReferencePrice.ts   # getLatestPrice poll (expiry mark) + ACTIVE-quote mid-round mark
│  ├─ usePositions.ts        # veto/VetoWrapped event stream → positions
│  └─ useTrade.ts            # approve → openLong/openShort/close (order flow)
├─ lib/
│  ├─ wagmi.ts               # existing chain/config
│  ├─ market.ts              # addresses, ABIs (MonoracleWindowed + IRMarket), explorer, env
│  └─ format.ts              # 1e18 fixed-point → display, fee math helpers
```

### 3.3 ABI & addresses

- **MonoracleWindowed** (trading venue): `abi/Monoracle.abi.json` — the **fork** ABI.
  UI-needed members: `quotes(uint256)`, `vetoUnderpriced`, `vetoOverpriced`,
  `getLatestPrice`, events `QuoteSubmitted` (now carries `expiryBlock`),
  `QuoteVetoedUnderpriced`, `QuoteVetoedOverpriced`, `QuoteSettledValid`. Public getter shape
  (fork, V0.9 §3.8/§12):
  `quotes(quoteId) → (provider, baseToken, quoteToken, baseAmount, quoteAmount, price, startSlot, settledSlot, expiryBlock, status)`.
- **IRMarket wrapper**: `openLong(marketId, quoteId)`, `openShort(marketId, quoteId)`,
  `markets(uint256)` → `Market`, `nextMarketId`, event `MarketCreated` / `VetoWrapped`
  (sc-tech-spec §3). These are **specified** — see §11.1 for the summed interface.
- **Tokens**: `LLM` (base) + `HKD` (quote) MockERC20.

### 3.4 Environment (`web/.env.local`)

```
NEXT_PUBLIC_RPC_URL=https://testnet-rpc.monad.xyz
NEXT_PUBLIC_CHAIN_ID=10143
NEXT_PUBLIC_ORACLE_ADDRESS=0x...            # MonoracleWindowed (IRMarket-deployed fork — NOT
                                            # upstream 0x1ABABc60... whose window is fixed 2 slots)
NEXT_PUBLIC_MARKET_ADDRESS=0x...            # IRMarket wrapper (openLong/openShort)
NEXT_PUBLIC_BASE_TOKEN=0x...                # LLM
NEXT_PUBLIC_QUOTE_TOKEN=0x...               # HKD
```

Reads resolve through these; app renders a "configuration missing" guard if env is
incomplete (current `src/lib/market.ts` already requires env on import), and a "not yet
deployed" notice when the wrapper address is empty.

---

## 4. Data Layer

### 4.1 Markets (factory registry, D-07/D-14)

- React-query key `['markets']`: read `nextMarketId`, map over `markets(id)`; also listen to
  `MarketCreated` events (WS) to append live. Each market = `Market{baseToken, quoteToken,
  marketMaker, feeBps, expiryBlock, createdAtBlock}`.
- Demo = one pair (LLM/HKD), one or a few markets by expiry; list groups cards per pair and
  sorts by `expiryBlock` (D-14 no dedup, UI shows multiple).

### 4.2 Tradeable quotes & countdown

- For a market, track ACTIVE quotes of the pair: subscribe to `QuoteSubmitted` (WS) and/or
  poll `quotes(lastKnownId…nextQuoteId)`; keep only `status == ACTIVE` with
  `block.number <= expiryBlock` (vetoable). Bot restocks immediately after a veto (sc-tech-spec
  §5.1), so normally ≥1 tradeable quote is present.
- **Countdown is market-level** (D-13, B8 closed): the round's `expiryBlock` → time left to
  expiry is a simple block→time conversion off `watchBlockNumber`. No per-quote ~600ms race.
- Degraded states:
  - **无可用报价 (no tradeable quote):** no ACTIVE quote in window (bot off / collateral
    rolling, B4) → trade panel disabled with that message.
  - **市场已到期 / no placement:** after `expiryBlock`, no new vetoes for the round.

### 4.3 Reference price & mid-round marks (B12)

- Query `['price', pair, blockTag]`:
  - **At/after expiry:** `getLatestPrice` = 终价 (canonical; the bot settles oldest-first,
    final quote last — D-06/B12).
  - **Mid-round:** `getLatestPrice` may lag (only updates on settle, B12) → the "current
    price" on market cards/positions marks to the **latest ACTIVE quote's price** from the
    quote stream. `exists=false` (never settled yet) → degraded `等待 bot 建立报价`, trade
    disabled.
- Poll `getLatestPrice` ~2s as the settlement-bound baseline; prefer WS ACTIVE-quote price
  for live display.

### 4.4 Positions (event-derived, no indexer)

- Sources per wallet (sc-tech-spec §3.5/§8.1):
  - `VetoWrapped(quoteId, marketId, trader, side, …)` where `trader == account` — the
    **wrapper opens** (this is how a user's opened position is attributed; the raw
    `QuoteVetoed*` verifier on a wrapped veto is the wrapper contract).
  - `QuoteVetoedUnderpriced` / `QuoteVetoedOverpriced` where `verifier == account` — **direct
    closes / power-user vetoes**.
- Fetch via `eth_getLogs` (windowed from the account's first block), then read
  `quotes(quoteId)` to reproduce exact amounts/price/direction + the market via event.

Position record:

| Field | Bull (openLong → vetoUnderpriced) | Bear (openShort → vetoOverpriced) |
|---|---|---|
| assets held | `baseAmount` LLM | `quoteAmount − fee` HKD |
| open cost | `quoteAmount + fee` HKD (paid) | `baseAmount` LLM (paid) |
| open ref price | quote `price` | quote `price` |
| 份数 (D-02) | LLM received | HKD notional ÷ open price |

### 4.5 Valuation & PNL (D-02/D-09, all client-side)

```
bull:  PNL = (现价 − 开仓价) × 份数       市场价值 = held_LLM × 现价
bear:  PNL = (开仓价 − 现价) × 份数       市场价值 = held_HKD
```

- 现价: mid-round = latest ACTIVE quote price; at expiry = `getLatestPrice` (终价).
- 开仓价 = the vetoed quote's locked `price` (no slippage — see-what-you-sign, B4).
- Expiry is **valuation-only**: cards switch to 「最终盈亏 ( @ 终价 )」+ "资产已在钱包，可反向
  平仓变现或持有". No settlement tx, no 领取 button (D-09).

### 4.6 Balances & allowances (order flow)

- `balanceOf(LLM/HKD, account)` polled (可用余额 display + low-balance hints).
- **Approve targets differ by action** (sc-tech-spec §5.2/§5.3):
  - open (long → HKD, short → LLM): approve the **wrapper**;
  - close (pay side depends on held asset): approve **MonoracleWindowed** directly.
- Allowance polled per target; the OrderButton promotes to "授权 (approve)" then the action.

---

## 5. Page / Component Spec (maps PRD §5.3)

### 5.1 Top navigation + wallet shell

- Left: IRMarket logo + name (yellow accent). Right: network badge, wallet button, HKD/LLM
  balances, faucet entry.
- Behaviors: not connected → yellow 「连接钱包」 (injected). Connected → truncated address +
  balances + `Monad Testnet` tag. Chain id ≠ 10143 → 「请切换至 Monad 测试网」 + one-click
  `switchChain`. Unconnected users on `/markets/[id]` or `/positions`: read-only + CTA.

### 5.2 Market list (`/`)

- One `MarketCard` per marketId: 标的「溜溜梅 LLM」+ 标签「港股 06658.HK」+ market `expiryBlock`
  countdown; current price (mid-round = latest ACTIVE quote; else `getLatestPrice`, fallback
  `—`); 看涨 (green) / 看跌 (red) quick buttons + detail arrow. Multiple markets per pair
  listed by expiry (D-14).
- Card click → `/markets/[marketId]`; quick button pre-selects that side; unconnected →
  connect flow first.

### 5.3 Market detail + trading panel (`/markets/[marketId]`) — core page

Left card (标的信息): name/备注, current chain price (ACTIVE-quote or `getLatestPrice`),
market expiry (`expiryBlock`) + countdown. Right card (trade panel):

1. **Quote card (`QuoteCard`)**: the selected ACTIVE quote — 报价 `P`, quote size
   (`baseAmount` LLM ⇄ `quoteAmount` HKD, **whole-quote**, B4), 窗口到期 = market expiry.
   无可用报价 degraded state when none (B4).
2. **Tabs** 看涨 (做多) / 看跌 (做空) — selected = yellow fill. Toggling swaps the payable
   asset (bull → HKD, bear → LLM) and flips the preview; each side shows its underlying
   份额 output.
3. **Amount display + 可用余额**: since vetoes are whole-quote, the trade amount **is the
   quote's size** (`quoteAmount` for long, `baseAmount` for short) — displayed prominently,
   not an arbitrary input (fractional veto out of scope, B4). Balance hint warns if the user
   can't cover size + fee.
4. **Preview (`TradePreview`)**: 将按 `P` 与报价者换手 · 付 `X` HKD / 收 `Y` LLM (long) 或
   付 `Y` LLM / 收 `X−fee` HKD (short) · **手续费 `fee` HKD (1% × quoteAmount, D-11/D-16 —
   explicitly shown)** · 最大亏损 = 投入本金. Fee = 0 shown as 0% until wrapper deploys.
5. **Main button**: 「确认看涨开仓」(green) / 「确认看跌开仓」(red) → `openLong`/`openShort`
   (or direct veto if wrapper off); sign → loading → success card (received asset + tx link,
   incl. `VetoWrapped`) / failure card (retry) via common `TxStatusCard`.

Copy block: **"多空市场 · 默认 3 分钟到期 · 随时反向平仓 · 无爆仓风险"** (D-01 expiry is a
market property shown as countdown, not a per-trade selector).

### 5.4 Positions (`/positions`)

- Tabs 进行中 / 已结算 (settled = market expired).
- `PositionCard`: 方向标签 (看涨 = 持有 LLM / 看跌 = 持有 HKD); 开仓价; 当前报价 (ACTIVE-quote
  price mid-round / `getLatestPrice` at expiry); 持仓市值; 浮动盈亏 (盈绿亏红); market expiry
  countdown.
- Pre-expiry action: yellow-outlined 「反向平仓」 → reverse-veto preview card (付 `X` 收 `Y`
  @ 新报价 `P'`, **no fee**) → sign **direct** `vetoOverpriced`/`vetoUnderpriced` on
  MonoracleWindowed → position closes on receipt.
- Post-expiry: card = 「最终盈亏 ( @ 终价 )」 + hint "资产已在钱包，可反向平仓变现或持有"。
  **No 结算/领取 button** (D-09).
- Empty state: guide to markets + faucet CTA.

### 5.5 Faucet

- `FaucetModal`: one-click mint of `LLM` + `HKD` (MockERC20 `mint`, demo/dev-guarded). MON
  reserve is out-of-band (§7.2).

### 5.6 Common transaction status feedback

`TxStatusCard` (loading / success / failed) reused for approve, `openLong`/`openShort`,
direct close. Success shows tx hash with explorer link (`testnet.monadscan.com`). Failure
maps viem revert data to friendly text (§9).

---

## 6. Design System (Tailwind v4 `@theme`)

Replace the current Monad-purple tokens in `src/app/globals.css` per PRD §5.1:

```
--color-primary:  #FFD400 (明黄 — brand, primary buttons, key numbers)
--color-bull:     #16C784 (green — 看涨 / profit)
--color-bear:     #F6465D (red — 看跌 / loss)
--color-bg-dark:  #0E100F (deep gray background; keep existing)
--color-card:     #17181B
--color-text:     #FBFAF9
```

- Card layout throughout; primary CTA = yellow fill, reverse-close = yellow outline; direction
  tags/buttons use green/red. Yellow is reserved for the single most important action/number
  per view.

---

## 7. Monad-Specific Behavior

### 7.1 Gas is charged by limit, not usage

Monad bills `gas_limit × price`; inflated limits are real cost. Fixed limits (sc-tech-spec
§7, fork-consistent):

| Op | Recommended limit | Notes |
|---|---|---|
| `openLong` / `openShort` (wrapper) | **450,000** | wrapper transfers + oracle veto ≈ 250–300k |
| `vetoUnderpriced` / `vetoOverpriced` (direct close) | 300,000 | upstream-consistent |
| approve (token → wrapper or oracle) | 60,000 | |
| (bot-only) submitQuote / settle / withdraw | 600k / 150k / 200k | not used by UI |

Pass a fixed `gasLimit` in the send params; do **not** rely on `estimateGas` + wallet default
fallback (a revert can inflate the limit → overbilling). Surface reverts via error mapping
(§9) instead.

### 7.2 Reserve balance

All EOAs need ≥ **10 MON** reserve (low accounts throttle ~1 tx / 1.2s). Trades need
collateral **and** gas; the wallet area warns when MON is near the floor or after a failed
tx. Faucet covers LLM/HKD, not MON.

### 7.3 Block states & finality

- Reads use `latest` for price/quote display (fast, speculative).
- Success state waits on **finalized** (`blockTag: "finalized"`, ~2 slots ≈ 600ms) so the
  success card reflects canonical state.
- Expiry countdown ticks off `watchBlockNumber` (300ms blocks).

### 7.4 Real-time data

- Preferred: Geth-compatible WS `eth_subscribe` (`newHeads` + `logs`) for `QuoteSubmitted`,
  `QuoteSettledValid`, `VetoWrapped`, `MarketCreated` — fastest live quotes/marks.
- Fallback: HTTP polling (price interval + last-quoteId poll); the app degrades silently on
  WS loss.
- No indexer needed for demo: positions come from the user's own event logs (§4.4).

---

## 8. Flow Walkthroughs (PRD §5.4)

### Scenario 1 — 看跌开仓 (bear open, short)

1. `/` → pick 看跌 on the LLM card → `/markets/[marketId]` with short tab pre-selected.
2. `QuoteCard` shows the ACTIVE quote `P` and its size (付 `baseAmount` LLM / 收
   `quoteAmount − fee` HKD) or 无可用报价 + disabled CTA.
3. Preview confirms price, size, and 手续费 in HKD; balance check.
4. Approve wrapper for LLM if needed → 确认看跌开仓 → `openShort(marketId, quoteId)` signed.
5. Sign → loading → success (view HKD received + tx link); position derived from
   `VetoWrapped(trader=user)`. `/positions` shows 空头浮盈.

### Scenario 2 — 反向平仓 (reverse close, direct)

1. `/positions` → 反向平仓 (yellow outline).
2. Trade panel reuses the ACTIVE-quote flow in reverse direction, **no fee**; preview 付 `X`
   收 `Y` @ `P'`.
3. Approve MonoracleWindowed for the pay-side token if needed → sign **direct**
   `vetoOverpriced`/`vetoUnderpriced` → on receipt the position disappears.

### Scenario 3 — 到期 (expiry valuation)

1. Market reaches `expiryBlock`; bot settles oldest-first, final quote last (D-06/B12) →
   `getLatestPrice` = 终价.
2. Card switches to 最终盈亏 ( @ 终价 ), yellow big-font number, no action button; hint "资产
   已在钱包".
3. User may reverse-veto 变现 (direct) or hold into the next market round.

---

## 9. State & Error Handling

| Condition | Behavior |
|---|---|
| Wallet not connected | read-only + connect CTA; no trade |
| Wrong chain (≠ 10143) | 「请切换至 Monad 测试网」 + one-click switch |
| No ACTIVE quote (`无可用报价`, B4) | degraded banner; order disabled; poll/WS keeps trying |
| Market expired (`block.number > expiryBlock`) | trade panel disabled; show 到期 state |
| `getLatestPrice` exists=false / no settled price | 「等待 bot 建立报价」; price shows — |
| Insufficient balance (size + fee) | button disabled + hint |
| Insufficient allowance | promote to approve step per target (§4.6) |
| Veto past window (`VerificationWindowExpired` / wrapper pre-check `QuoteWindowExpired`) | "报价已失效，请选择最新交易" + reselect ACTIVE quote |
| Quote already vetoed/settled (`QuoteNotActive`) | same retry-new-quote message |
| Wrong market / quote mismatch (`MarketDoesNotExist`) | reselect market |
| Gas / reserve shortage | low-MON warning; fixed-limit retry (§7.1) |
| WS loss | silent HTTP fallback (§7.4) |
| Tx failure | `TxStatusCard` failed + mapped reason + retry |

Write hooks (`useTrade`) map viem `decodeErrorResult` against the wrapper + fork error sets
(sc-tech-spec §3.7): `MarketDoesNotExist`, `InvalidToken`, `IdenticalTokens`, `FeeTooHigh`,
`ExpiryMustBeFuture`, `QuoteNotActive`, `QuoteWindowExpired`, `NoValidPrice`,
`VerificationWindowExpired`, `QuoteDoesNotExist`, `InsufficientAllowance`, reentrancy + SafeERC20.

---

## 10. Test Strategy (Playwright E2E)

`web/tests/setup.ts` (TODO) must: compile + deploy `MonoracleWindowed` + `IRMarket(oracle)`,
mint `LLM`/`HKD`, `createMarket(LLM, HKD, bot, expiryBlock, feeBps=100)`, boot a quote bot on
a local Hardhat node (127.0.0.1:8545), fund EAOs (LLM/HKD + MON), write `web/.env.local`,
start Next dev, teardown.

Specs (mirror §8 + sc-tech-spec §9):

- `01-smoke`: home renders market cards (per marketId; multi-market per pair listed by
  expiry, D-14).
- `03-short-open`: connect → short tab → preview (quote size, HKD fee) → approve(LLM→wrapper)
  → `openShort` → success → position appears (direction/cost/份数 correct).
- `04-long-open`: `openLong` gross pull = `quoteAmount + fee` HKD (assert fee reaches MM via
  `VetoWrapped`).
- `05-reverse-close`: open then **direct** reverse veto; position removed; balances reflect
  swap; no fee charged on close.
- `06-expiry`: advance past `expiryBlock`; card shows 最终盈亏 @ 终价 and **no** 领取 button;
  veto after expiry reverts (`QuoteWindowExpired`/`VerificationWindowExpired`).
- `07-wallet`: wrong-chain prompt + switch; unconnected gates trade.
- `08-degraded`: no ACTIVE quote → 无可用报价; `exists=false` → 等待 bot 建立报价.
- `02-whole-quote`: order size = quote size; no partial-fill input (B4 UX).

Run: `npx playwright test` (headed variant available). Unit/integration coverage lives in
`npx hardhat test` (sc-tech-spec §9).

---

## 11. Flagged Dependencies (specified elsewhere; UI accounts for them)

### 11.1 The IRMarket wrapper interface (sc-tech-spec §3.4) — **specified, not pending**

The UI calls these once `contracts/IRMarket.sol` ships:

```
openLong(uint256 marketId, uint256 quoteId)   // vetoUnderpriced + 1% HKD fee (gross pull)
openShort(uint256 marketId, uint256 quoteId)  // vetoOverpriced; forwards quoteAmount − fee
markets(uint256) → Market;  nextMarketId()
createMarket(...)                             // registry/dapp uses for read-only listing
```

- Approval target for opens = the **wrapper**; for closes = **MonoracleWindowed** (§4.6).
- Until the wrapper deploys, the demo can run fee-less direct vetoes (UI shows 0% fee;
  `CHARGER_FEE_BPS = 0`); flipping D-11 on is a config + `openLong/openShort` switch.

### 11.2 B5 — real quote data source (bot side)

`06658.HK` live feed provider pinned at dev time; no UI impact beyond the 「港股 06658.HK」
label (D-12 narrative locked).

### 11.3 B4 whole-quote granularity

Veto semantics = whole-quote fills; the UI *walks* the ACTIVE quote's size instead of
accepting arbitrary amounts (fractional veto out of scope; demo UX choice flagged).

---

## 12. Reference Map

| PRD / SC spec | This doc |
|---|---|
| PRD §〇 streams 1–7; SC §12 veto semantics | §1.2, §4.2, §4.4 |
| SC D-13 per-quote `expiryBlock` (fork) | §4.2 (market-level countdown, §1.2) |
| PRD D-01 expiry | §4.2, §5.3 (market property) |
| PRD D-02 PNL | §4.5 |
| PRD D-05 / D-06 quote cadence & 终价 | §4.3, §8 Scenario 3 |
| PRD D-08 direction = veto; close = reverse veto | §1.2, §5.3, §8 Scenario 2 |
| PRD D-09 no settlement / 领取 | §5.4, §8 Scenario 3 |
| SC D-11/D-16 HKD fee, gross-pull model | §1.2, §5.3, §7.1, §10 |
| SC D-14 multi-market per pair | §3.1, §5.2 |
| PRD B4 degraded states | §4.2, §5.3, §9 |
| SC B4 whole-quote fill | §1.2, §5.3, §11.3 |
| SC B12 mid-round / expiry marks | §4.3, §4.5 |
| PRD §5.1 design spec | §6 |
| PRD §5.4 scenarios | §8 |