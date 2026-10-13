# IRMarket — LP Pool MVP Implementation Plan

> **Status:** Draft for review. Companion to `docs/design/lp-pool-tech-spec.md` (the full
> V1 design). The **MVP cut** this plan implements is defined there in **§1.4**; the roadmap
> is **§15.1** (M0–M4). Scope: prove that *a pool is the counterparty and positions settle at
> Monoracle's canonical price* — nothing more.
>
> **Review ask:** read this plan **and** spec §1.4 / §4.2 / §6 / §9, then challenge the scope
> cut, the payoff math, the solvency invariant, and the accepted risks (§6 below).

---

## 1. Goal

A single LP vault whose traders open capped-linear LONG/SHORT positions and whose PnL
is settled on-chain against `IMonoracle.getLatestPrice(base, quote)`. Deliverable is a
working contract plus tests (and a small demo script), not a production pool.

**Definition of done (MVP):** `npx hardhat test test/IRMarketVault.test.js` is green; a demo
script can LP-deposit, open a position at price `S0`, move the canonical price to `S1`, and
settle the position for the payoff in spec §4.2.

---

## 2. Scope

### 2.1 In scope (MVP)

| Area | What ships |
|---|---|
| Vault | ONE vault, constructor-configured `(oracle, priceBase, settlementToken, feeBps)`. No factory. |
| LP capital | `deposit(amount) -> shares`, `withdraw(shares) -> amount`, internal share accounting, conservative equity `balance − pendingPayout` (spec §6.2). |
| Product | Capped linear LONG/SHORT, payoff spec §4.2, `maxProfitBps = 10_000` → `payout ∈ [0, 2N]`. |
| Settlement | `settlePosition(id)` after `expiryBlock`, reads `IMonoracle.getLatestPrice`, pays the owner, releases `pendingPayout`. |
| Solvency | Per-open invariant `pendingPayout + maxPayout_new ≤ balance`; else revert `Insolvent`. |
| Tests | Payoff matrix (flat / cap / short), fee accrual, pre-expiry revert, insolvency revert, no-price revert, withdraw. |

### 2.2 Out of scope (deferred to V1 — spec §1.4 table)

Price adapter (bond floor / freshness / banned provider / circuit breaker), early close,
deferral→refund, admission caps (utilization / skew / position), risk-param timelock,
factory, ERC20 share token, two-step withdrawal queue, veto bot, keeper, indexer, UI.

---

## 3. What already exists

| File | Status |
|---|---|
| `contracts/IRMarketVault.sol` | Implemented (M0–M2) |
| `test/IRMarketVault.test.js` | Implemented, 8 tests passing (M3) |
| `contracts/test/MonoracleMock.sol` | Reused as the oracle for tests (already in repo) |

### 3.1 Actual contract API

```solidity
contract IRMarketVault is ReentrancyGuard {
    enum Side   { LONG, SHORT }
    enum Status { OPEN, SETTLED }

    struct Position {
        address owner; Side side;
        uint256 deposit; uint256 fee; uint256 notional;
        uint256 entryPrice;   // WAD 1e18
        uint256 maxPayout;    // <= 2 * notional
        uint64  expiryBlock; Status status;
    }

    // immutables: oracle, priceBase, settlementToken, feeBps
    // constants : MAX_FEE_BPS = 10_000, MAX_PROFIT_BPS = 10_000
    // state     : balance, pendingPayout, totalShares, shares[address], _positions[]

    function deposit(uint256 amount) external returns (uint256 sharesMinted);
    function withdraw(uint256 shareAmount) external returns (uint256 amount);
    function openPosition(Side side, uint256 depositAmount, uint64 tenorBlocks) external returns (uint256 positionId);
    function settlePosition(uint256 positionId) external returns (uint256 payout);

    function equity() external view returns (uint256);
    function positionCount() external view returns (uint256);
    function positions(uint256 positionId) external view returns (Position memory);
}
```

Events: `Deposited`, `Withdrawn`, `PositionOpened`, `PositionSettled`.
Errors: `InvalidConfig`, `ZeroAmount`, `ZeroTenor`, `PriceUnavailable`, `Insolvent`,
`InsufficientShares`, `NotOpen`, `NotExpired`.

### 3.2 Math (matches spec §4.2 and §6)

```
fee        = D * feeBps / 10_000                 // floor, retained by the pool at open
N          = D − fee                             // notional at risk
maxPayout  = N * (10_000 + 10_000) / 10_000 = 2N // worst case the vault reserves

// open:
entryPrice = Monoracle.getLatestPrice(base, quote)      // WAD, must exist
require pendingPayout + maxPayout <= balance            // else Insolvent

// settle (block.number >= expiryBlock):
S0 = entryPrice; S = getLatestPrice(base, quote)        // WAD, must exist
pnl    = LONG ? N*(S−S0)/S0 : N*(S0−S)/S0              // signed, native quote units
pnl    = clamp(pnl, −N, +N)                             // cap == maxProfitBps == 10_000
payout = N + pnl                                        // ∈ [0, 2N]

// LP shares (conservative equity):
equity     = balance − pendingPayout
shares_out = totalShares == 0 ? amount : amount * totalShares / equity
             // reverts DepositAtZeroEquity when totalShares > 0 && equity == 0 (spec §6.3)
amount_out = shares_in * equity / totalShares

// equity behaviour (spec §6.5): dips at open, recovers at settle
Δequity(open)        = D − 2N = 2·fee − D ≈ −D      // worst-case reservation
Δequity(open→settle) = fee − pnl                    // recovers to realized P&L
```

All amounts are native token units; the price is WAD `1e18` and is never mixed with token
decimals (spec §13.1). Fee rounds down; payout rounds down (spec §5).

---

## 4. Task breakdown

| Task | Deliverable | Acceptance |
|---|---|---|
| **M0–M3** ✅ | Vault + tests | `npx hardhat test test/IRMarketVault.test.js` → 21 passing |
| **M4.1** ✅ | `script/deploy-vault.js` — deploy tokens (or reuse env), oracle, vault; wire approvals | running locally connects and reads `vault.equity()` |
| **M4.2** ✅ | `script/vault-demo.js` — scripted walkthrough: LP deposit → publish+settle quote at `S0` → open LONG → publish+settle quote at `S1` → settle → log trader PnL + LP equity delta | exits 0; logs match the §3.2 formulas |
| **M5 (hardening + E2E)** ✅ | The §5.2 tests + the contract-level E2E suite | `npx hardhat test` 54 passing; `npm run test:e2e` 9 passing |

**M4 detail — the price step.** The vault only sees the canonical price once a Monoracle
quote *settles*. The demo must therefore: `submitQuote(base, quote, baseAmount, quoteAmount,
expiryBlock)` → mine past the window → `settleValidQuote(id)` to publish `S0`, then repeat to
publish `S1` before `settlePosition`. On testnet this is a bot/keeper action; for the MVP the
script does it inline. This operational coupling is expected and matches spec §8 (Monoracle =
price only).

**M4 dependency.** The *testnet* variant of M4 is blocked on the spec §8.5.1 P0 decision
(which oracle deployment, which veto-bot posture) and on a funded quote provider with
bilateral collateral; the local-Hardhat variant (MonoracleMock) has neither dependency.

---

## 5. Test plan

### 5.1 Existing (M3, passing)

1. LP deposit mints pro-rata shares; equity tracks balance.
2. LONG, price doubles → payout capped at `2N`; trader PnL `= 2N − D = D − 2·fee` (here `+98`
   for `D = 100`, fee 1%); LP equity delta `= 2·fee − D` (here `−98`).
3. Flat price → payout `N`; trader loses exactly the fee; LP gains the fee.
4. SHORT, price halves → payout `N + N*(S0−S)/S0`.
5. Cannot settle before `expiryBlock` → `NotExpired`.
6. Open with no LP capital (or oversized) → `Insolvent`.
7. Open with no canonical price → `PriceUnavailable`.
8. LP withdraw against conservative equity; balances return to start.

### 5.2 To add (M5)

- Payoff boundaries: `S = 2·S0` → `2N`; `S = 5·S0` → still `2N` (cap); `S → 0` → `0` for LONG,
  `2N` for SHORT; exactly at cap.
- Second LP deposit after equity changed → share math.
- Deposit-dilution window (spec §6.5): deposit while a position is open buys at the dipped
  equity; assert the incumbent→newcomer transfer documented in §6.5 (accepted risk 8).
- Partial withdraw; while positions are open, `amount = shares × equity / supply` never
  exceeds `balance − pendingPayout` (assertion — vacuous by construction, spec §6.4).
- Permissionless settle: a third party calls `settlePosition`, owner receives payout.
- Double-settle → `NotOpen`.
- Fee routing: pre-open → post-settle, `equity delta == fee − pnl` (trader's signed profit)
  per scenario (spec §6.5).
- Invariant (fuzz-lite): after every random `deposit/open/settle/withdraw`, assert
  `balance >= pendingPayout` and `pendingPayout == Σ open position.maxPayout`.
- Overflow guard: extreme prices/amounts (e.g. 1-wei `entryPrice` with a huge `settlePrice`)
  revert via Solidity 0.8 checked math in `_payout` instead of mispaying (the MVP has no
  `maxDeposit`/`maxTenorBlocks` — bounds are the `Insolvent` check and token balances, spec §1.4).

### 5.3 Commands

```bash
npx hardhat test test/IRMarketVault.test.js   # MVP unit / hardening suite
npx hardhat test                              # full suite (must stay green)
npm run test:e2e                              # E2E suite: test/IRMarketVault.e2e.test.js
```

---

## 6. Accepted risks / known gaps (do not hide — spec §1.4)

1. **Manipulable price.** The MVP reads the raw canonical price via `getLatestPrice`; spec
   §8.1 shows it can be pushed by a tiny quote. The MVP is a mechanics demo only. The V1
   PriceAdapter (bond floor `≈ 0.7 × equity` per spec §8.4 case b, freshness, circuit breaker)
   is what makes settlement safe.
2. **No deferral/refund.** If no valid price exists at expiry, `settlePosition` reverts
   `PriceUnavailable` and the position is **stuck** until a price appears (no refund path).
   V1 adds `AWAITING_PRICE` → `refundPosition` (spec §9.4).
3. **No admission caps beyond solvency.** One position can consume all free capital; it still
   cannot make the vault insolvent (the invariant holds), but it can freeze LP withdrawals.
   V1 adds utilization / skew / position caps (spec §7).
4. **Instant withdraw, no queue / share token.** Shares are internal and non-transferable; an
   LP can withdraw in the same block as a deposit. Conservative equity (`balance −
   pendingPayout`) means a withdraw never touches reserved capital, so this is safe, but it
   is not the two-step queue of spec §6.4.
5. **No first-depositor inflation mitigation** (no seed burn — spec LP-D5).
6. **`pendingPayout` double-counts both sides** (it sums every open `maxPayout`, long and
   short). This is intentionally conservative (spec §6.2) at the cost of capital efficiency.
7. **Block-based tenor.** `expiryBlock = openBlock + tenorBlocks`; there is no wall-clock or
   Monoracle-expiry alignment. Fine for Monad (~300 ms blocks), must be re-derived per chain
   (spec §11).
8. **Deposit-side dilution (spec §6.5).** Conservative equity dips by `2N − D` at every
   open and recovers at settle; since deposit is instant and permissionless, anyone can buy
   shares in the dipped window and harvest the recovery at incumbent LPs' expense (the
   newcomer's worst case is roughly break-even). Accepted for the demo; a mitigation
   (marked equity / epoch accounting / deposit delay) must be chosen before V1 (LP-D14).
   Tested explicitly in M5 so the behaviour is at least visible.
9. **Settlement-timing optionality (American option).** `settlePosition` marks at the
   canonical price at *call* time, not at expiry, so a holder can settle late when the price
   is favourable — mispriced against the pool for a flat fee and a capped upside. This is
   **not** the same as risk 1: the V1 adapter bounds staleness, not optionality. Accepted for
   the MVP; V1 must pin settlement to the expiry window (spec §9.3). Note `latestValidQuoteId`
   exposes only the *latest* quote, so a true "first quote at/after expiry" rule needs an
   oracle-side change.
10. **Overflow-panic strands a position.** A pathological price/amount reverts `_payout`
    with Panic `0x11` (checked math); the position can never settle, so its `maxPayout` stays
    locked and LP equity is reduced forever. Griefing cost is ~1:1 with the trader's own
    premium (they forfeit it too), so it is a bounded grief, not a solvency break; V1
    `maxDeposit`/`maxTenorBlocks` bound it. (M5 has the overflow test.)
11. **Direct quote-token donations are stranded.** Tokens sent straight to the vault are not
    counted in the cached `balance` and there is no sweep, so they are unrecoverable and
    break the `token.balanceOf == balance` lockstep the tests assert. NatSpec-noted in the
    contract.

**Boundary note.** The spec §4.2 `S = 0` row is the continuous limit, not reachable: a canonical
`settlePrice == 0` reverts `PriceUnavailable`, and flooring keeps `payout` strictly inside
`[0, 2N]`. The M5 tests assert the closest reachable point (`S = 1 wei`) and the zero-price
rejection.

---

## 7. Open questions for the reviewer

1. **Scope:** is "no early close, no refund" acceptable for the MVP, or must one of them be in
   the first cut? (spec LP-D3 promises "open and close" to the grant.)
2. **Share accounting:** internal `shares` mapping vs an ERC20 `VaultShare` — does the MVP need
   transferability to demo LP economics?
3. **Settlement price source:** for the demo, use the in-repo `MonoracleMock` (deterministic,
   no bot) or the deployed testnet oracle (`0x2b5a…`) driven by the real bot?
4. **`pendingPayout` gross vs net:** keep the conservative gross sum, or track net
   long/short to improve capital efficiency in the MVP?
5. **Solvency rule:** `pendingPayout + maxPayout ≤ balance` is a hard "pool must fully
   collateralise worst case" rule. Should the MVP instead allow a utilization fraction
   (e.g. ≤ 50%) so it demonstrates the V1 admission-control shape?
6. **Where should the demo live:** a Hardhat script under `script/`, or a `test/` case that
   doubles as executable documentation?
7. **Do we wire anything into `web/` now**, or keep the MVP contract-only until V1?
8. **Deposit-dilution mitigation (spec §6.5, LP-D14):** marked equity, epoch accounting,
   deposit delay, or keep accepting? This is the one *economic* decision that must precede V1.

---

## 8. References

- Full design: `docs/design/lp-pool-tech-spec.md` (§1.4 MVP cut, §4.2 payoff, §6 accounting,
  §9 lifecycle, §15 roadmap).
- Oracle interface: `contracts/IMonoracle.sol`, test double `contracts/test/MonoracleMock.sol`.
- Existing V0.9 path (do not break): `contracts/IRMarket.sol`, `docs/sc-tech-spec.md`.
