# IRMarket — Web Tech Design (Veto-Market)

> **Status:** Implemented, doc synced (V0.9.2). Mirrors `docs/prd.md` (V0.8.1) and
> `docs/sc-tech-spec.md` (V0.9) for the on-chain interface. The frontend is a **veto client**:
> users trade by vetoing ACTIVE quotes on **MonoracleWindowed** (the IRMarket-deployed fork of
> Monoracle) — bull via the fee wrapper `openLong`, bear via `openShort` (explicit `quoteId`,
> Q2-A); closes are direct reverse vetoes (D-08/D-11/D-16). No pool, no settlement, no claim
> (D-09). Decisions D-01 … D-16, Q1 … Q8 confirmed; the wrapper is **implemented**
> (`contracts/IRMarket.sol`, `0.9.0-vetomarket`).
>
> V0.9.1 changes: single static `/trade?m=` route (Q1-A), newest-ACTIVE-quote default (Q3-A),
> expiry settle-transient + short-close fee top-up (E3/E4), real error set (E2).
>
> V0.9.2 changes (this revision): **English UI copy** as canonical (single source of truth =
> `docs/product/ui_copy.md`), active-market-first sorting, HTTP-polling-only realtime,
> chunked `eth_getLogs` for positions (Monad RPC 100-block range cap), hydration guard
> (`useHydrated`), literal `NEXT_PUBLIC_*` env inlining rule, refreshed module map, live
> deployment `irmarket.xyz`. Future positions data-layer direction tracked in
> **github.com/dixia/IRMarket/issues/1** (§4.4).

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
| Long open (bull) | IRMarket `openLong(marketId, quoteId)` → via `vetoUnderpriced` | pay `quoteAmount + fee` HKD → receive `baseAmount` LLM | holds LLM |
| Short open (bear) | IRMarket `openShort(marketId, quoteId)` → `vetoOverpriced` | pay `baseAmount` LLM → receive `quoteAmount − fee` HKD | holds HKD |
| Close (D-08) | **direct** `vetoUnderpriced`/`vetoOverpriced` on MonoracleWindowed (no wrapper, no fee) | swaps back | flat |

Contract facts that constrain the UI:

- **Whole-quote fills (B4/veto semantics):** Monoracle's veto exchanges the quote's **full**
  `quoteAmount ⇄ baseAmount` — there are no partial fills. The trade size is the ACTIVE
  quote's size, not an arbitrary input (fractional veto out of scope). The UI *walks* the
  quote and reflects how much that is (§5.3).
- **Window = option expiry (D-13):** every quote carries its market round's `expiryBlock`;
  it stays vetoable until then. There is **no ~600ms per-quote race** — the countdown is a
  market-level one (§4.2). Veto after `expiryBlock` reverts.
- **Fee is HKD-only (D-16):** `fee = quote.quoteAmount × feeBps / 10000`, floor. LONG pays
  `quoteAmount + fee` (gross pull); SHORT receives `quoteAmount − fee`. Fee goes straight to
  the market maker in the same tx. Closes bypass the wrapper entirely (no fee, power-user
  direct veto — accepted demo limitation).
- **No settlement, no claim (D-09):** the swap lands assets in the wallet; PNL is a UI-side
  valuation (market value − cost). At expiry the UI shows the final-price mark only.
- **Positions are event-derived:** indexed from `VetoWrapped` (wrapper opens, attributes
  `trader`) + `QuoteVetoedUnderpriced/Overpriced` (direct closes verifier = user). No on-chain
  ledger (R15). See §4.4 for the fetch strategy and the open data-layer question
  (github.com/dixia/IRMarket/issues/1).

### 1.3 Source of truth

- Product + UI flow: `docs/prd.md` (V0.8)
- On-chain vocab & fee/window semantics: `docs/sc-tech-spec.md` (V0.9)
- **UI copy: `docs/product/ui_copy.md`** — the canonical English strings for every screen.
  Components reference these exact strings; do not introduce ad-hoc wording.
- ABI: `src/lib/abis/oracle.ts` (`MonoracleWindowed`) + `src/lib/abis/market.ts` (IRMarket +
  ERC20)
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
| Wallet | injected (Rabby / MetaMask) | `src/lib/wagmi.ts`; Monad testnet 10143 |
| Tests | Playwright (msedge) | `web/tests/`, §10 |

Unchanged Ethereum tooling, with Monad-specific behaviors encoded: gas is charged by limit
(§7.1), finality ~600ms (§7.3), realtime is **HTTP polling** (§7.4).

---

## 3. Architecture

### 3.1 Route tree

```
/                           market list (one card per marketId; multiple per pair per D-14);
                            active (still-quoting) markets sorted first (§4.1)
/trade                      market detail + trading panel (core trade page; single static
                            route — marketId via query param `?m=<marketId>`, Q1-A;
                            optional `&side=long|short` pre-selects the side tab)
/positions                  positions (derived from veto + VetoWrapped events)
```

Markets are per-`marketId` (each `createMarket` mints a new id, **no pair dedup**, D-14); a
pair may appear as several cards. Because `output: "export"` (static) cannot pre-render
runtime-created marketIds, the detail page is a single static route reading `marketId` from
`useSearchParams()` (`/trade?m=1`); `/` cards link there (`&side=long|short` pre-selects a
side — `long`→bull, `short`→bear). `layout.tsx` hosts the nav shell (logo, network badge,
wallet, HKD/LLM balances, faucet entry — §5.1). `providers.tsx` is the `WagmiProvider` +
`QueryClientProvider` shell.

### 3.2 Module map (implemented, V0.9.2)

```
src/
├─ app/
│  ├─ layout.tsx             # nav shell (providers + AppShell, English metadata)
│  ├─ page.tsx               # market list (hero + cards + faucet)
│  ├─ trade/page.tsx         # detail + trading panel (static route, `?m=` + `&side=`)
│  └─ positions/page.tsx     # event-derived positions (tabs open/settled)
├─ components/
│  ├─ layout/AppShell.tsx    # header nav (Market/Positions) + wallet + faucet entry
│  ├─ wallet/                # WalletButton, NetworkBadge
│  ├─ faucet/FaucetModal.tsx # one-click LLM+HKD mint
│  ├─ market/                # MarketCard, BlockCountdown
│  ├─ trade/TradePanel.tsx   # QuoteCard + Long/Short tabs + preview + order button
│  ├─ position/              # PositionCard, ClosePanel (reverse close)
│  └─ common/                # Logo, TxStatusCard (loading/success/fail + error map)
├─ hooks/
│  ├─ useMarkets.ts          # react-query: markets registry + active-first sort + demo fallback
│  ├─ useQuotes.ts           # trailing-window ACTIVE quotes poll (4s), new via nextQuoteId
│  ├─ useReferencePrice.ts   # getLatestPrice poll (2s) + ACTIVE-quote mid-round mark + settling
│  ├─ usePositions.ts        # chunked getLogs: VetoWrapped + QuoteVetoed* → positions
│  ├─ useBalances.ts         # LLM/HKD balance poll (3s)
│  ├─ useCurrentBlock.ts     # useBlockNumber({watch}) for countdowns
│  ├─ useHydrated.ts         # hydration-safe mount flag (useSyncExternalStore)
│  └─ useTrade.ts            # approve → openLong/openShort/close + gas constants
├─ lib/
│  ├─ config.ts              # env, addresses, isFullyConfigured/hasWrapper, explorer URLs
│  ├─ market.ts              # derived read params (oracle ABI + pair)
│  ├─ wagmi.ts               # chain/config (Monad testnet 10143)
│  ├─ format.ts              # 1e18 fixed-point → display, fee math, countdown
│  ├─ types.ts               # Market/Quote/Position/PriceState
│  └─ abis/                  # oracle.ts, market.ts, MonoracleWindowed.json
```

### 3.3 ABI & addresses

- **MonoracleWindowed** (trading venue): `src/lib/abis/oracle.ts` — the **fork** ABI.
  UI-needed members: `quotes(uint256)`, `vetoUnderpriced`, `vetoOverpriced`, `nextQuoteId`,
  `getLatestPrice`, events `QuoteSubmitted` (carries `expiryBlock`),
  `QuoteVetoedUnderpriced`, `QuoteVetoedOverpriced`, `QuoteSettledValid`. Public getter shape
  (fork, V0.9 §3.8/§12):
  `quotes(quoteId) → (provider, baseToken, quoteToken, baseAmount, quoteAmount, price, startSlot, settledSlot, expiryBlock, status)`.
- **IRMarket wrapper**: `openLong(marketId, quoteId)`, `openShort(marketId, quoteId)`,
  `markets(uint256)` → `Market`, `nextMarketId`, events `MarketCreated` / `VetoWrapped`
  (sc-tech-spec §3). See §11.1 for the summed interface.
- **Tokens**: `LLM` (base) + `HKD` (quote) MockERC20.

### 3.4 Environment & config (`web/.env.local` → `src/lib/config.ts`)

```
NEXT_PUBLIC_RPC_URL=https://testnet-rpc.monad.xyz
NEXT_PUBLIC_CHAIN_ID=10143
NEXT_PUBLIC_ORACLE_ADDRESS=0x...            # MonoracleWindowed (IRMarket-deployed fork — NOT
                                            # upstream 0x1ABABc60... whose window is fixed 2 slots)
NEXT_PUBLIC_MARKET_ADDRESS=0x...            # IRMarket wrapper (openLong/openShort)
NEXT_PUBLIC_BASE_TOKEN=0x...                # LLM
NEXT_PUBLIC_QUOTE_TOKEN=0x...               # HKD
NEXT_PUBLIC_DEMO_MARKET_ID=1                # fallback market id when wrapper absent
NEXT_PUBLIC_EXPIRY_SECONDS=180              # 3-min default round cadence
```

- **Literal-only inlining (Monad/Next gotcha):** Next.js/Turbopack inlines
  `process.env.NEXT_PUBLIC_*` into client bundles **only as literals**. Dynamic access like
  `process.env[key]` resolves to `""` in the browser even when `.env.local` is set. `config.ts`
  therefore references each var literally (enforced — this bug previously blanked the config
  guard). Ultra-short var names are fine; never build a lookup helper keyed by string.
- **No throw on missing env:** `config.ts` degrades gracefully instead of fatalling. Guards:
  - `isFullyConfigured` = oracle + base + quote all set (needed for quotes/trade/positions).
  - `hasWrapper` = wrapper address set (decides wrapper vs direct-veto open, fee attribution).
  - Missing wrapper → **direct veto mode** (no fee) + demo market fallback (§4.1).
- Reads resolve through these; the app renders a "configuration missing" banner when env is
  incomplete, and a "not yet deployed" notice when the wrapper address is empty.

---

## 4. Data Layer

### 4.1 Markets (factory registry, D-07/D-14)

- React-query key `['markets']`: read `nextMarketId`, map over `markets(id)`; `MarketCreated`
  appends live. Each market = `Market{baseToken, quoteToken, marketMaker, feeBps, expiryBlock,
  createdAtBlock}`.
- **Sorting (V0.9.2):** markets still inside their quote window (active/still-quoting) sort
  **first** — soonest-expiring active first — then expired markets last. Demo = one pair
  (LLM/HKD); when the wrapper is absent a **demo market** is synthesized from env
  (`DEMO_MARKET_ID`, expiry = `now + EXPIRY_BLOCKS`) with `name: "Liuliumei"`, ticker
  `LLM 06658.HK`.

### 4.2 Tradeable quotes & countdown (HTTP polling)

- For a market, track ACTIVE quotes of the pair: `useQuotes` reads a **trailing window** of
  `quotes()` (`nextQuoteId − 200 … nextQuoteId`), 4s poll; keep only `status == ACTIVE` with
  `block.number <= expiryBlock` (vetoable). No WS — pure HTTP (see §7.4). The 200-quote cap is
  a demo sanity bound (bot rolls ~600-block rounds; a couple rounds fit comfortably).
- **Default tradeable quote = newest ACTIVE quote (Q3-A):** with D-13 the whole round is
  vetoable and the bot restocks, so several ACTIVE quotes may coexist (possibly different
  prices/sizes as the market moves). The UI shows/executes the **newest** one; older ACTIVE
  quotes are not offered by default (arbitrage on stale quotes is intentional, but kept out of
  the default path).
- **Countdown is market-level** (D-13): the round's `expiryBlock` → block→time conversion off
  `useCurrentBlock` (300ms blocks). `formatCountdown` renders `Xm Ys` / "Expired" (V0.9.2:
  English wording — see `ui_copy.md`).
- Degraded states:
  - **No tradeable quote:** no ACTIVE quote in window (bot off / collateral rolling, B4) →
    trade panel disabled with that message.
  - **Market expired / no placement:** after `expiryBlock`, no new vetoes for the round.

### 4.3 Reference price & mid-round marks (B12)

- Query `['price', pair, blockTag]`:
  - **At/after expiry:** `getLatestPrice` = final price **only after the bot settles the final
    quote** (oldest-first, final quote last — D-06/B12). Until the first post-expiry settle
    lands, `getLatestPrice` still holds the **previous round's** value (canonical is per-pair
    and persists) → the UI shows a transient final-price-settling state (E4) instead of a stale
    number; it flips to the final price once the final quote settles.
  - **Mid-round:** `getLatestPrice` may lag (only updates on settle, B12) → the "current price"
    on market cards/positions marks to the **latest ACTIVE quote's price** from the quote
    stream. `exists=false` (never settled yet) → degraded "waiting for bot quotes", trade
    disabled.
- Poll `getLatestPrice` ~2s as the settlement-bound baseline; prefer the ACTIVE-quote price
  for live display.

### 4.4 Positions (event-derived, chunked `eth_getLogs`)

- Sources per wallet (sc-tech-spec §3.5/§8.1):
  - `VetoWrapped(quoteId, marketId, trader, side, …)` where `trader == account` — the
    **wrapper opens**.
  - `QuoteVetoedUnderpriced` / `QuoteVetoedOverpriced` where `verifier == account` — **direct
    closes / power-user vetoes**; amounts reconstructed from `quotes(quoteId)`.
- **Fetch (V0.9.2):** Monad testnet RPCs cap `eth_getLogs` at a **~100-block range**
  (verified error: "eth_getLogs is limited to a 100 range"). `usePositions` therefore fetches
  both event families in **chunked ≤100-block windows** over a bounded ~5000-block lookback
  (≈25 min @300ms ≈ several bot rounds), `Promise.all` + per-chunk `.catch` (a failed chunk is
  not fatal), 15s poll / 5s stale. The raw logs are decoded via `decodeEventLog`, then hydrated
  with `quotes(quoteId)` for exact amounts/price/direction + expiry.
- **Open question (refine in github.com/dixia/IRMarket/issues/1):** raw `getLogs` is
  type-unfriendly and rate-limit-prone. Options evaluated: (1) on-chain `positionIndex[user]`
  in IRMarket (type-safe `positionsOf(user)` via `eth_call`, but departs from R15 + redeploy),
  (2) client-side incremental delta-scan (only new blocks per poll), (3) Envio indexer
  (GraphQL, infra). The doc describes the implemented chunked scan; the issue holds the
  forward-looking analysis.

Position record:

| Field | Bull (openLong → vetoUnderpriced) | Bear (openShort → vetoOverpriced) |
|---|---|---|
| assets held | `baseAmount` LLM | `quoteAmount − fee` HKD |
| open cost | `quoteAmount + fee` HKD (paid) | `baseAmount` LLM (paid) |
| open ref price | quote `price` | quote `price` |
| units (D-02) | LLM received | HKD notional ÷ open price |

### 4.5 Valuation & PNL (D-02/D-09, all client-side)

```
bull:  PNL = (current − open) × units     market value = held_LLM × current
bear:  PNL = (open − current) × units     market value = held_HKD
```

- 现价: mid-round = latest ACTIVE quote price; at expiry = `getLatestPrice` (final price).
- Open price = the vetoed quote's locked `price` (no slippage — see-what-you-sign, B4).
- Expiry is **valuation-only**: cards switch to final PnL (@ final price) + "assets already in
  your wallet — reverse-close to cash out or hold". No settlement tx, no claim button (D-09).

### 4.6 Balances & allowances (order flow)

- `balanceOf(LLM/HKD, account)` polled (3s) for the available-balance display + low-balance
  hints.
- **Approve targets differ by action** (sc-tech-spec §5.2/§5.3):
  - open (long → HKD, short → LLM): approve the **wrapper**;
  - close (pay side depends on held asset): approve **MonoracleWindowed** directly.
- Allowance polled per target; the order button promotes to "Approve" then the action.

---

## 5. Page / Component Spec (maps PRD §5.3)

> All copy below is the canonical English UI copy; the full string registry lives in
> `docs/product/ui_copy.md` and is the single source of truth. Components must reference
> those exact strings.

### 5.1 Top navigation + wallet shell

- Left: IRMarket logo + name (yellow accent). Right: network badge, wallet button, HKD/LLM
  balances, faucet entry.
- Behaviors: not connected → "Connect wallet" (injected). Connected → truncated address +
  balances + `Monad Testnet` tag. Chain id ≠ 10143 → "Switch to Monad Testnet" + one-click
  `switchChain`. Unconnected users on `/trade` or `/positions`: read-only + CTA.
- **Hydration guard (V0.9.2):** wagmi rehydrates the connected account during the client's
  first render, which breaks SSR HTML parity. Components that render account/chain state use
  `useHydrated()` (`useSyncExternalStore`, server snapshot `false`) and render the
  disconnected state until hydration completes — applied to WalletButton, NetworkBadge, home
  page (balances), TradePanel (account), positions page.

### 5.2 Market list (`/`)

- One `MarketCard` per marketId: asset "Liuliumei" + tag "LLM 06658.HK" + market `expiryBlock`
  countdown; current price (mid-round = latest ACTIVE quote; else `getLatestPrice`, fallback
  `—`); Long (green) / Short (red) quick buttons + detail arrow. Multiple markets per pair
  listed active-first (§4.1).
- Card click → `/trade?m=<marketId>`; quick button pre-selects that side
  (`&side=long|short`); unconnected → connect flow first.

### 5.3 Market detail + trading panel (`/trade?m=<marketId>`) — core page

Left card (asset info): name/note, current on-chain price (ACTIVE-quote or `getLatestPrice`),
market expiry (`expiryBlock`) + countdown. Right card (trade panel):

1. **Quote card**: the **newest ACTIVE quote** (Q3-A) — quote price `P`, quote size
   (`baseAmount` LLM ⇄ `quoteAmount` HKD, **whole-quote**, B4), expiry = market expiry.
   "No quote available" degraded state when none (B4).
2. **Tabs** Long / Short — selected = yellow fill. Toggling swaps the payable asset (bull → HKD,
   bear → LLM) and flips the preview; each side shows its units output.
3. **Amount display + available balance**: since vetoes are whole-quote, the trade amount **is
   the quote's size** (`quoteAmount` for long, `baseAmount` for short) — displayed prominently,
   not an arbitrary input (fractional veto out of scope, B4). Balance hint warns if the user
   can't cover size + fee.
4. **Preview**: will swap with the quoter at `P` · pay `X` HKD / receive `Y` LLM (long) or
   pay `Y` LLM / receive `X−fee` HKD (short) · **fee `fee` HKD (1% × quoteAmount, D-11/D-16 —
   explicitly shown)** · max loss = capital put in. Fee shown as 0% until the wrapper deploys.
5. **Main button**: "Confirm long position" (green) / "Confirm short position" (red) →
   `openLong`/`openShort` (or direct veto if wrapper off); sign → loading → success card
   (received asset + tx link, incl. `VetoWrapped`) / failure card (retry) via common
   `TxStatusCard`.

Copy block: "Long/short market · 3-minute default expiry · reverse-close anytime · no
liquidations" (D-01 expiry is a market property shown as countdown, not a per-trade selector).

### 5.4 Positions (`/positions`)

- Tabs Open / Settled (settled = market expired).
- `PositionCard`: direction badge (Long = holds LLM / Short = holds HKD); open price; current
  quote (ACTIVE-quote price mid-round / `getLatestPrice` at expiry); market value; floating PnL
  (profit green, loss red); market expiry countdown. Settled card shows final value + final
  PnL + "Settled" badge.
- Pre-expiry action: yellow-outlined "Reverse close" → reverse-veto preview card (pay `X`
  receive `Y` @ new quote `P'`, **no fee**) → sign **direct**
  `vetoOverpriced`/`vetoUnderpriced` on MonoracleWindowed → position closes on receipt.
  - **Short-close top-up (E3):** a wrapper short received `quoteAmount − fee` HKD at open, but
    closing pays the **full** `quoteAmount` HKD → the preview shows "Top-up required (fee
    deducted at open)" and validates balance against `quoteAmount`. The `fee` is the
    round-trip cost by design (D-16).
- Post-expiry: card = final PnL (@ final price) + hint "assets already in your wallet —
  reverse-close to cash out or hold". **No settle/claim button** (D-09).
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

Tokens in `src/app/globals.css` per PRD §5.1:

```
--color-primary:  #FFD400 (bright yellow — brand, primary buttons, key numbers)
--color-bull:     #16C784 (green — long / profit)
--color-bear:     #F6465D (red — short / loss)
--color-bg-dark:  #0E100F (deep gray background)
--color-card:     #17181B
--color-text:     #FBFAF9
```

- Card layout throughout; primary CTA = yellow fill, reverse-close = yellow outline; direction
  tags/buttons use green/red. Yellow is reserved for the single most important action/number
  per view.

---

## 7. Monad-Specific Behavior

### 7.1 Gas is charged by limit, not usage

Monad bills `gas_limit × price`; inflated limits are real cost. Fixed limits (in
`useTrade.ts`, sc-tech-spec §7):

| Op | Recommended limit | Notes |
|---|---|---|
| `openLong` / `openShort` (wrapper) | **450,000** | wrapper transfers + oracle veto ≈ 250–300k |
| `vetoUnderpriced` / `vetoOverpriced` (direct close) | 300,000 | upstream-consistent |
| approve (token → wrapper or oracle) | 60,000 | |
| (bot-only) submitQuote / settle / withdraw | 600k / 150k / 200k | not used by UI |

Pass a fixed `gasLimit` in the send params; do **not** rely on `estimateGas` + wallet default
(a revert can inflate the limit → overbilling). Surface reverts via error mapping (§9).

### 7.2 Reserve balance

All EOAs need ≥ **10 MON** reserve (low accounts throttle ~1 tx / 1.2s). Trades need
collateral **and** gas; the wallet area warns when MON is near the floor or after a failed
tx. Faucet covers LLM/HKD, not MON.

### 7.3 Block states & finality

- Reads use `latest` for price/quote display (fast, speculative).
- Success state waits on **finalized** (`blockTag: "finalized"`, ~2 slots ≈ 600ms) so the
  success card reflects canonical state.
- Expiry countdown ticks off `useCurrentBlock` (`watchBlockNumber`, 300ms blocks).

### 7.4 Real-time data (V0.9.2: HTTP polling only)

- **Implemented: HTTP polling.** React-query `refetchInterval`: quotes 4s, `getLatestPrice`
  2s, balances 3s, `useBlockNumber({watch})`, positions 15s. No WS anywhere — `eth_subscribe`
  streaming is **future work**, not the current path.
- Rationale: Monad testnet public RPC endpoints used here do not reliably serve WS; polling is
  simpler, deterministic, and adequate for the demo cadence (3-min rounds).
- **`eth_getLogs` range cap:** any log query must chunk to ≤100-block windows (§4.4).

---

## 8. Flow Walkthroughs (PRD §5.4)

### Scenario 1 — Short open (bear)

1. `/` → pick Short on the LLM card → `/trade?m=<marketId>&side=short` with the short tab
   pre-selected.
2. Quote card shows the ACTIVE quote `P` and its size (pay `baseAmount` LLM / receive
   `quoteAmount − fee` HKD) or "No quote available" + disabled CTA.
3. Preview confirms price, size, and fee in HKD; balance check.
4. Approve wrapper for LLM if needed → "Confirm short position" → `openShort(marketId,
   quoteId)` signed.
5. Sign → loading → success (view HKD received + tx link); position derived from
   `VetoWrapped(trader=user)`. `/positions` shows floating short PnL.

### Scenario 2 — Reverse close (direct)

1. `/positions` → "Reverse close" (yellow outline).
2. Trade panel reuses the ACTIVE-quote flow in reverse direction, **no fee**; preview pay `X`
   receive `Y` @ `P'`. For a short close the payable is the full `quoteAmount` HKD — show the
   shortfall vs the `quoteAmount − fee` received at open ("Top-up required", E3).
3. Approve MonoracleWindowed for the pay-side token if needed → sign **direct**
   `vetoOverpriced`/`vetoUnderpriced` → on receipt the position disappears.

### Scenario 3 — Expiry (valuation)

1. Market reaches `expiryBlock`. Until the bot settles the final quote, UI shows the
   final-price-settling transient (E4 — `getLatestPrice` still holds the previous round's
   value); then the bot settles oldest-first, final quote last (D-06/B12) →
   `getLatestPrice` = final price.
2. Card switches to final PnL (@ final price), yellow big-font number, no action button; hint
   "assets already in your wallet".
3. User may reverse-veto to cash out (direct) or hold into the next market round.

---

## 9. State & Error Handling

| Condition | Behavior |
|---|---|
| Wallet not connected | read-only + connect CTA; no trade |
| Wrong chain (≠ 10143) | "Switch to Monad Testnet" + one-click switch |
| No ACTIVE quote (B4) | degraded banner; order disabled; poll keeps trying |
| Market expired (`block.number > expiryBlock`) | trade panel disabled; show expired state |
| Market expired & final price not settled yet | final-price-settling transient; show latest ACTIVE-quote mark, not stale `getLatestPrice` (E4) |
| `getLatestPrice` exists=false / no settled price | "Waiting for bot quotes"; price shows `—` |
| Insufficient balance (size + fee) | button disabled + hint |
| Insufficient allowance | promote to approve step per target (§4.6) |
| Veto past window (`VerificationWindowExpired` / wrapper pre-check `QuoteWindowExpired`) | "Quote window passed — please select the latest quote" + reselect ACTIVE quote |
| Quote already vetoed/settled (`QuoteNotActive`) | same retry-new-quote message |
| Wrong market / quote mismatch (`MarketDoesNotExist`) | reselect market |
| Gas / reserve shortage | low-MON warning; fixed-limit retry (§7.1) |
| `eth_getLogs` chunk failure | per-chunk silent skip (positions) or silent HTTP retry |
| Tx failure | `TxStatusCard` failed + mapped reason + retry |

Write hooks (`useTrade`) map viem `decodeErrorResult` against the wrapper + fork error sets
(sc-tech-spec §3.7). On-chain sets (verified against the deployed contracts, E2; user-facing
strings in `ui_copy.md`):

- **IRMarket wrapper:** `MarketDoesNotExist`, `QuotePairMismatch`, `QuoteNotActive`,
  `QuoteWindowExpired`, `FeeTooHigh`, `ExpiryMustBeFuture`, `InvalidToken`, `IdenticalTokens`
- **MonoracleWindowed fork:** `VerificationWindowExpired`, `VerificationWindowActive`,
  `QuoteDoesNotExist`, `QuoteNotActive`, `QuoteAmountTooSmall`, `ZeroBaseAmount`,
  `ExpiryMustBeFuture`, `NotQuoteProvider`, `NotWithdrawable`
- **OpenZeppelin / OZ-adjacent (revert-data, not ABI errors):** `ERC20InsufficientAllowance`,
  `ERC20InsufficientBalance`, `SafeERC20FailedOperation`, `ReentrancyGuardReentrantCall`

`NoValidPrice` is **not** an on-chain revert — it is a UI-side read guard (no settled price),
handled in the data layer (§4.3), not via `decodeErrorResult`.

---

## 10. Test Strategy (Playwright E2E)

`web/tests/setup.ts` (TODO) must: compile + deploy `MonoracleWindowed` + `IRMarket(oracle)`,
mint `LLM`/`HKD`, `createMarket(LLM, HKD, bot, expiryBlock, feeBps=100)`, boot a quote bot on
a local Hardhat node (127.0.0.1:8545), fund EOA (LLM/HKD + MON), write `web/.env.local`,
start Next dev, teardown.

Specs (mirror §8 + sc-tech-spec §9):

- `01-smoke`: home renders market cards (per marketId; active-first, D-14); card link →
  `/trade?m=<marketId>` (Q1-A).
- `02-whole-quote`: order size = quote size (newest ACTIVE quote, Q3-A); no partial-fill
  input (B4 UX).
- `03-short-open`: connect → short tab → preview (quote size, HKD fee) → approve(LLM→wrapper)
  → `openShort` → success → position appears (direction/cost/units correct).
- `04-long-open`: `openLong` gross pull = `quoteAmount + fee` HKD (assert fee reaches MM via
  `VetoWrapped`).
- `05-reverse-close`: open then **direct** reverse veto; position removed; balances reflect
  swap; no fee charged on close (short close shows "Top-up required", E3).
- `06-expiry`: advance past `expiryBlock`; transient final-price-settling until the final
  quote settles, then final PnL @ final price and **no** claim button; veto after expiry
  reverts (`QuoteWindowExpired`/`VerificationWindowExpired`).
- `07-wallet`: wrong-chain prompt + switch; unconnected gates trade.
- `08-degraded`: no ACTIVE quote → "No quote available"; `exists=false` → waiting for bot
  quotes.

Run: `npx playwright test` (headed variant available). Unit/integration coverage lives in
`npx hardhat test` (sc-tech-spec §9).

---

## 11. Flagged Dependencies (specified elsewhere; UI accounts for them)

### 11.1 The IRMarket wrapper interface (sc-tech-spec §3.4) — **implemented, not pending**

`contracts/IRMarket.sol` is implemented (`0.9.0-vetomarket`). The UI calls:

```
openLong(uint256 marketId, uint256 quoteId)   // vetoUnderpriced + 1% HKD fee (gross pull)
openShort(uint256 marketId, uint256 quoteId)  // vetoOverpriced; forwards quoteAmount − fee
markets(uint256) → Market;  nextMarketId()
createMarket(...)                             // registry write — bot/script only, NOT in the UI
```

- **Explicit quoteId (Q2-A):** D-13 (window = round expiry) removed the 600ms race, so the UI
  commits to a specific quote — see-what-you-sign, zero slippage.
- Approval target for opens = the **wrapper**; for closes = **MonoracleWindowed** (§4.6).
- **Fee comes from `markets(marketId).feeBps`** (per-market, D-11/D-16) — there is **no global
  `CHARGER_FEE_BPS` switch**. A market created with `feeBps=0` is fee-free pass-through.
- `createMarket` is invoked by the deploy script / bot, not exposed in the dapp (listing only
  reads `markets()` / `MarketCreated`).

### 11.2 Market labels (V0.9.2)

Demo market: name **"Liuliumei"**, ticker **`LLM 06658.HK`**. `06658.HK` live feed provider is
pinned at dev time (bot-side); no UI impact beyond the ticker badge.

### 11.3 B4 whole-quote granularity

Veto semantics = whole-quote fills; the UI *walks* the ACTIVE quote's size instead of
accepting arbitrary amounts (fractional veto out of scope; demo UX choice flagged).

---

## 12. Live Deployment (V0.9.2)

- **Live URL:** `https://irmarket.xyz`
- Testnet addresses live in the repo's root **`deployment.json`** (oracle, market, LLM base,
  HKD quote, deployer/bot wallet). Vercel project env mirrors `web/.env.local`
  (`NEXT_PUBLIC_*`, see §3.4). Deploy from `web/` via `vercel --prod`.

---

## 13. Reference Map

| PRD / SC spec | This doc |
|---|---|
| PRD §〇 streams 1–7; SC §12 veto semantics | §1.2, §4.2, §4.4 |
| SC D-13 per-quote `expiryBlock` (fork) | §4.2 (market-level countdown, §1.2) |
| PRD D-01 expiry | §4.2, §5.3 (market property) |
| PRD D-02 PNL | §4.5 |
| PRD D-05 / D-06 quote cadence & final price | §4.3, §8 Scenario 3 |
| PRD D-08 direction = veto; close = reverse veto | §1.2, §5.3, §8 Scenario 2 |
| PRD D-09 no settlement / claim | §5.4, §8 Scenario 3 |
| SC D-11/D-16 HKD fee, gross-pull model | §1.2, §5.3, §7.1, §10 |
| SC D-14 multi-market per pair | §3.1, §5.2 |
| PRD B4 degraded states | §4.2, §5.3, §9 |
| SC B4 whole-quote fill | §1.2, §5.3, §11.3 |
| SC B12 mid-round / expiry marks | §4.3, §4.5 |
| V0.9.1 route `/trade?m=` (static export, Q1-A) | §3.1, §5.3 |
| V0.9.1 explicit `quoteId` (Q2-A) | §1.2, §11.1 |
| V0.9.1 newest-ACTIVE-quote default (Q3-A) | §4.2, §5.3 |
| V0.9.1 expiry settling transient (E4) | §4.3, §8, §9 |
| V0.9.1 short-close fee top-up (E3) | §5.4, §8 |
| V0.9.1 real error set (E2) | §9 |
| V0.9.2 English UI copy (canonical `ui_copy.md`) | §1.3, §5 |
| V0.9.2 active-market-first sort | §3.1, §4.1 |
| V0.9.2 HTTP-polling-only realtime | §7.4 |
| V0.9.2 chunked `eth_getLogs` (100-block cap) | §4.4, §7.4, §9 |
| V0.9.2 hydration guard (`useHydrated`) | §5.1 |
| V0.9.2 literal `NEXT_PUBLIC_*` inlining rule | §3.4, §12 |
| V0.9.2 live deployment `irmarket.xyz` | §12 |
| Positions data-layer direction (open) | §4.4 → issues/1 |
| PRD §5.1 design spec | §6 |
| PRD §5.4 scenarios | §8 |