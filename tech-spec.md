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