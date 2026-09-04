# Cluster W — Web

**Area:** `web/`
**Owner:** Next.js frontend dapp

## Goal
Maintain a working, user-friendly IRMarket web dapp on Monad testnet.

## Scope
- `web/src/` — pages, hooks, components, lib
- `web/src/hooks/useTrade.ts`, `usePositions.ts`, etc.
- `web/src/lib/format.ts`
- Wagmi / RainbowKit config
- `web/tests/e2e/` — Playwright demo flows

## Tasks
1. Review open web issues (UI bugs, hook regressions, formatting).
2. Fix layout / interaction / data-fetching issues.
3. Keep `NEXT_PUBLIC_*` env vars in sync with deployment.
4. Run `npx next lint` and fix warnings.

## STOP condition
- Issue requires contract ABI changes (escalate to Cluster C).
- Wagmi / RainbowKit upgrade breaks the build and rollback is unclear.

## Commit
```
fix(web): <describe the fix or improvement>
```
