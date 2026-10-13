# IRMarket LP-Pool MVP — Frontend Handoff

> **Audience:** the `web/` team. **Goal:** build UI for the newly added **LP-pool MVP**
> (`contracts/IRMarketVault.sol`) — a pool that is the counterparty and settles positions
> against Monoracle's canonical price.
>
> **Read first:** `docs/design/lp-pool-tech-spec.md` §1.4 (MVP cut), §4.2 (payoff), §6
> (accounting), §9 (lifecycle); `docs/design/lp-pool-mvp-impl-plan.md` §3 (API/math), §6
> (accepted risks). Contract + tests: `contracts/IRMarketVault.sol`, `test/IRMarketVault.e2e.test.js`.

---

## 0. TL;DR

Add a **Vault** path next to the existing V0.9 veto-market UI:

- **LP tab** — deposit the settlement token → shares; withdraw shares; show `equity`, `totalShares`,
  share price, `pendingPayout`.
- **Trade tab** — pick side (LONG/SHORT), amount, tenor → preview fee/notional/max-payout →
  `openPosition`; then a **Positions** list with a **Settle** action after expiry.
- **Price header** — read `IMonoracle.getLatestPrice(base, quote)`; disable trading when the
  price is missing/zero.

⚠️ **Do not mix the two semantics.** V0.9 = "Monoracle is the venue and the price; trade = veto".
LP pool = "Monoracle is *only* the price; trade = a vault position". Different contracts,
different flows (see `AGENTS.md`).

---

## 1. Deployed addresses (Monad testnet)

The vault **reuses the V0.9 app stack** — the same tokens the faucet mints and the same oracle
the V0.9 bot publishes to — so the frontend's "Claim test tokens" funds vault deposits and the
vault marks to a live canonical price. The vault is **single-asset**: it only custodies
`settlementToken` (the **quote** token, HKD); `priceBase` (the **base** token, LLM) is used solely
as the Monoracle pair key to derive the price. Every deposit, premium, payoff and equity figure is
in `settlementToken`.

| Contract | Address |
|---|---|
| `IRMarketVault` | `0xDf1BdE04532ED1Bd0DF3fc92A0f0853e904a8188` |
| Monoracle (V0.9 app oracle) | `0xb6523DA6f177dB25d766a27575624B3e1fe0a00e` |
| `priceBase` token (LLM) | `0xC065c5C371DFfcA7C167418810498506c57D1F35` |
| `settlementToken` (HKD) | `0x34675029742e7E5Fea3637F68c911414a47F9752` |
| Deployer / operator | `0xF5Cf3950CA8055408648Ce5c155B2b3967269fcE` |

- These are also written to `deployment-vault.json` (repo root, gitignored) by
  `script/deploy-vault-rpc.js`.
- **Reuse mode (what is deployed above):** set `ORACLE_ADDRESS`, `PRICE_BASE` and
  `SETTLEMENT_TOKEN` and the script deploys **only** the vault against that existing stack (it
  skips the smoke test). `BASE_TOKEN`/`QUOTE_TOKEN` are accepted as legacy aliases. Without those
  env vars it deploys a fresh `MonoracleMock` + `MockERC20` pair instead.
- **Local dev:** run `anvil` (Foundry, in WSL) then `node script/deploy-vault-rpc.js` — it
  deploys a fresh stack and prints addresses (anvil chainId `31337`, RPC `http://127.0.0.1:8545`).
- The standalone stack was lifecycle smoke-tested on both anvil and Monad (LP deposit → open
  LONG → price up → settle → withdraw; payout `148.5`, LP equity `951.5`). The deployed vault
  above is wired to the V0.9 oracle/tokens, so its canonical price is whatever the V0.9 bot
  last settled.

---

## 2. Contract reference — `IRMarketVault`

Source: `contracts/IRMarketVault.sol`. Full ABI artifact:
`artifacts/contracts/IRMarketVault.sol/IRMarketVault.json` — copy into
`web/src/lib/abis/vault.ts` following the existing `abis/market.ts` / `abis/oracle.ts` style.

### Constructor (immutables)
```solidity
constructor(address oracle, address priceBase, address settlementToken, uint256 feeBps)
// public getters: oracle, priceBase, settlementToken, feeBps
// constants: MAX_FEE_BPS = 10_000, MAX_PROFIT_BPS = 10_000
```

### Enums / structs
```solidity
enum Side   { LONG, SHORT }              // 0 = LONG, 1 = SHORT  (ABI: uint8)
enum Status { OPEN, SETTLED }            // 0 = OPEN, 1 = SETTLED

struct Position {
    address owner;
    Side    side;          // uint8
    uint256 deposit;       // gross premium paid (settlement-native)
    uint256 fee;           // deposit - notional
    uint256 notional;      // N, at-risk capital
    uint256 entryPrice;    // WAD 1e18
    uint256 maxPayout;     // <= 2 * notional
    uint64  expiryBlock;
    Status  status;        // uint8
}
```

### Writes
```solidity
function deposit(uint256 amount) external returns (uint256 sharesMinted);
function withdraw(uint256 shareAmount) external returns (uint256 amount);
function openPosition(uint8 side, uint256 depositAmount, uint64 tenorBlocks) external returns (uint256 positionId);
function settlePosition(uint256 positionId) external returns (uint256 payout); // permissionless
```

### Reads
```solidity
function balance() external view returns (uint256);        // cached quote balance
function pendingPayout() external view returns (uint256);  // worst-case obligation over OPEN
function totalShares() external view returns (uint256);
function shares(address lp) external view returns (uint256);
function equity() external view returns (uint256);         // balance - pendingPayout
function positionCount() external view returns (uint256);
function positions(uint256 id) external view returns (Position memory);
```

`positions(id)` returns the struct **positionally** (viem returns a tuple/array):
`[owner, side, deposit, fee, notional, entryPrice, maxPayout, expiryBlock, status]`.

### Events
```solidity
event Deposited(address indexed lp, uint256 amount, uint256 shares);
event Withdrawn(address indexed lp, uint256 shares, uint256 amount);
event PositionOpened(uint256 indexed positionId, address indexed trader, uint8 side,
                     uint256 deposit, uint256 notional, uint256 entryPrice, uint64 expiryBlock);
event PositionSettled(uint256 indexed positionId, uint256 settlePrice, uint256 payout);
```

### Errors (map to user messages — see §8)
`InvalidConfig`, `ZeroAmount`, `ZeroTenor`, `PriceUnavailable`, `Insolvent`,
`DepositAtZeroEquity`, `InsufficientShares`, `NotOpen`, `NotExpired`.

### Oracle read used
`IMonoracle.getLatestPrice(priceBase, settlementToken) → (uint256 price /*WAD*/, uint32 settledSlot, bool exists)`.
The vault treats `price == 0` as unavailable (`PriceUnavailable`).

---

## 3. Accounting & math (must match exactly)

All amounts are **native token units**; prices are **WAD `1e18`** — never mix them
(spec §13). Fee and payout both round **down**.

```
fee        = deposit × feeBps / 10_000            // floor
N          = deposit − fee                         // notional at risk
maxPayout  = N × (10_000 + 10_000) / 10_000 = 2N   // worst case the vault reserves
units U    = N × 1e18 / entryPrice                 // base-native, informational

// settle, S0 = entryPrice, S = settle price (both WAD):
pnl        = LONG ? N×(S−S0)/S0 : N×(S0−S)/S0      // signed
pnl        = clamp(pnl, −N, +N)                    // cap = maxProfitBps
payout     = N + pnl                               // ∈ [0, 2N]

// LP shares (conservative equity):
equity     = balance − pendingPayout
deposit:   shares = totalShares == 0 ? amount : amount × totalShares / equity
           // reverts DepositAtZeroEquity when totalShares > 0 && equity == 0
withdraw:  amount = shares × equity / totalShares  // floor
```

**Worked example (use as a fixture):** LP deposits `1000`; trader opens LONG with `D=100`
→ `fee=1`, `N=99`, `maxPayout=198`; at `S0=100` the LP equity **dips to `902`**
(`Δopen = 2·fee − D = −98`, spec §6.5); at `S1=150` payout `= 148.5`, LP equity `951.5`.

### Things the UI must understand (and surface)
- **Conservative equity dips at open.** `equity` drops by ≈ the deposit at every open and
  recovers at settle. Share price is *not* mark-to-market — it only moves on
  deposit/withdraw/settle/fee. **Do not** show a live MTM LP PnL.
- **Deposit-side dilution (spec §6.5).** Because deposits are instant and shares mint at the
  *dipped* equity, a deposit while positions are open buys at a discount and harvests the
  recovery from incumbent LPs. Show a warning when `pendingPayout > 0`.
- **Withdraw is immediate** (no queue in the MVP). `withdraw` can only pay out of `equity`,
  so it never touches reserved capital; but it can revert `InsufficientShares`.
- **No early close.** A position can only be settled **after `expiryBlock`**.
- **Settlement is optionality-prone (accepted MVP risk).** `settlePosition` marks at the
  price **at call time**, not at expiry, so a holder can settle late. The UI should nudge
  settling promptly and disclose this.

---

## 4. UI surfaces to build

### 4.1 Price header
- `readContract(oracle, "getLatestPrice", [BASE_TOKEN, QUOTE_TOKEN])` → `{ price, settledSlot, exists }`.
- Show the canonical price (`formatPrice`). If `!exists || price === 0n` → show "Price
  unavailable" and **disable Open/Settle previews** (the vault would revert `PriceUnavailable`).
- Poll every ~5–15 s (see `useCurrentBlock` / react-query pattern).

### 4.2 LP tab
- **Deposit:** amount input (settlement token) → approve → `deposit(amount)`. After mining, read
  `shares(wallet)`, `totalShares`, `equity`.
- **Stats:** `equity`, `totalShares`, `balance`, `pendingPayout`, and **share price =
  `equity / totalShares`** (show `—` when `totalShares == 0`). Format with `formatAmount`
  (not `formatPrice` — this is a token amount, though it happens to be 1e18-scaled).
- **Withdraw:** shares input (or "Max" = `shares(wallet)`) → `withdraw(shares)`; preview the
  received amount = `shares × equity / totalShares`.
- **Warning banner** when `pendingPayout > 0`: "LP equity is reserving worst-case payouts;
  your share price will recover as positions settle. Depositing now buys at a discount."

### 4.3 Trade tab
- Inputs: **side** (LONG/SHORT toggle), **amount** `D` (settlement token), **tenor** (blocks —
  offer presets like 3 min ≈ 600 blocks @300 ms; the MVP accepts **any** tenor).
- **Preview** (compute client-side, mirror §3): `fee`, `N`, `maxPayout`, `units`. Show the
  entry price from §4.1. Show **max loss = premium** and **max profit = N** (payout capped at `2N`).
- **Open:** approve the settlement token to the vault (if needed) → `openPosition(side, D, tenorBlocks)`.
  Watch for `Insolvent` (pool can't cover `maxPayout`) — show "Pool capacity insufficient".
- No liquidation / no margin — the trader's max loss is the premium.

### 4.4 Positions list
- Enumerate `positionCount()` and `positions(i)`; filter `Position.owner === wallet`.
  (MVP-friendly; for scale, index `PositionOpened` events — see §5.)
- Row: side, `deposit`, `notional`, `entryPrice` (`formatPrice`), `expiryBlock` +
  countdown (`formatCountdown`, which assumes ~600 blocks/3 min), `status`.
- **Live payout preview** for OPEN positions at the current price (formula §3), labelled
  "estimated at current price".
- **Settle** button: enabled only when `currentBlock >= expiryBlock`. `settlePosition` is
  **permissionless** — anyone may call it, proceeds go to the owner — so a "Settle" (or an
  auto-settle keeper) is fine. Show `PositionSettled` payout.
- Once `status == SETTLED`, show the realized payout and PnL (`payout − deposit`).

### 4.5 Activity feed (optional)
- Index `Deposited`, `Withdrawn`, `PositionOpened`, `PositionSettled` (chunked — §5).

---

## 5. Reading data (viem patterns — reuse existing conventions)

- Use `usePublicClient()` + `readContract` (see `web/src/hooks/usePositions.ts`,
  `useBalances.ts`). Multi-output functions decode to a positional array; a single **struct**
  output (e.g. `positions(id)`) decodes to a **named object** in this viem version
  (`res.owner`, not `res[0]`).
- **Do not call `publicClient.multicall()`** — `web/src/lib/wagmi.ts` sets `contracts: {}` on
  the chain, so viem throws `multicallAddress is required` in the browser. Use plain
  `readContract` (or wagmi's `useReadContracts`, which falls back to individual reads). The
  vault hooks (`useVault.ts`, `useVaultPositions.ts`) were fixed for exactly this.
- **`eth_getLogs` on Monad testnet is capped at ~100 blocks** — event history must be fetched
  in chunked windows and in parallel (existing `usePositions.ts` uses `LOG_CHUNK_BLOCKS = 100n`
  with a `LOOKBACK_BLOCKS` scan and `Promise.all`). For MVP positions, prefer the
  `positionCount()`/`positions()` getters (no log scan needed).
- Poll on block changes (existing `useCurrentBlock`). Suggested new hooks:
  `web/src/hooks/useVault.ts` (deposit/withdraw/equity/shares),
  `web/src/hooks/useVaultPositions.ts`, `web/src/hooks/useVaultTrade.ts` (open/settle).

---

## 6. Config & formatting conventions (repo-specific — do not deviate)

- **`NEXT_PUBLIC_*` must be referenced as literals** in `web/src/lib/config.ts`
  (`process.env.NEXT_PUBLIC_VAULT_ADDRESS`). Dynamic `process.env[key]` resolves to `""` in
  the browser (Next.js/Turbopack only inlines literals). Add:
  ```ts
  export const VAULT_ADDRESS_RAW = process.env.NEXT_PUBLIC_VAULT_ADDRESS || "";
  export const VAULT_ADDRESS = VAULT_ADDRESS_RAW as `0x${string}`;
  export const hasVault = VAULT_ADDRESS_RAW !== "";
  ```
  and add `NEXT_PUBLIC_VAULT_ADDRESS=0x...` to `web/.env.local` /
  `web/.env.local.example`.
- **Formatting:** use `web/src/lib/format.ts` — `formatPrice` for WAD prices,
  `formatAmount` for token amounts, `formatPnl` for signed HKD PnL, `formatCountdown` for
  expiry. Never `toNumberString(price, 6)` directly.
- **Hydration:** use the `useHydrated` hook for wallet-dependent render to avoid wagmi
  hydration mismatches.
- **Function selectors:** compute with viem/ethers — never hand-write them.
- Follow the `web/AGENTS.md` rule: read `node_modules/next/dist/docs/` before writing Next.js
  code (this Next.js version differs from training data).

---

## 7. The price-publishing dependency (important for the demo)

The vault only sees a price once a **Monoracle quote is settled**. `getLatestPrice` returns
the **last settled** quote. So:

- The UI must handle "no canonical price" (`exists == false` / `price == 0`) → disable trading.
- For a **live demo**, a quote provider/operator must keep publishing + settling quotes on
  `(base, quote)`; otherwise the price never moves. `script/deploy-vault-rpc.js` publishes
  `S0`/`S1` for the smoke test; the existing `bot/verifier.py` is the V0.9 operator and can
  be adapted, but a vault keeper is **V1 scope** (spec §8.5, §15.2).
- The oracle exposes `nextQuoteId()` and `quotes(id)`; the mock's `submitQuote` →
  (mine/wait past `expiryBlock`) → `settleValidQuote(id)` is the publish path (see
  `script/deploy-vault-rpc.js` and `test/IRMarketVault.e2e.test.js` for exact usage).

---

## 8. Error → UI message mapping

| Revert | Meaning | Suggested copy |
|---|---|---|
| `PriceUnavailable` | no/zero canonical price | "Waiting for a trustworthy price — try again shortly." |
| `Insolvent` | pool can't cover `maxPayout` | "Pool capacity insufficient for this size." |
| `DepositAtZeroEquity` | deposit when `totalShares>0 && equity==0` | "The pool is fully reserved; deposits are paused until positions settle." |
| `InsufficientShares` | withdraw > wallet shares | "You don't have that many shares." |
| `NotExpired` | settle before expiry | "This position hasn't expired yet." |
| `NotOpen` | settle an already-settled position | "Already settled." |
| `ZeroAmount` / `ZeroTenor` | zero input | inline validation |
| `InvalidConfig` | constructor only | n/a |

---

## 9. Disclose the MVP limitations in the UI

Put a **demo banner** on the vault pages (link to spec §1.4). The MVP is a mechanics demo:

1. **Manipulable price** — settlement uses the raw canonical Monoracle price; anyone can move
   it with a tiny quote. V1's `PriceAdapter` (bond floor / freshness / circuit breaker) fixes this.
2. **No early close** — only settle after expiry.
3. **No refund** — if no valid price exists at/after expiry, the position is stuck until one appears.
4. **Settlement optionality** — settles at the price at call time (American-option-like).
5. **Deposit dilution** — see §3.
6. **Overflow can strand a position** — pathological price/amount; bounded grief.

---

## 10. Suggested file layout (mirror existing structure)

```
web/src/lib/abis/vault.ts          # minimal IRMarketVault ABI (copy artifact / human-authored)
web/src/lib/vault.ts               # pure helpers: computeFee, notional, maxPayout, units, payoutAt, sharePrice
web/src/hooks/useVault.ts          # reads: equity, balance, pendingPayout, totalShares, shares(wallet)
web/src/hooks/useVaultPositions.ts # positionCount + positions(i), owner filter, status
web/src/hooks/useVaultTrade.ts     # openPosition / settlePosition writes + receipts
web/src/components/vault/*         # LPPanel, TradePanel, PositionsList, PriceHeader, DemoBanner
```
Add `web/src/lib/abis/vault.ts` the same way `abis/market.ts` and `abis/oracle.ts` are done.

---

## 11. Testing

- Unit-test the math helpers in `web/src/lib/vault.ts` against the §3 fixture
  (`D=100 → fee=1, N=99, maxPayout=198; S0=100→S1=150 → payout=148.5, equity 902→951.5`).
- Playwright: `web/tests/setup.ts` currently deploys the V0.9 stack and writes
  `web/.env.local`. Extend it to also deploy `IRMarketVault` (or point
  `NEXT_PUBLIC_VAULT_ADDRESS` at `script/deploy-vault-rpc.js` output) and add a vault spec
  (`web/tests/e2e/13-vault-*.spec.ts`). Browser is Edge (`channel: "msedge"`).

---

## 12. Out of scope (do not build for the MVP)

Early close, refund/deferral, admission-cap UI (utilization/skew/position), factory /
multi-vault picker, ERC20 share token transfer UI, withdrawal queue, protocol fee/treasury,
meta-pool. These are V1 (`docs/design/lp-pool-tech-spec.md` §1.1, §15.2).

---

## 13. Reference

- Contract: `contracts/IRMarketVault.sol` · Tests: `test/IRMarketVault.test.js` (unit),
  `test/IRMarketVault.e2e.test.js` (E2E) · Demo: `script/deploy-vault-rpc.js`
- Spec: `docs/design/lp-pool-tech-spec.md` · Plan: `docs/design/lp-pool-mvp-impl-plan.md`
- Deployed addresses: `deployment-vault.json` (gitignored) / §1 above
