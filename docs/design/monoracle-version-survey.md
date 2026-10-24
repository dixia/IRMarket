# Monoracle Version Survey — the single pin record

> Source of truth for "which Monoracle build is on-chain where, and which one IRMarket
> **consumes**". Everything else (handoff, plan, AGENTS.md, PRD) cites this file — keep it current
> when any oracle deployment changes, and re-verify with `node script/oracle-doctor.js` before
> every deploy. Companion: `monoracle-upstream-handoff.md`, `../plan/monoracle-upstream-migration-plan.md`.

**The rule:** if the repo ABI and the deployed oracle disagree → **migrate the oracle, never bend
the ABI**. IRMarket-side scripts must **never** deploy Monoracle (`deploy-market-stack.js` gates on
the fingerprint below and exits 1 on drift).

## 1. Wire shapes (the thing that bit us twice)

| | **A — upstream (current)** | **B — fork (legacy, deprecated)** |
|---|---|---|
| `submitQuote` | `(address,address,uint256,uint256,uint32)` — selector `14a38ba6` | `(…,uint256 expiry)` — selector `3a40e975` |
| expiry check | `expiry ∈ (block, block+MAX_VERIFICATION_SLOTS]` → reverts `ExpiryTooFar`/`ExpiryMustBeFuture` | only `expiry > block` |
| `Quote` field order | `provider, baseToken, quoteToken, baseAmount, quoteAmount, price, startSlot, expiryBlock, settledSlot, status` | `… startSlot, settledSlot, expiryBlock, status` |
| constants | `VERIFICATION_SLOTS = 2`, `MAX_VERIFICATION_SLOTS = 12000` (~1 h cap) | none |
| error set | + `QuoteAmountTooSmall`, `ExpiryTooFar` | subset |

## 2. On-chain deployments (fingerprinted 2026-10-15 via `eth_getCode` hashes)

| Address | code hash | size | Family |
|---|---|---|---|
| `0x807321100748d75a618e508de214123CB77C9f4D` | `0x64527fccc4958fef…` | 15,292 | **A (pre-lazy upstream build) — IRMarket's consumed instance until 2026-10-24** |
| `0x0BC36e1ac475AdEF75F102deb1708BE6E45aA16f` | `0x01f9ddadeaef61d6…` | 8,709 | **A-lazy (implicit settlement) — IRMarket's consumed instance since 2026-10-24** |
| `0x151286e6Ca5F5CA20910dE90C0DCEAa9fd71f2c8` | `0x64527fccc4958fef…` | 15,292 | **A — bytecode-identical** to the consumed instance (upstream's own testnet deployment); NOT wired into IRMarket |
| `0x1ABABc60Ca6950C94eA80F2f611AB06aAAAD28c0` | `0xfe7b43d4fcc544bb…` | 14,672 | A (older) |
| `0xF92A55D4e22456C987b3e7AF2E3730b3f5022Ccb` | `0x5eb5e5eec254b9ef…` | 8,084 | A (older; monoracle bot's oracle) |
| `0xb6523DA6f177dB25d766a27575624B3e1fe0a00e` | `0x09a950a8cd7480ac…` | 14,438 | **B — fork** (legacy; `irmarket.xyz` was cut over to the A stack on 2026-10-19, so this is retired) |

Downstream bindings (all `oracle()` immutable at construction — oracle change = downstream
redeploy, never re-point):

- wrapper `0x05475037AE4e0717083737eDAc38590850968E7c` → `0x0BC36e1a…` (A-lazy) — 2026-10-24 production
  cutover; fee recipient = bot `0x5ceF21c2…`
- vault `0x3d52a82a8a79b4Aecc90F37e506a441e0eF908AB` → `0x0BC36e1a…` (A-lazy), pair `(NVDA 0xda9CF5A6…, HKD 0x36448Ef0…)`
- previous production (rollback): wrapper `0x3B08bd1CD96D6Ca0bB5897944ce948f1018D9dE1` → `0x80732110…` (A) — deployed 2026-10-19 with the
  `MarketWindowExpired` trade gate + right-sized gas limits (replaces the pre-gate wrapper `0x39A14B5d…`,
  which stays on-chain but no longer receives rounds)
- previous production vault (rollback): `0x95a74C58bbF1F8F56c02d27Aecc0024D98e67dD3` → `0x80732110…` (A), same pair
- legacy prod: wrapper `0x03b181…` + vault `0xE4B88d…` → `0xb652…` (B)

## 3. Source & provenance

- Upstream source: `github.com/dixia/monoracle` — A build artifact
  `../monoracle/artifacts/contracts/Monoracle.sol/Monoracle.json` at upstream repo HEAD `02435e1`
  (docs: Robinhood feasibility findings; `MonoracleWindowed` fork is git-history-only, no live source).
- ABI copies in this repo are **GENERATED** — `node script/sync-oracle-abi.js` →
  `abi/Monoracle.abi.json` (bot/scripts) + `web/src/lib/abis/Monoracle.json` (web). Never hand-edit.
- Consumed-instance deployment tx hashes & demo-asset registry: repo-root `deployment.json`,
  `deployment-assets.json`, `deployment-vault.json` (gitignored). Deployers: `0xF5Cf…` (upstream +
  IRMarket contracts + prod-fork bot loop) and `0x5ceF21c2…` (A-stack verifier bot, separate nonce space).

## 4. How to re-verify (30 s)

```bash
node script/oracle-doctor.js                       # repo ABIs agree + known oracle fingerprints
node script/oracle-doctor.js 0x0BC36e1ac475AdEF75F102deb1708BE6E45aA16f
node script/deploy-market-stack.js --dry-run       # deployer pre-flight: REQUIRED oracle gate
```
