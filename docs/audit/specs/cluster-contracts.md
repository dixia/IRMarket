# Cluster C — Contracts

**Area:** `contracts/`, `test/`
**Owner:** Solidity / Monoracle integration

## Goal
Bring the IRMarket smart contract layer to production quality: fix bugs, add tests, gas-optimize, and keep `IMonoracle.sol` in sync with upstream.

## Scope
- `contracts/IRMarket.sol` — wrapper logic, fees, openLong/openShort
- `contracts/IMonoracle.sol` — interface completeness
- `test/` — Hardhat unit tests, fork tests
- `script/` — deploy / demo scripts

## Tasks
1. Review open issues tagged `contracts` and implement fixes.
2. Add Hardhat tests for any uncovered branches (veto flows, collateral math).
3. Run `npx hardhat test` and fix failures.
4. Update `docs/sc-tech-spec.md` if behavior changes.

## STOP condition
- Tests fail after your changes and you cannot fix them within 3 attempts.
- Upstream `IMonoracle.sol` ABI changed and you are unsure which function to add.

## Commit
```
fix(contracts): <describe the fix or test added>
```
