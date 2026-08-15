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

(TODO)

### 3.4 Payouts & Withdrawal

(TODO)

### 3.5 Read Interface

(TODO)

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

(TODO — valid price flow, veto flow, settlement flows)

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
- **Monoracle testnet contract (10143):** `0x1ABABc60Ca6950C94eA80F2f611AB06aAAAD28c0`
- Monoracle source is vendored at `contracts/Monoracle.sol` and **kept in sync** with the
  reference repo (`github.com/dixia/monoracle`).