# Multichain Support — Tech Spec

> **Status:** implemented and deployed. Avalanche Fuji (43113) is live at
> `https://avax.irmarket.xyz`; Monad testnet (`irmarket.xyz`) is unchanged.
>
> **Scope:** chain-scoped deployment registries, a per-chain parameter table, chain guards in the
> deploy scripts and the bot, bot env-file selection, and chain-aware frontend configuration.
>
> **Companions:** `docs/chain-params.md` (values, measured timings, deployed addresses),
> `docs/design/lp-pool-tech-spec.md` §11 (Monad-vs-Avalanche comparison),
> `docs/architecture.md` §6 rule 5 (the hard rule this spec implements).

---

## 1. Context and goals

IRMarket was single-chain by construction. Contracts are portable EVM (`Monoracle.sol` has no
constructor arguments, no external price feeds, no owner; `IRMarket.sol` / `IRMarketVault.sol` are
plain OpenZeppelin v5), so the work is **configuration, not contract code**.

The product expresses every duration in **blocks** and assumed **0.3 s/block** (Monad). A second
chain with a different cadence silently changes every tenor, lookback, and settlement window.

Goals, in priority order:

1. **Do not break Monad.** The existing deployment, bot, and Vercel production scope must keep
   working with identical behaviour.
2. **Make cross-chain reuse impossible, not merely unlikely.** A registry written for one chain must
   never be consumed on another.
3. **Fail loudly.** A mis-pointed chain id or env file should stop the process, not quote on the
   wrong network.
4. **Additive, not a rewrite.** New chains extend a table; Monad's values are the defaults.

---

## 2. Design overview

| Concern | Mechanism |
|---|---|
| Per-chain constants | `script/networks.js` (authoritative) + `web/src/lib/chainParams.ts` (mirror) |
| Registry files | chain-scoped names; legacy unsuffixed names readable during migration |
| Reuse safety | `sameChain()` guard in `script/stack-reuse.js`, applied to every registry read |
| Bot safety | `EXPECTED_CHAIN_ID` + registry `chainId` assertion at startup |
| Bot env files | `BOT_ENV_FILE` (default `bot/.env`) |
| Frontend chain | chain-id-keyed base chain; no hardcoded chain object |
| Frontend time | block counts derived from the chain's `blockSeconds` |

The contracts are untouched. Nothing in this design changes the `IMonoracle` ABI or the oracle
binding rules in `docs/architecture.md` §6.

---

## 3. Chain parameters

`script/networks.js` is the single source of truth for deploy-side values:

| Chain | chainId | Slug | Block seconds | Native | Explorer |
|---|---|---|---|---|---|
| Monad testnet | 10143 | `monad-testnet` | 0.3 | MON | `https://testnet.monadscan.com` |
| Avalanche Fuji | 43113 | `avalanche-fuji` | 2 | AVAX | `https://testnet.snowtrace.io` |
| Anvil (local) | 31337 | `anvil-local` | 0 (not derivable) | ETH | — |

`chainInfo(chainId)` returns the row, or `{ slug: "chain-<id>", blockSeconds: null }` for unknown
chains. `blockSeconds(chainId)` is the strict accessor: it honours a `BLOCK_SECONDS` override and
otherwise **throws** when the chain's cadence is unknown. Callers must not divide by
`blockSeconds` directly — `Math.floor(seconds / null)` yields `Infinity` and `BigInt(Infinity)`
throws a bare `RangeError`.

The web mirror degrades gracefully instead: `chainParams(chainId)` falls back to Monad's 0.3 s so
the UI never renders `NaN`. Strictness belongs in the deploy path.

Measured values on Fuji: **1.77 s** average block time over 300 blocks, **~2.04 s** submit→receipt,
160 wei/gas. See `docs/chain-params.md`.

---

## 4. Registry scoping

### 4.1 Naming

Deployment artefacts are chain-scoped. The suffix matches the `network` field written inside the
file:

```
deployment.<slug>.json          # wrapper + base/quote + marketId
deployment-assets.<slug>.json   # token book (per-symbol base tokens + HKD)
deployment-vault.<slug>.json    # LP vault bindings
```

### 4.2 Migration policy

**Readers accept both forms; writers only write the scoped form.** A reader resolves the scoped
file first, then falls back to the legacy name with a warning. This keeps existing checkouts working
and lets the legacy files age out without a flag day.

The legacy names (`deployment.json`, `deployment-assets.json`, `deployment-vault.json`) stay in
`.gitignore`. Removing those rules would make a legacy file committable, so the migration adds the
glob rather than replacing the exact names:

```
deployment.json
deployment-vault.json
deployment.*.json
deployment-vault*.json
deployment-assets*.json
```

`bot/.env` keeps its existing rule and gains `bot/.env.*` with a `!bot/.env.example` negation, so
per-chain env files are never committed.

### 4.3 Touchpoints

| Role | File |
|---|---|
| read + write | `script/deploy-market-stack.js` (all three), `script/deploy-assets.js`, `script/create-market.js`, `script/deploy.js` |
| write | `script/deploy-vault-rpc.js` (derives the slug from the live `chainId`) |
| read | `script/mint-demo-tokens.js`, `bot/verifier.py`, `web/tests/helpers/preview-fixtures.ts`, `script/smoke-test.js` |

`script/create-market.js` is chain-aware because it **rewrites** the deployment registry in place
while rolling a round; an unscoped write there would stamp a Monad round into a Fuji registry.

`script/smoke-test.js` had a pre-existing bug (it read `deployInfo.address`, a field no deploy
script writes — they all write `market`). Fixed while migrating the path.

`web/tests/helpers/preview-fixtures.ts` selects the registry through a new `E2E_CHAIN_ID` and also
accepts a `chain` object, so the same fixture code drives Monad preview runs and the Fuji video run.

---

## 5. Chain guard

### 5.1 Policy

```js
export function sameChain(registry, chainId) {
  return !!registry && Number(registry.chainId) === Number(chainId);
}
```

A missing `chainId` is a **rejection** (`NaN !== id`), never an implicit pass. The safe default is
"deploy fresh".

### 5.2 Why this exists

Before this change the reuse logic was asymmetric:

| Artefact | Guard before | Why |
|---|---|---|
| IRMarket wrapper | oracle binding | `shouldReuseWrapper` compares the registry oracle with the run's oracle |
| IRMarketVault | three bindings | oracle / priceBase / settlementToken must all match |
| **HKD quote token** | **none** | taken straight from `registry.quoteToken` |
| **Base tokens** | **none** | reused by symbol alone |

The tokens were the hole. A clobbered registry would make a Monad re-run call `mint()` on addresses
that belong to Fuji — at best reverting, at worst hitting an unrelated contract on Monad. The chain
guard closes that asymmetry; the filename suffix is the primary defence and the guard is
defence-in-depth.

When a registry is rejected the scripts log it explicitly:

```
! deployment-assets registry is for chain 10143 (monad-testnet);
  this run targets 43113 (avalanche-fuji) -> ignoring it, deploying fresh
```

### 5.3 Bot assertion

`BotContext` reads `w3.eth.chain_id` at startup and compares it with:

- `EXPECTED_CHAIN_ID` (optional), and
- the assets file's `chainId` (checked whenever present).

Mismatch is a hard `RuntimeError`. `EXPECTED_CHAIN_ID` stays optional because the Monad production
env does not set it; making it required would exit that bot on restart.

`test/stack-reuse.test.js` pins the policy with cross-chain rejection cases.

---

## 6. Bot env selection

`bot/verifier.py` loads its env by explicit path (immune to CWD and debuggers). It now honours
`BOT_ENV_FILE`:

```python
_ENV_OVERRIDE = os.getenv("BOT_ENV_FILE")
load_dotenv(Path(_ENV_OVERRIDE) if _ENV_OVERRIDE else Path(__file__).resolve().parent / ".env")
```

Unset means `bot/.env`, so existing deployments and `scripts/ops/run_testnet_live.sh` (which already
exports `BOT_ENV_FILE`) behave as before.

Per-chain env files: `bot/.env.monad`, `bot/.env.fuji` (both gitignored). On the ops server this maps
to two systemd units sharing one checkout and one venv:

| Unit | Chain | Env |
|---|---|---|
| `irmarket-bot` | Monad | `bot/.env` (default) |
| `irmarket-bot-fuji` | Fuji | `Environment=BOT_ENV_FILE=<repo>/bot/.env.fuji` |

The "one instance per wallet" rule in `AGENTS.md` is scoped **per chain**: the same address may run
on two chains (separate nonce spaces) but not twice on one chain.

---

## 7. Frontend chain configuration

- **`web/src/lib/wagmi.ts`** selects the base chain from a `chainId`-keyed map
  (`10143 → monadTestnet`, `43113 → avalancheFuji`). It must **not** spread one hardcoded chain:
  doing so gives the other network's metadata (name, native currency, explorer, icon) while
  overriding only `id` and `rpcUrls`. Unknown chains get a bare object with neutral metadata.
- **`web/src/lib/config.ts`** reads `NEXT_PUBLIC_EXPLORER_BASE`, falling back to the chain's explorer
  from `chainParams`. `EXPLORER_BASE` is consumed by `lib/market.ts` as well as the tx/address link
  helpers, so one env var covers both.
- **`web/src/lib/chainParams.ts`** mirrors the JS table and exposes `blocksForSeconds` /
  `secondsForBlocks`.
- **Derived time constants** replace the Monad-tuned literals: the expiry countdown
  (`lib/countdown.ts`, injected block time), the position / vault-settled lookbacks (~25 min), the
  market lookback (~70 min), and the vault tenor presets (60/180/600 s converted to blocks).
- **`MON_RESERVE_FLOOR`** became `NATIVE_RESERVE_FLOOR`: 10 MON on Monad testnet, 0 elsewhere. The
  old name remains as a deprecated alias.
- **Fixed gas limits** in `lib/config.ts` and `hooks/useVaultTrade.ts` stay Monad-tuned. They are
  safe on Fuji (unused gas is refunded) but conservative; the Monad rationale no longer applies.

`web/vercel.json` pins `"framework": "nextjs"`. The Monad project also reads this file (its Root
Directory is `web`); the setting matches what that project already is.

---

## 8. Deployment (as built)

### 8.1 Chain order

1. Deploy the **upstream** Monoracle on the target chain from `github.com/dixia/monoracle`. IRMarket
   never deploys the oracle (`docs/architecture.md` §6 rule 1).
2. Fingerprint it with `node script/oracle-doctor.js <address>` — it must classify as upstream "A".
3. Deploy the IRMarket stack: `ORACLE_ADDRESS=… CHAIN_ID=… node script/deploy-market-stack.js`.
   The deployer also gates on the A-shape internally.

`deploy-market-stack.js` deploys its own HKD + asset `MockERC20`s; upstream `deploy-tokens.js` is not
needed for this stack.

### 8.2 Vercel

| Project | Domain | Root Directory | Deploy from |
|---|---|---|---|
| `irmarket` | `irmarket.xyz` | `web` | repo root |
| `irmarket-avax` | `avax.irmarket.xyz` | `.` (upload root) | `web/` |

The two are opposites because Root Directory is resolved against the uploaded tree. `irmarket-avax`
is CLI-only and carries ten Fuji `NEXT_PUBLIC_*` variables in both production and preview scopes.

**RPC constraint:** `https://api.avax-test.network/ext/bc/C/rpc` returns **403** to requests that
carry a browser `Origin`, so `NEXT_PUBLIC_RPC_URL` must be a CORS-open endpoint (the deployment uses
`https://avalanche-fuji-c-chain-rpc.publicnode.com`). Node-side scripts can keep the official RPC.

### 8.3 Deployed addresses (Fuji)

| Contract | Address |
|---|---|
| Monoracle (upstream) | `0x71b15f6638f3bBF2cdC8f8D6cdE54B3DFE052D57` |
| IRMarket wrapper | `0x3f5dEa6aEC7f8FF3B283B7e24421bc6a648A468B` |
| HKD quote | `0x99a94E4E68997E7C7F687A1ebceC0D0f865c180f` |
| NVDA base / vault | `0xcD276DE522df0Ef5a3569c92b21e987B5C9dC77b` / `0xc5e66771aB07445745eE749a540B0E69d9E8EC69` |
| GLM / SNDK / DEEPSEEK | `0xF136B7fB…9486` / `0x7C68d80E…C0EA` / `0x348292e4…E233` |

| GPU spot B300 / B200 / H200 / H100 | `0x6CbC5c5677B09e0E1431CaB4cCa465B5358313f8` / `0xe32E0B7e983a56f01dc45e0ae7e489235E4AA77C` / `0x0C5F28229d8b825F0f2510cCb069f81Dd45F1E85` / `0xfFF247D190E4bA80de38214c7a2772D62ad72665` (markets 525-528, Nebius spot — see `docs/chain-params.md`) |

Gas on Fuji was 160 wei/gas at deploy time; the full stack cost ~2.4 gwei of AVAX.

---

## 9. Verification and rollback

**Monad was not disturbed** — checked after the Fuji deploy:

- `deployment.monad-testnet.json` still holds the pre-Fuji `market` / `oracle` / `txHashes`.
- `script/oracle-doctor.js <monadOracle>` still classifies as "A".
- The Monad Vercel production scope is unchanged and `irmarket.xyz` still serves the Monad addresses.

**Fuji checks:** the oracle fingerprints as "A" with `VERIFICATION_SLOTS = 2` and
`MAX_VERIFICATION_SLOTS = 12000`; the wrapper `version()` is `0.9.0-vetomarket`; the vault's
`oracle` / `priceBase` / `settlementToken` match the registry.

**Rollback:** the Fuji deployment is additive. Stop the Fuji bot
(`systemctl disable --now irmarket-bot-fuji`) and stop pointing the domain at it; no Monad state is
mutated, so there is nothing to unwind.

---

## 10. Rejected design: Robinhood Chain (46630)

Arbitrum Nitro / Orbit. **`block.number` returns an estimate of the Ethereum L1 block, not the L2
block.** Monoracle's entire timing primitive (`startSlot`, `settledSlot`, the verification-window
checks) is block-number-based, so the veto window is undefined.

The fix would be `ArbSys(0x0000000000000000000000000000000000000064).arbBlockNumber()` or a migration
to `block.timestamp`. That is a contract redesign touching every bot/UI/test assumption, not a port.
It also inherits two properties the current model does not have: sequencer-level censorship (a
dropped veto transaction lets a mispriced quote settle with no on-chain trace) and staged finality
(sub-second soft confirmation, minutes to L1 posting, ~13 min to Ethereum finality).

Deployment logistics themselves are trivial there; the blocker is purely `block.number` semantics.

---

## 11. Risks and accepted trade-offs

1. **Front-running is live on Fuji.** Monad's local mempools make veto fills effectively
   see-what-you-sign; Fuji has a public mempool, so `openPosition` reads the canonical price at
   execution time and can be sandwiched between simulation and inclusion. `minPayoutOut` slippage
   protection is designed but **not implemented** (V1.1 scope). Accepted for the testnet demo; not
   acceptable for mainnet.
2. **`uint32(block.number)` casts** (`Monoracle.sol:205,223,292`, `MonoracleMock.sol:72`) wrap above
   block 4,294,967,295 — ~272 years at Fuji's cadence. Not a practical concern.
3. **Market lookback.** `useMarkets` scans a bounded window (2100 blocks on Fuji, ~1 h). With no bot
   running, the last round ages out and the tab shows "No markets yet". The Fuji bot rolls a round
   every ~30 min, which keeps it populated; the vault page only needs a settled canonical price.
4. **Gas limits remain Monad-tuned.** On Fuji they are safe but waste refunded gas.
5. **`LOG_CHUNK_BLOCKS = 975`** exists for Monad's tight `eth_getLogs` range. It is conservative on
   Fuji but valid.

---

## 12. CI coverage

The workflow (`.github/workflows/ci.yml`) runs on every push and pull request:

| Job | Steps |
|---|---|
| `contracts` | `npm ci` → `script/oracle-doctor.js` (ABI drift) → `npx hardhat compile` → `npx hardhat test` |
| `web` | `npm ci` (web) → `npx tsc --noEmit` → `npx eslint src` → `npx next build` with Monad env |

**Not covered** — relevant gaps for this change:

- **No bot tests.** `bot/verifier.py` is Python and neither compiled nor exercised. The chain guard
  and `BOT_ENV_FILE` logic are verified only by manual runs.
- **No deploy-script checks.** `script/networks.js` has no tests, and the modified scripts are not
  linted, typechecked, or dry-run in CI. Only `test/stack-reuse.test.js` (via `hardhat test`) covers
  the reuse policy.
- **Lint scope is `src` only**, so `web/tests/**` is unlinted — that is where the repo's known
  `no-explicit-any` warnings live.
- **No E2E / Playwright / video suite.** The Fuji and Monad user flows are not in CI.
- **No secret scan.**
- **`next build` uses hardcoded Monad env**, so the Fuji config path is never built in CI.
- **No Vercel preview deploy check.**

Reasonable follow-ups: a `bot` job (`python -m py_compile` plus a few unit tests around
`_resolve_assets_path` and the chain comparison), `node --check script/*.js` plus a `--dry-run`
smoke with a stubbed RPC, and extending lint to `tests/`.

---

## 13. As-built inventory

| Layer | Change |
|---|---|
| Contracts (both repos) | none |
| `script/networks.js` | new: chain table, `chainInfo`, `blockSeconds`, `blocksForSeconds`, registry naming/resolution |
| `script/stack-reuse.js` | `sameChain()`; applied to every registry read |
| `script/deploy-market-stack.js` | `chainInfo`-driven slug/block/explorer/symbol; chain guard on both registries |
| `script/deploy-assets.js`, `deploy.js`, `create-market.js`, `deploy-vault-rpc.js` | `chainInfo` for slug/block time; chain-aware paths |
| `script/mint-demo-tokens.js`, `smoke-test.js` | scoped path + legacy fallback; `smoke-test` `deployInfo.address` bug fixed |
| `bot/verifier.py` | `BOT_ENV_FILE`; `EXPECTED_CHAIN_ID` + registry `chainId` assertion; env-driven near-expiry constants; chain-aware registry resolution |
| `bot/.env.example` | documents `BOT_ENV_FILE`, `EXPECTED_CHAIN_ID`, per-chain env files |
| `web/src/lib/chainParams.ts` | new: web mirror + block/second helpers |
| `web/src/lib/countdown.ts` | new: chain-aware expiry countdown |
| `web/src/lib/wagmi.ts` | chain-id-keyed base chain |
| `web/src/lib/config.ts` | `NEXT_PUBLIC_EXPLORER_BASE`; `NATIVE_RESERVE_FLOOR` |
| `web/src/lib/format.ts`, `hooks/useMarkets.ts`, `usePositions.ts`, `useVaultSettled.ts`, `VaultTradePanel.tsx` | derived block counts |
| `web/vercel.json`, `web/.vercelignore` | `framework: nextjs`; upload hygiene for the web-rooted Fuji project |
| `web/tests/helpers/*` | testnet bridge + fixtures accept a chain; `E2E_CHAIN_ID` |
| `web/tests/fuji-video-setup.ts`, `playwright.video.fuji.config.mts`, `tests/video/fuji-user-flow.spec.ts` | new: Fuji video harness |
| `.gitignore` | chain-scoped registry globs; `bot/.env.*` |
| `AGENTS.md`, `docs/architecture.md` | chain dimension; hard rule 5 |
| `docs/chain-params.md` | new: values, measured timings, deployment record |
