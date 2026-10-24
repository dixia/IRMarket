# Software Requirements Document: IRMarket

> **Status:** Draft — full product requirement analysis is pending (`product/` and `plan/roadmap.md`).
> This mirrors the structure of the Monoracle requirements doc, to be filled in with the
> IRMarket option-market specification.

## 1. Project Overview & Scope

(TODO)

### Mechanism Summary

(TODO — how IRMarket uses the Monoracle veto-arbitrage primitive for settlement)

### Scope

- (TODO)

### Deployment Target

- Primary runtime: Monad EVM environment (Chain ID: 143 mainnet / 10143 testnet)

### Target Users

(TODO)

### Why Monad

(TODO — async/parallel execution, 300ms block time, low gas, no global mempool)

---

## 2. Stakeholders & On-Chain Roles

(TODO)

---

## 3. Functional Requirements

### 3.1 Option Market Lifecycle

(TODO — one-line references per FR below)

### 3.2 Collateral & Escrow

(TODO)

### 3.3 Settlement via Monoracle Primitive

- **Settlement price = a fresh Monoracle quote that the bot submits around expiry** (confirmed, D-06):
  1. Around expiry, the quote bot (provider) calls `submitQuote(base, quote, baseAmount, quoteAmount)` at the tracked fair price.
  2. The quote is `ACTIVE` for `VERIFICATION_SLOTS = 2` blocks (~600ms on Monad's 300ms block time).
  3. Once the window passes (`block.number > expiryBlock`) the quote is **canonical automatically** (lazy settlement) — `getLatestPrice` computes the canonical price at read time, no settle tx required.
  4. `settleValidQuote` (permissionless) is now an **optional checkpoint**: it still writes `latestValidQuoteId[pair]` and emits `QuoteSettledValid`, but it no longer gates the canonical price and — being late — can no longer rewind it. The bot still fires it to keep that event stream continuous and refresh the fallback floor.
  5. IRMarket reads `getLatestPrice(base, quote)` inside its settlement tx and computes option PNL.
- **Why it works:** Monoracle's `getLatestPrice` returns the canonical price — the newest matured valid quote for the pair (per-pair list walk, cap 8, with the `settleValidQuote` pointer as a floor) — so a fresh settlement quote *replaces* any stale price for the pair as soon as its window passes.
- **Feasibility (confirmed against contract source):** all steps are existing Monoracle entry-points; the 2-slot window aligns with Monad 2-slot full finality (~600ms). No Monoracle changes required.
- **Robustness caveat:** `getLatestPrice` returns the pair's canonical (newest matured valid) quote, without quoteId selection. For the demo, the bot is the sole provider, so the final quote is deterministic; if arbitrary third parties may also quote in future, IRMarket may need to pin a quoteId or freeze the snapshot window (out of demo scope).

### 3.4 Payouts & Withdrawal

- Option PNL per decision D-02 (linear price difference, capped at principal, no margin calls).
- On settlement: winning positions paid from the market's launch liquidity + provider collateral pool (D-03); losing positions forfeit locked principal to the pool. Provider/MM fees (1% spread) credited to the MM account at open/close.

### 3.5 Read Interface

- Live reference price & settlement price: `Monoracle.getLatestPrice(base, quote)` → `(price, settledSlot, exists)`.
- If `exists == false` (no settled quote yet): frontend disables open/settle and prompts "wait for bot to establish a quote" (D-05).

---

## 4. Non-Functional Requirements

### 4.1 Monad-Specific Performance

(TODO)

### 4.2 Security

(TODO)

### 4.3 Compatibility

(TODO)

---

## 5. Process / Data Flow Rules

### Mainnet/Testnet price & settlement flow (confirmed)

1. **Continuous quoting (D-05):** quote bot (provider) loop:
   - Fetch fair price → `submitQuote` (bilateral collateral: base + quote ERC20), loop interval configurable (`QUOTE_INTERVAL_SECONDS` / `QUOTE_INTERVAL_BLOCKS`); tuned so a full demo cycle fits inside the 3-min window.
   - Each quote: 2-slot ACTIVE window → becomes canonical automatically once `block.number > expiryBlock` (lazy settlement); the bot optionally checkpoints it with `settleValidQuote` → withdraws prior round's funds to recycle collateral.
2. **Veto flow:** within a quote's 2-slot window, anyone with a better price reference may `vetoUnderpriced`/`vetoOverpriced`; vetoed quotes never become canonical.
3. **Option lifecycle:** user opens (locks HKD, snapshots `getLatestPrice` as entry reference) → may early-close against the provider pool (D-03) → at expiry bot fires a **final settlement quote** which becomes the canonical price once its window passes (the bot's `settleValidQuote` is only an optional checkpoint) → IRMarket reads `getLatestPrice` and auto-settles positions (D-04), UI shows PNL to claim.

---

## 6. System Architecture

### 6.1 Contract Modules

| Module | File | Responsibility |
|---|---|---|
| (TODO) | `contracts/` | |

### 6.2 Storage Layout

(TODO)

### 6.3 External Dependencies

(TODO)

---

## 7. Assumptions, Constraints & Risks

### 7.1 Assumptions

(TODO)

### 7.2 Constraints

(TODO)

### 7.3 Risks

(TODO)

---

## 8. Monad Technical Reference

| Parameter | Value | Source |
|---|---|---|
| Block time | 300ms | v0.15.0 (MIP-12) |
| Speculative finality | 300ms (1 slot) | MonadBFT |
| Full finality | 600ms (2 slots) | MonadBFT |
| Per-transaction gas limit | 30M gas | Network params |
| Block gas limit | 200M gas | Network params |
| Gas charging model | Charged by gas limit | Monad-specific |
| Reserve balance | 10 MON per EOA | MONAD_FOUR+ |
| Chain ID (mainnet) | 143 | Mainnet |
| Chain ID (testnet) | 10143 | Testnet |

---

## 9. Deferred Features (Future)

(TODO)

---

## 10. Monoracle Integration Notes

- Settlement relies on the existing Monoracle veto-arbitrage primitive for any priced asset.
- **Monoracle testnet contract (10143):** lazy/implicit deployment `0x0BC36e1ac475AdEF75F102deb1708BE6E45aA16f` (a quote is canonical once `block.number > expiryBlock`; `settleValidQuote` is an optional checkpoint). Production (`irmarket.xyz`) is cut over to it (2026-10-24): wrapper `0x05475037AE4e0717083737eDAc38590850968E7c`, vault `0x3d52a82a8a79b4Aecc90F37e506a441e0eF908AB`. The pre-lazy stack (`0x3B08bd1C…` / `0x95a74C58…` / `0x80732110…`) and the older `0x151286e6Ca5F5CA20910dE90C0DCEAa9fd71f2c8` / `0x1ABABc60Ca6950C94eA80F2f611AB06aAAAD28c0` deployments stay live and untouched for rollback.
- Monoracle contract source is **not vendored** — referenced from the upstream repo
  (`github.com/dixia/monoracle`, `contracts/Monoracle.sol`). Only the ABI is copied here
  (`abi/Monoracle.abi.json`).
- **Settlement design (D-06, confirmed feasible):** expiry settlement = bot submits a fresh
  quote at the fair price; once the quote's window passes (`block.number > expiryBlock`) it is
  the canonical price with no settle tx (lazy settlement) — `settleValidQuote` is only an
  optional checkpoint — and IRMarket reads `getLatestPrice` for PNL.
- **Quote cadence:** bot quoting loop interval is a **configurable parameter** (`bot/.env`),
  tuned so a full demo cycle completes within the 3-min option window (D-05).