# Cluster A — Audit

**Area:** `contracts/`, `bot/`, `web/` (cross-cutting)
**Owner:** Security / gas / code review

## Goal
Find and fix security, gas, and reliability issues across the IRMarket stack.

## Scope
- Solidity security (reentrancy, overflow, access control)
- Gas optimization (storage layout, loop costs)
- Bot reliability (exception handling, nonce management, RPC resilience)
- Frontend security (input validation, secret handling)

## Tasks
1. Review recent contract changes for common Solidity issues.
2. Profile gas usage of `openLong`, `openShort`, `vetoUnderpriced`, `vetoOverpriced`.
3. Check bot for robust error handling (web3 exceptions, nonce races, timeouts).
4. Verify frontend does not leak secrets or mishandle user input.

## STOP condition
- Finding requires architecture change — document in an issue instead of fixing directly.

## Commit
```
audit: <describe the finding and fix>
```
