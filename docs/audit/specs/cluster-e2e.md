# Cluster E — E2E

**Area:** `web/tests/e2e/`
**Owner:** Playwright / demo flows

## Goal
Keep the IRMarket end-to-end demo flow stable and reliable.

## Scope
- `web/tests/e2e/11-demo-trade.spec.ts` — PATH 1 / PATH 2 wallet flows
- Playwright config (`playwright.config.ts`)
- `web/src/hooks/` only when the fix is a hook/e2e interaction issue

## Tasks
1. Run `npx playwright test` and classify failures (locator / timing / logic).
2. Fix flaky waits, locator strict-mode violations, and race conditions.
3. Keep 11.1–11.4 passing consistently (~10–15s total on local Anvil).
4. Do NOT change contract logic here — coordinate with Cluster C if needed.

## STOP condition
- Failure requires contract ABI or Monoracle interface change (escalate to Cluster C).
- Playwright itself is broken and needs a version rollback.

## Commit
```
fix(e2e): <describe the fix or improvement>
```
