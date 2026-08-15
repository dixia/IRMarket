# IRMarket — Technical Specification (Monad)

> **Status:** Draft — filled in alongside the product requirement analysis.

## 1. Contract Overview

| Field | Value |
|---|---|
| **Contract name** | (TODO) |
| **File** | `contracts/` |
| **License** | MIT |
| **Solidity version** | `^0.8.20` |
| **Dependencies** | OpenZeppelin Contracts v5.x |
| **Target chain** | Monad (chain ID 143 mainnet / 10143 testnet) |

---

## 2. Types & Constants

(TODO)

---

## 3. State Variables

(TODO)

---

## 4. Events

(TODO — all events use indexed params for Monad Streaming RPC)

---

## 5. Function Specifications

(TODO — one subsection per entry-point: params, requirements, execution, gas estimates)

---

## 6. Modifiers

(TODO)

---

## 7. Internal Helpers

(TODO)

---

## 8. Error Messages

(TODO)

---

## 9. Integration Guide

### 9.1 For Option Writers

(TODO)

### 9.2 For Verifiers / Arbitrageurs

(TODO)

### 9.3 For Derivative Consumers

(TODO)

---

## 10. Monad-Specific Considerations

### 10.1 Gas Model

(TODO — Monad charges by gas limit, not gas used)

### 10.2 No Public Mempool

(TODO)

### 10.3 Reserve Balance

All EOAs must maintain at least **10 MON** reserve balance.

### 10.4 Parallel Execution

(TODO)

### 10.5 Streaming RPC

(TODO)

---

## 11. Testing Strategy

(TODO — unit, integration, edge cases)

---

## 12. Deployment

(TODO — deploy scripts, verification on Sourcify/BlockVision)

---

## 13. Reference: Monoracle Primitive (upstream)

- **Source:** NOT vendored — referenced from the upstream Monoracle project
  `github.com/dixia/monoracle` (`contracts/Monoracle.sol`). IRMarket keeps only the ABI at
  `abi/Monoracle.abi.json` (refresh from `monoracle/artifacts/.../Monoracle.json` when upstream changes).
- **Interface:** `abi/Monoracle.abi.json` — `submitQuote`, `settleValidQuote`,
  `vetoOverpriced`, `vetoUnderpriced`, `withdrawProviderFunds`, `getLatestPrice`, events.
- **Live testnet deployment (settlement oracle):** Monad testnet (10143)
  `0x1ABABc60Ca6950C94eA80F2f611AB06aAAAD28c0`
- **Reference repo:** `github.com/dixia/monoracle` — the Monoracle tech-spec is the reference
  for the veto-arbitrage settlement primitive used by IRMarket.

### 13.1 Timing & Finality (settlement basis)

- Monad: **1 block = 300ms**; **full finality = 2 slots ≈ 600ms**.
- Monoracle `VERIFICATION_SLOTS = 2` — a quote is `ACTIVE` from `startSlot` to `startSlot + 2`,
  then `settleValidQuote` (permissionless) makes it canonical.
- ⇒ A bot's final settlement quote becomes the canonical price **~600ms** after submission.

### 13.2 Settlement by fresh final quote (confirmed, D-06)

1. Quote bot (provider) submits the end-price as a new quote at expiry.
2. Quote survives the 2-slot window (no veto; bot can settle its own quote).
3. `getLatestPrice(base, quote)` now returns the fresh price (it always returns the latest
   settled valid quote, so the stale price is replaced).
4. IRMarket reads `getLatestPrice` inside its settlement tx and settles option PNL (D-02/D-04).

### 13.3 Configurable quoting cadence (D-05)

- Bot quoting interval is a **configurable parameter** (`bot/.env`): `QUOTE_INTERVAL_SECONDS`
  (or `QUOTE_INTERVAL_BLOCKS`). Tuned so a full demo cycle (establish quote → open position →
  early close / expiry settlement → PNL) fits within the demo 3-min window.
- Gas note: Monad charges by **gas limit**, not gas used — keep `GAS_LIMIT` fixed and skip
  `estimateGas` in the quoting loop.