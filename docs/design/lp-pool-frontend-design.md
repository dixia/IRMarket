# IRMarket LP-Pool — Frontend Design & As-Built Spec (`web/`)

> **Audience:** anyone maintaining or extending the `web/` vault UI. This is the
> **as-built** frontend spec for the LP-pool MVP (`contracts/IRMarketVault.sol`) — a pool
> that is the counterparty and settles positions against Monoracle's canonical price.
>
> **Requirements** live in `docs/prd.md` §十一（LP Vault）; **contract design** in
> `docs/design/lp-pool-tech-spec.md` (§1.4 MVP cut, §4.2 payoff, §6 accounting, §9
> lifecycle). Contract + tests: `contracts/IRMarketVault.sol`,
> `test/IRMarketVault.test.js`, `test/IRMarketVault.e2e.test.js`.
>
> **Status:** shipped (M6). Web unit tests 17, Playwright E2E 20/20, user-flow video at
> `docs/product/videos/lp-vault-user-flow.webm`.

---

## 0. TL;DR — what shipped

A **Vault** path (`/vault`) next to the existing V0.9 veto-market UI with three tabs:

- **LP tab** — deposit the settlement token → shares; withdraw shares; show `equity`,
  `totalShares`, share price, `pendingPayout`, plus a dilution warning when
  `pendingPayout > 0`.
- **Trade tab** — pick side (LONG/SHORT), amount, tenor → preview fee/notional/max-payout →
  `openPosition`.
- **Positions tab** — aggregate **Open PnL (estimated at current price)** + per-position
  cards with **Estimated PnL** while OPEN and **Realized payout / Realized PnL** once
  SETTLED (from `PositionSettled` logs), with a permissionless **Settle** action after
  expiry.
- **Price header** — read `IMonoracle.getLatestPrice(priceBase, settlementToken)`; disable
  trading when the price is missing/zero.

⚠️ **Do not mix the two semantics.** V0.9 = "Monoracle is the venue and the price; trade =
veto". LP pool = "Monoracle is *only* the price; trade = a vault position". Different
contracts, different flows (see `AGENTS.md`).

---

## 1. Deployed addresses (Monad testnet)

The vault **reuses the V0.9 app stack** — the same tokens the faucet mints and the same
oracle the V0.9 bot publishes to — so the frontend's "Claim test tokens" funds vault
deposits and the vault marks to a live canonical price. The vault is **single-asset**: it
only custodies `settlementToken` (the **quote** token, HKD); `priceBase` (the **base**
token, NVDA) is used solely as the Monoracle pair key to derive the price. Every deposit,
premium, payoff and equity figure is in `settlementToken`.

| Contract | Address |
|---|---|
| `IRMarketVault` | `0x3d52a82a8a79b4Aecc90F37e506a441e0eF908AB` |
| Monoracle (**upstream lazy build, consumed**) | `0x0BC36e1ac475AdEF75F102deb1708BE6E45aA16f` |
| `priceBase` token (NVDA) | `0xda9CF5A68cc2d8EFA5940db4094b6377D389DE17` |
| `settlementToken` (HKD) | `0x36448Ef080ba5fa251e1a9bd61782786f9e24F04` |
| Deployer / operator | `0xF5Cf3950CA8055408648Ce5c155B2b3967269fcE` |

> A-stack (upstream consumer) — live on `irmarket.xyz` since the 2026-10-24 lazy-settlement
> cutover. The pre-lazy stack (`vault 0x95a74C58…`, wrapper `0x3B08bd1C…`, oracle `0x80732110…`)
> and the fork stack (`vault 0xE4B88d…`, oracle `0xb652…`) stay deployed for rollback. Pin
> record: `docs/design/monoracle-version-survey.md`.

- These are also written to `deployment-vault.json` (repo root, gitignored) by
  `script/deploy-vault-rpc.js`.
- **Reuse mode (what is deployed above):** set `ORACLE_ADDRESS`, `PRICE_BASE` and
  `SETTLEMENT_TOKEN` and the script deploys **only** the vault against that existing stack
  (it skips the smoke test). `BASE_TOKEN`/`QUOTE_TOKEN` are accepted as legacy aliases.
  Without those env vars it deploys a fresh `MonoracleMock` + `MockERC20` pair instead.
- **Local dev:** run `anvil` then `node script/deploy-vault-rpc.js` — it deploys a fresh
  stack and prints addresses (anvil chainId `31337`, RPC `http://127.0.0.1:8545`).
- The standalone stack was lifecycle smoke-tested on both anvil and Monad (LP deposit →
  open LONG → price up → settle → withdraw; payout `148.5`, LP equity `951.5`). The
  deployed vault above is wired to the V0.9 oracle/tokens, so its canonical price is
  whatever the V0.9 bot last settled — the bot quotes **NVDA / GLM / SNDK / DEEPSEEK** vs
  HKD every round, so the NVDA price moves.
- The demo walkthrough for humans: `docs/product/DEMO_LP_VAULT.md`.

---

## 2. Contract reference — `IRMarketVault`

Source: `contracts/IRMarketVault.sol`; the hand-crafted ABI used by the app lives in
`web/src/lib/abis/vault.ts` (as-built; keep in sync with the artifact
`artifacts/contracts/IRMarketVault.sol/IRMarketVault.json`).

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
function balance() external view returns (uint256);        // cached settlementToken balance
function pendingPayout() external view returns (uint256);  // worst-case obligation over OPEN
function totalShares() external view returns (uint256);
function shares(address lp) external view returns (uint256);
function equity() external view returns (uint256);         // balance - pendingPayout
function positionCount() external view returns (uint256);
function positions(uint256 id) external view returns (Position memory);
```

⚠️ **Decoding:** in this viem version a single **struct** output decodes to a **named
object** (`res.owner`, `res.deposit`, …), not a positional array. Multi-output functions
(e.g. Monoracle `getLatestPrice`) decode to a positional array. (`useVaultPositions.ts`
and `useVaultSettled.ts` rely on the named-object behaviour.)

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

## 3. Accounting & math (client-side replication mirrors the contract exactly)

All amounts are **native token units**; prices are **WAD `1e18`** — never mix them
(spec §13). Fee and payout both round **down**. The replication lives in
`web/src/lib/vault.ts` (pure, unit-tested) — the UI must **reuse these helpers, not
reimplement** them.

```
fee        = deposit × feeBps / 10_000            // floor
N          = deposit − fee                         // notional at risk
maxPayout  = N × (10_000 + 10_000) / 10_000 = 2N   // worst case the vault reserves
units U    = N × 1e18 / entryPrice                 // base-native, informational

// settle, S0 = entryPrice, S = settle price (both WAD):
pnl        = LONG ? N×(S−S0)/S0 : N×(S0−S)/S0      // signed
pnl        = clamp(pnl, −N, +N)                    // cap = maxProfitBps
payout     = N + pnl                               // ∈ [0, 2N]
trader PnL = payout − deposit                      // max loss = premium

// LP shares (conservative equity):
equity     = balance − pendingPayout
deposit:   shares = totalShares == 0 ? amount : amount × totalShares / equity
           // reverts DepositAtZeroEquity when totalShares > 0 && equity == 0
withdraw:  amount = shares × equity / totalShares  // floor
```

**Worked example (unit-test fixture):** LP deposits `1000`; trader opens LONG with `D=100`
→ `fee=1`, `N=99`, `maxPayout=198`; at `S0=100` the LP equity **dips to `902`**
(`Δopen = 2·fee − D = −98`, spec §6.5); at `S1=150` payout `= 148.5`, LP equity `951.5`;
trader PnL at `S1` = `+48.5`.

### Things the UI must understand (and surfaces)
- **Conservative equity dips at open.** `equity` drops by ≈ the deposit at every open and
  recovers at settle. Share price is *not* mark-to-market — it only moves on
  deposit/withdraw/settle/fee. **Do not** show a live MTM LP PnL.
- **Deposit-side dilution (spec §6.5).** Because deposits are instant and shares mint at the
  *dipped* equity, a deposit while positions are open buys at a discount and harvests the
  recovery from incumbent LPs. Shown as a warning banner when `pendingPayout > 0`
  (LPPanel).
- **Withdraw is immediate** (no queue in the MVP). `withdraw` can only pay out of `equity`,
  so it never touches reserved capital; but it can revert `InsufficientShares`.
- **No early close.** A position can only be settled **after `expiryBlock`** — the Settle
  button is gated on `currentBlock >= expiryBlock`.
- **Settlement is optionality-prone (accepted MVP risk).** `settlePosition` marks at the
  price **at call time**, not at expiry, so a holder can settle late. The Positions card
  labels the estimate "estimated at current price" and the demo banner discloses this.

---

## 4. As-built UI surfaces (`/vault` page, `web/src/app/vault/page.tsx`)

Client page with `useHydrated()` gating, a `!hasVault` fallback card, a tab switcher
(LP / Trade / Positions) and these components:

### 4.1 `PriceHeader`
- `useVaultPrice()` reads the oracle via vault immutables (`oracle`,
  `priceBase`, `settlementToken` come from `useVaultMeta()` — never from env guesswork).
- Shows the canonical price (`formatPrice`) as `HKD/NVDA`. If `!exists || price === 0n` →
  "Price unavailable" + a note that trading/settle previews are disabled (the vault would
  revert `PriceUnavailable`). Polls on block changes (~15 s / 5 s fallback).

### 4.2 `DemoBanner`
Static disclosure of the 6 MVP limitations (manipulable raw price, no early close, no
refund, settlement optionality, deposit dilution, overflow stranding) linking to
`lp-pool-tech-spec.md` — handoff §9 requirement, spec §1.4.

### 4.3 `LPPanel`
- Stats grid: `equity`, `totalShares`, `share price` (equity/totalShares; `—` when supply
  0), `balance`, `pendingPayout`, wallet shares — all `formatAmount` (token amounts, not
  `formatPrice`).
- Deposit: amount input → **first time `Approve` then `Deposit`** (two txs);
  `useVaultAllowance` gates it. Withdraw: shares input with **Max** = `shares(wallet)`,
  "You receive" preview = `shares × equity / totalShares`.
- Dilution warning banner when `pendingPayout > 0n`.

### 4.4 `VaultTradePanel`
- LONG/SHORT toggle (`VaultSide.LONG/SHORT`), amount `D`, tenor numeric input + presets
  (`1 min ≈ 200`, `3 min ≈ 600`, `10 min ≈ 2000` @300 ms; MVP accepts any tenor).
- Client-side preview via `lib/vault.ts`: fee, N, maxPayout (2N), units, entry price,
  Max loss = premium, Max profit = N. Trading disabled when `!price.exists`.
- Approve→`openPosition(side, D, tenor)`; `Insolvent` surfaces as "Pool capacity
  insufficient for this size." (error mapping §8).

### 4.5 `VaultPositionsList` (+ `useVaultSettled`)
- Aggregate header: **Open PnL (estimated at current price)** (green/red).
- Per card: side chip, `#id`, status, deposit, notional, entry price (`formatPrice`),
  expiry countdown (`formatCountdown` @ ~600 blocks/3 min), status chip.
- OPEN: **Estimated payout** + **Estimated PnL** (`vaultPnlAt(p, price)`) at the current
  canonical price; **Settle** button gated on `currentBlock >= expiryBlock` — permissionless
  (proceeds always go to the owner).
- SETTLED: **Realized payout** + **Realized PnL** (`payout − deposit`) from `PositionSettled`
  logs (`useVaultSettled.ts`, chunked `eth_getLogs`, 100-block windows / ~5000-block
  lookback — Monad RPC cap). Older settles show a "outside the recent log window" note.
- Positions enumerated via `positionCount()` + `positions(i)` multicall-filtered by owner
  (no log scan needed at MVP scale).

---

## 5. Data layer & wired hooks (as-built)

| Hook | Purpose |
|---|---|
| `hooks/useVault.ts` | `useVaultMeta()` (oracle/priceBase/settlementToken/feeBps from the vault's immutables), `useVaultStats(account)` (equity/balance/pendingPayout/totalShares/shares + sharePrice), `useVaultPrice()` (`getLatestPrice`, `exists = flag && price > 0n`) |
| `hooks/useVaultPositions.ts` | `positionCount()` + `positions(i)` batch, owner-filtered → `VaultPosition[]` |
| `hooks/useVaultTrade.ts` | `useVaultTrade()` (approveQuote/deposit/withdraw/openPosition/settlePosition writes + phase/hash/error + react-query invalidation on success), `useVaultAllowance(owner, token)` |
| `hooks/useVaultSettled.ts` | `useVaultSettledPayouts()` — chunked `PositionSettled` log scan |
| `hooks/useCurrentBlock.ts` | block watcher (poll cadence for everything above) |

Reads use `useQuery` + `publicClient.readContract` (plain reads) or wagmi
`useReadContracts` batches; writes use a single `useWriteContract` + receipt watch.

### Data-layer gotchas (hard-won — do not regress)

1. **Multicall3 must exist on any chain the app reads.** `web/src/lib/wagmi.ts` points the
   chain config at canonical Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`
   (exists on Monad testnet). On a **fresh local anvil it does not exist** — every batched
   read (`useReadContracts`: token symbols/decimals, balances, markets) then fails with
   `???` symbols / "Price unavailable". The harness deploys it via
   `anvil_setCode` from `web/tests/helpers/multicall3-bytecode.txt` (see `tests/setup.ts`
   and `tests/video/deploy-stack.mjs`).
2. **Monoracle `quotes()` ABI field order.** The deployed struct is
   `provider, baseToken, quoteToken, baseAmount, quoteAmount, price, startSlot,
   expiryBlock(uint32), settledSlot(uint32), status` — `web/src/lib/abis/Monoracle.json`
   must match or `expiryBlock` receives `settledSlot` (0 while a quote is ACTIVE) and every
   active quote gets filtered out ("No quote available" / wrong expiry везде). Decoders in
   `useQuotes.ts` / `usePositions.ts` must follow the ABI.
3. **`useTokenMeta(addresses)` must never batch placeholder addresses** (`"0x"`) — an
   invalid-address batch errors the whole entry and symbols stick at `???` forever. Filter
   placeholders before batching (as-built in `useTokenMeta.ts`); callers on the vault page
   feed `meta.priceBase/settlementToken` only after `useVaultMeta()` resolves.
4. **wagmi auto-batches** plain `readContract` calls through Multicall3 (`batch` config
   default). Debug wire traffic with `web/tests/video/probe-app.mjs` +
   `web/tests/video/decode-mc3.mjs` (decodes `aggregate3` request/response).

---

## 6. Config & formatting conventions (repo-specific — do not deviate)

- **`NEXT_PUBLIC_*` must be referenced as literals** in `web/src/lib/config.ts`
  (`process.env.NEXT_PUBLIC_VAULT_ADDRESS`). Dynamic `process.env[key]` resolves to `""` in
  the browser (Next.js/Turbopack only inlines literals). As-built:
  ```ts
  export const VAULT_ADDRESS_RAW = process.env.NEXT_PUBLIC_VAULT_ADDRESS || "";
  export const VAULT_ADDRESS = VAULT_ADDRESS_RAW as `0x${string}`;
  export const hasVault = VAULT_ADDRESS_RAW !== "";
  ```
  `NEXT_PUBLIC_VAULT_ADDRESS` is set in `web/.env.local` / `web/.env.local.example` and in
  the Vercel project envs (Production scope).
- **Vercel:** project `irmarket` (h-fbf5). Adds happen from `web/`:
  `"<value>" | vercel env add <NAME> production` (`--type config` may be required for
  `*_TOKEN` names); then redeploy `--prod` so the value is inlined.
- **Formatting:** use `web/src/lib/format.ts` — `formatPrice` for WAD prices,
  `formatAmount` for token amounts, `formatPnl` for signed HKD PnL, `formatCountdown` for
  expiry, `parseAmount` for inputs. Never `toNumberString(price, 6)` directly.
- **Hydration:** use the `useHydrated` hook for wallet-dependent render to avoid wagmi
  hydration mismatches.
- **Function selectors:** compute with viem/ethers — never hand-write them.
- Follow the `web/AGENTS.md` rule: read `node_modules/next/dist/docs/` before writing
  Next.js code (this Next.js version differs from training data).

---

## 7. The price-publishing dependency (demo ops)

The vault only sees a price once a **Monoracle quote is settled**. The V0.9 bot quotes the
NVDA/HKD pair every round, so the canonical price moves continuously while the bot runs:

- UI must handle "no canonical price" (`exists == false` / `price == 0`) → disable trading
  (PriceHeader + TradePanel gating).
- A **vault settlement keeper is V1 scope** (spec §8.5/§15.2 P5): the bot publishes prices
  but does **not** call `vault.settlePosition`; humans settle via the Positions-tab button
  after expiry.
- Local demo price path: `submitQuote → mine past expiry → settleValidQuote` (see
  `web/tests/video/deploy-stack.mjs` and `test/IRMarketVault.e2e.test.js`).

---

## 8. Error → UI message mapping (as-built in `TxStatusCard.mapTransactionError`)

| Revert | User copy (in-app) |
|---|---|
| `PriceUnavailable` | "Waiting for a trustworthy price — try again shortly." |
| `Insolvent` | "Pool capacity insufficient for this size." |
| `DepositAtZeroEquity` | "The pool is fully reserved; deposits are paused until positions settle." |
| `InsufficientShares` | "You don't have that many shares." |
| `NotExpired` | "This position hasn't expired yet." |
| `NotOpen` | "Already settled." |
| `ZeroAmount` | "Enter an amount greater than zero." |
| `ZeroTenor` | "Enter a tenor greater than zero." |
| `InvalidConfig` | constructor only — n/a |

---

## 9. MVP limitations disclosed in the UI (DemoBanner + spec §1.4)

1. **Manipulable price** — settlement uses the raw canonical Monoracle price; V1's
   `PriceAdapter` (bond floor / freshness / circuit breaker) fixes this.
2. **No early close** — only settle after expiry.
3. **No refund** — a position with no valid price at/after expiry is stuck until one appears.
4. **Settlement optionality** — marks at the price at call time (American-option-like).
5. **Deposit dilution** — see §3.
6. **Overflow can strand a position** — pathological price/amount; bounded grief.

---

## 10. As-built file layout

```
web/src/app/vault/page.tsx                 # page: !hasVault fallback, tabs LP/Trade/Positions
web/src/components/vault/PriceHeader.tsx   # canonical price header
web/src/components/vault/DemoBanner.tsx    # MVP limitation disclosure
web/src/components/vault/LPPanel.tsx       # stats + deposit/withdraw + dilution banner
web/src/components/vault/VaultTradePanel.tsx  # side/amount/tenor + preview + open
web/src/components/vault/VaultPositionsList.tsx  # aggregate Open PnL + cards + settle
web/src/components/common/TxStatusCard.tsx # + vault revert→copy mapping (§8)
web/src/hooks/useVault.ts                  # meta / stats / price
web/src/hooks/useVaultPositions.ts         # positionCount + positions(i) owner filter
web/src/hooks/useVaultTrade.ts             # writes (approve/deposit/withdraw/open/settle) + allowance
web/src/hooks/useVaultSettled.ts           # PositionSettled log scan (realized payout)
web/src/lib/abis/vault.ts                  # hand-built IRMarketVault ABI (mirror the artifact)
web/src/lib/vault.ts                       # pure math: fee/notional/maxPayout/units/payoutAt/pnlAt/sharePrice/shares
web/src/lib/vault.test.ts                  # unit fixture tests (node --test; 7 suites)
web/src/lib/config.ts                      # VAULT_ADDRESS / hasVault (literal env)
web/src/lib/format.ts                      # formatPrice/formatAmount/formatPnl/formatCountdown/parseAmount
web/tests/e2e/13-vault.spec.ts             # Playwright: page renders, trade gate, LP deposit
web/tests/video/user-flow.spec.ts          # Playwright user-flow walkthrough (video)
web/tests/video/deploy-stack.mjs           # standalone local deploy (anvil + Multicall3 setCode + .env.local)
web/tests/video/probe-app.mjs              # browser-side RPC probe (debugging wire traffic)
web/tests/video/decode-mc3.mjs             # aggregate3 request/response decoder
web/tests/helpers/multicall3-bytecode.txt  # canonical Multicall3 bytecode (deployed by the harness)
web/tests/setup.ts                         # E2E globalSetup (deploys V0.9 stack + vault + price, sets Multicall3)
web/tests/video-setup.ts                   # video globalSetup (deploy first, THEN next dev — env freshness)
web/playwright.video.config.mts            # self-contained video run (deploy+serve in one process)
web/playwright.video.local.config.mts      # video run against an already-running dev server
web/playwright.setup.config.mts            # setup-only run (no webServer)
```

---

## 11. Testing & verification commands (exact, from `web/`)

| What | Command | Expected |
|---|---|---|
| Vault math unit | `npm run test:unit` | 17 passing (7 vault + 10 format) |
| Full web E2E (local stack, in order) | `npx playwright test` | 20/20 — setup deploys V0.9+vault+price, sets Multicall3, writes `.env.local` |
| User-flow video (one-shot, self-contained) | `npx playwright test --config playwright.video.config.mts` | walkthrough passes, video in `test-results/*/video.webm` |
| Video against a running dev server | deploy via `npx playwright test --config playwright.setup.config.mts`, start `npx next dev --port 3000`, then `npx playwright test --config playwright.video.local.config.mts` | walkthrough passes (fresh `.env.local` first, dev server second — **do not reverse** or the browser gets a stale vault address) |
| Stack repro script (video-local path) | `node tests/video/deploy-stack.mjs` | writes `web/.env.local` + `tests/helpers/addresses.json` |
| Contract unit/E2E | `npx hardhat test test/IRMarketVault.test.js` / `npx hardhat test test/IRMarketVault.e2e.test.js` | 22 / suite green |

Gotchas baked into the harness: `tests/setup.ts` kills leftover `anvil.exe`; on Windows the
harness prefers `$HOME/.foundry/bin/anvil.exe` (WSL fallback when absent); WSL must be shut
down (`wsl --shutdown`) or the `dllhost` relay holds `127.0.0.1:8545`.

---

## 12. Out of scope (do not build for the MVP)

Early close, refund/deferral, admission-cap UI (utilization/skew/position), factory /
multi-vault picker, ERC20 share token transfer UI, withdrawal queue, protocol fee/treasury,
meta-pool, settlement keeper. V1 scope (spec §1.1, §15.2 P3–P5).

---

## 13. Reference

- Contract: `contracts/IRMarketVault.sol` · Tests: `test/IRMarketVault.test.js` (unit),
  `test/IRMarketVault.e2e.test.js` (E2E) · Deploy: `script/deploy-vault-rpc.js`
- Spec: `docs/design/lp-pool-tech-spec.md` (§1.4 MVP cut incl. accepted risks, §15.1 close-out)
- Product requirements: `docs/prd.md` §十一 (LP Vault) · Demo: `docs/product/DEMO_LP_VAULT.md`
- Video: `docs/product/videos/lp-vault-user-flow.webm`
- Deployed addresses: `deployment-vault.json` (gitignored) / §1 above
