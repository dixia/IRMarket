# Monoracle Upstream Migration — Handoff

> **Read this first.** Companion to `docs/plan/monoracle-upstream-migration-plan.md` (the plan)
> and `docs/design/monoracle-version-survey.md` (the version survey).
> **Branch:** `feat/monoracle-upstream` (worktree). **Commits:** plan+doctor, then the P1–P4 impl.

---

## 0. TL;DR (the 10-second version)

- We moved IRMarket's Monoracle integration onto the **upstream build ("A")** — **code + tests only** on `main`.
- ✅ **The "A" consumer stack is deployed to Monad testnet**: oracle `0x0BC36e1a…` (lazy/implicit
  settlement), wrapper `0x05475037…`, HKD `0x36448Ef0…`, 7 markets (NVDA/GLM/DEEPSEEK/B300/B200/H200/H100),
  vault `0x3d52a82a…`. A **separate** verifier bot (its own wallet) quotes it; see §7.
- 🟢 **Production is cut over (2026-10-24).** `irmarket.xyz` / `www.irmarket.xyz` serve the A-lazy stack;
  the pre-lazy stack (`0x3B08…` / `0x95a7…` / `0x8073…`) and the fork ("B") deployment stay live on-chain
  as rollback targets (restore the Vercel/ops env values, no contract changes).
- Both **Production** and **Preview** Vercel env scopes carry the A-lazy addresses, so previews no longer
  drift from production.

---

## 1. The mix-up we fixed (why this branch exists)

The repo carried **two wire-incompatible Monoracle builds** and hand-edited the ABI to match whichever
oracle was in front of the model. That silently broke things twice:

- the **bot** (wrong `submitQuote` selector → tx reverted), and
- the **web** (wrong `Quote` field order → "No quote available").

| | **A — upstream** (target) | **B — fork** (currently deployed) |
|---|---|---|
| `submitQuote` | `…, uint32 expiry` (selector `14a38ba6`) | `…, uint256 expiry` (`3a40e975`) |
| `Quote` order | `…, startSlot, expiryBlock, settledSlot, status` | `…, startSlot, settledSlot, expiryBlock, status` |
| window | per-quote, **cap `MAX_VERIFICATION_SLOTS = 12000`** (~1 h) | per-quote, **no cap** |
| errors | + `QuoteAmountTooSmall`, `ExpiryTooFar` | subset |

Good news: the current upstream is **not** a fixed-2-slot design — it keeps the **per-quote window**,
so D-13 ("window = option expiry") **survives**. This was a swap, not a redesign.

---

## 2. What's DONE on this branch (P1–P4, local)

| Phase | Change |
|---|---|
| **P1** | `contracts/test/MonoracleMock.sol` — added `VERIFICATION_SLOTS` / `MAX_VERIFICATION_SLOTS` + `ExpiryTooFar` cap (mirrors upstream). |
| **P2** | `script/sync-oracle-abi.js` (**new**) regenerated **both** ABI copies from the upstream build; they now **agree** (`uint32`, order `startSlot/expiryBlock/settledSlot`, `ExpiryTooFar` present). Added `ExpiryTooFar` message to `web/src/components/common/TxStatusCard.tsx`. (Web hooks were already A-order on `main`.) |
| **P3** | `bot/verifier.py` — quote field order → upstream; `MAX_VERIFICATION_SLOTS` pre-submit guard; comment fix. |
| **Prevent** | `script/oracle-doctor.js` — checks both ABI copies agree + match upstream, and fingerprints the configured oracle; exit 1 on drift. |

**Verified locally (no deploy):**

| Check | Result |
|---|---|
| `npx hardhat test` | **55 passing** |
| `cd web && npx tsc --noEmit` | clean |
| `cd web && npx playwright test` | **20 passed** |

---

## 2b. P5 — deployed to Monad (preview); production NOT cut over

A **"A" consumer stack** was deployed to Monad testnet with `script/deploy-market-stack.js` (the
consumer-mode deployer: it **never deploys Monoracle** — it takes the upstream oracle as
`ORACLE_ADDRESS` and gates on the A fingerprint; the earlier `deploy-upstream-stack.js` that
deployed its own oracle instance was renamed+refactored away). The wrapper + vault are bound to the
consumed oracle at construction (the immutable-binding gap in §3). A **separate** verifier bot — its
own wallet `0x5ceF21c2…`, config in `bot/.env` — quotes this stack, so it never shares a nonce with
the production/fork bot.

| Contract | Address |
|---|---|
| upstream oracle (A-lazy) | `0x0BC36e1ac475AdEF75F102deb1708BE6E45aA16f` (`VS=2`, `MAXVS=12000`; implicit settlement) |
| IRMarket wrapper | `0x05475037AE4e0717083737eDAc38590850968E7c` (2026-10-24 lazy cutover; fee recipient = bot `0x5ceF21c2…`) |
| HKD quote | `0x36448Ef080ba5fa251e1a9bd61782786f9e24F04` |
| NVDA base | `0xda9CF5A68cc2d8EFA5940db4094b6377D389DE17` |
| GLM base | `0x35B3f6b418d4D78961636Ec59d52c64B0f04612c` |
| SNDK base | `0x760c5Ceb6333f5C0F69a980EF5EcCF5d6ffE24eA` |
| DEEPSEEK base | `0xbc25eF3e40B43806803a87c5CB2bbdA80b9b92d5` |
| LP vault | `0x3d52a82a8a79b4Aecc90F37e506a441e0eF908AB` |
| previous wrapper (rollback) | `0x3B08bd1CD96D6Ca0bB5897944ce948f1018D9dE1` (2026-10-19 redeploy: trade gate + right-sized gas) |
| previous vault (rollback) | `0x95a74C58bbF1F8F56c02d27Aecc0024D98e67dD3` |
| previous oracle (rollback) | `0x807321100748d75a618e508de214123CB77C9f4D` |

Verified (2026-10-24 cutover): `node script/oracle-doctor.js 0x0BC36e1a…` → **A**, no drift;
`wrapper.oracle()` == `vault.oracle()` == `0x0BC3…`; the bot quotes all 7 pairs on the new wrapper and
`irmarket.xyz` serves the new addresses.

Vercel: **Production** and **Preview** env scopes both carry the A-lazy addresses; `irmarket.xyz` is
promoted to it (rollback = restore the pre-lazy values in both scopes and redeploy).

> ⚠️ The A verifier bot needs a funded MON balance (its wallet is not the deployer). Top it up from the
> deployer wallet if it logs `Signer had insufficient balance`.
>
> ✅ **Demo LP seeded & settled** (2026-10-16): the dedicated demo-LP wallet deposited the first
> 5,000 HKD, then topped up to **15,000 HKD** (`equity 15,002` after the demo, share price 1.0
> throughout). Both hedged directions settled on-chain: `LONG 100` + `SHORT 100` (30-block tenor,
> `payout 99.0 + 99.0`, 1% fee retained) — proof the pool pays in full both ways. Identity + demo
> txs recorded in `deployment-vault.json → demoLp*` (key kept outside the repo).

## 3. Remaining — the Production cutover

🔴 **The deployed contracts are immutable-bound to the fork oracle and must be redeployed.**

- `wrapper 0x03b181…`.oracle() = `0xb652…` (fork)
- `vault 0xE4B88d…`.oracle() = `0xb652…` (fork)

So an **env swap alone is not enough** — and it would split prices (`/vault` reads the oracle **from the
vault**; `/trade` reads `NEXT_PUBLIC_ORACLE_ADDRESS`).

**When you're ready, in order:**
1. Deploy the **upstream** oracle (or reuse `0x151286e6…` — prefer **fresh**) + tokens + markets.
2. **Redeploy the wrapper and the vault** bound to the new oracle. (Vault is empty today: `equity=0`,
   `pendingPayout=0`, `positionCount=0` — free to redeploy.)
3. Set the new addresses in the **Vercel Preview** env → verify `/`, `/trade`, `/vault` on the preview URL.
4. **Atomic cutover:** set the **Production** env + one `vercel --prod`. Vercel keeps the old prod live
   until the new is `READY`. **Rollback = re-promote the previous deployment** (instant).

Gate every step on `node script/oracle-doctor.js` (plan §8.6).

---

## 4. How to run / verify (gotchas)

```bash
# contracts
npx hardhat test                      # 55 passing

# web
cd web && npm ci                       # ⚠️ see gotcha below
cd web && npx tsc --noEmit
cd web && npx playwright test          # 20 passing (starts its own anvil + dev server)

# guard + generator
node script/oracle-doctor.js           # fingerprint repo ABIs + configured oracle
node script/sync-oracle-abi.js         # regenerate both ABI copies from ../monoracle build

# deploy the IRMarket consumer stack: wrapper + HKD + 4 asset rounds + ONE vault
# CONSUMES the upstream oracle via ORACLE_ADDRESS (required, fingerprint-gated, --dry-run available)
# tokens are reused from deployment-assets.json (mint top-ups); never redeployed
#   $env:ORACLE_ADDRESS="0x0BC36e1ac475AdEF75F102deb1708BE6E45aA16f"
node script/deploy-market-stack.js
```

**Gotchas (learned the hard way):**
1. ⚠️ **Worktree + node_modules:** Turbopack **rejects symlinked `node_modules`** ("points out of the
   filesystem root"). Don't junction — run a real `npm ci` in `web/` (and root if you need hardhat).
2. **The ABI is GENERATED.** Never hand-edit `abi/Monoracle.abi.json` or `web/src/lib/abis/Monoracle.json`
   — run `script/sync-oracle-abi.js`. The doctor enforces agreement.
3. **The rule:** if the ABI and the deployed oracle disagree → **migrate the oracle**, never bend the ABI.
4. **Immutable bindings:** the wrapper + vault pin the oracle at construction — redeploy, don't re-point.

---

## 5. Open decisions (from the plan)

- **Fresh vs reuse** the upstream oracle (`0x151286e6…` has only stale quotes) → recommend **fresh**.
- **~1 h cap** (`MAX_VERIFICATION_SLOTS = 12000`): fine for the demo (3–30 min rounds).
- **Positions vanish from the UI** after re-pointing envs (event-derived, no ledger) → disclose in the demo doc.

---

## 6. Status of the live deployment

- **Untouched.** `irmarket.xyz` → fork oracle `0xb652…`, wrapper `0x03b181…`, vault `0xE4B88d…`.
- The era **fork bot** (`../IRMarket`, deployer wallet `0xF5Cf…`) is still running against the fork. The
  **A-stack bot** (this worktree, wallet `0x5ceF21c2…`, `bot/.env`) runs in parallel — different key, so
  no nonce contention. Stop the fork bot only at cutover.

---

## 7. Handoff — LP option-premium pricing exploration (2026-10-16)

> **Read-me for the next agent/reviewer.** Out of PR #10's migration scope: we explored whether the
> LP pool can charge a **market-priced option premium** (BSM) for short-expiry ATM positions instead
> of the flat 1% spread — a design gap registered on `dixia/IRMarket#9` (comment 2026-10-16). The full
> spec + measurements live in `docs/design/lp-pool-premium-pricing-spec.md`.

### What exists now (all on PR #10 branch, committed)

| Artifact | What it is | NOT |
|---|---|---|
| `docs/design/lp-pool-premium-pricing-spec.md` | Full pricing spec: on-chain infra inventory, **measured** gas costs, options A (on-chain BSM) / **B (provider-priced premium + cheap on-chain bounds — recommended)** / C (lookup grid), vault-contract change plan (premium decoupled from at-risk `N`, premium → LP equity, 2N cap untouched) | it is NOT implemented in the contracts |
| `contracts/probe/BsmPricingProbe.sol` + `script/probe/gas-probe.js` | THROWAWAY gas measurement (labeled "NEVER wire into product") | not a product contract; never referenced by imports |
| `tools/backtest/premium-backtest.js` + `docs/design/lp-pool-premium-backtest-2026-10-16.csv` | Re-runnable backtest over real settled NVDA/HKD history (reads 1.63 days of `QuoteSettledValid` + `QuoteSubmitted` for pair attribution; RPC via `$env:RPC_URL` only — no keys committed) | no on-chain writes |

### Key findings (so the next session doesn't re-derive)

1. **On-chain infra can price it.** Inputs: canonical price (S), block tenor (T at 0.3 s/block), 2N cap
   envelope. The one missing input — volatility — is observable from settled-price history. Gas cost of a
   full-precision BSM call in WAD math: **+9–11% on a typical ATM `openPosition`** (294,962 gas baseline),
   worst deep-OTM branch **+23.6%**. OZ v5.6 ships NO fractional `ln`/`exp` — the probe hand-rolls them
   (+ A&S 26.2.17 Φ, ~1e-7 error); all tuple values matched the JS reference ≤ 1e-6.
2. **Vol data layer must join settled→submitted ids.** `QuoteSettledValid` carries NO pair field; the
   backtest joins settled `quoteId` against `QuoteSubmitted` (topic3 = baseToken). Reuse this pattern for
   any on-chain σ feed.
3. **Backtest (15 real rounds, 2026-10-15 sample): at realized σ ≈ 1.44%/round (~0.57% BSM premium) the
   pool **earns less** than the flat 1%** (`BSM net −9.05 HKD` vs `flat −3.50 HKD` over the same rounds;
   even σ×1.5 nets −5.32). Seller income is a bet that **charged IV ≥ realized vol + margin**; the
   recommended option-B bounds should envelope `IV_floor ≈ 1.2–1.5× realized vol`, and V1 pricing should
   track implied, not realized, vol. ⚠️ 15 rounds is direction-only evidence — re-run after the demo
   accumulates a clean week (`node tools/backtest/premium-backtest.js` with `$env:RPC_URL` set).
4. **Vault side** (spec §4, no code): `openPosition` gains a market-priced `premium` parameter; premium
   flows to LP equity as income; the at-risk `N` decouples from the trader's posted capital; the
   `pendingPayout ≤ balance` invariant and the 2N cap stay as-is (solvency proof unchanged).
5. **1% flat remains live and fine for the judging demo** (and it actually out-earned BSM-at-realized-vol
   in our sample). Nothing in this exploration blocks P5 or the cutover.

### Open decisions for the post-#9 review

- Which design (A/B/C) to implement for V1 — recommendation: **B** (argued from measured gas + the
  ownerless/no-feed convention).
- σ source governance: per-pair provider-supplied σ with on-chain bounds, vs a fixed σ registry
  with timelock, vs purely realized-vol-derived bounds (§3/§6 of the spec).
- Whether the 1% spread survives as an allocation fee ON TOP of the market premium.
