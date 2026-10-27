# Chain Parameters

The machine-readable source of truth is `script/networks.js` (deploy scripts) and its web
mirror `web/src/lib/chainParams.ts`. This file documents the values and how they are derived.

## Supported chains

| Chain | chainId | Slug | Block time | Native | Explorer |
|---|---|---|---|---|---|
| Monad testnet | 10143 | `monad-testnet` | ~0.3 s | MON | https://testnet.monadscan.com |
| Avalanche Fuji | 43113 | `avalanche-fuji` | ~2 s | AVAX | https://testnet.snowtrace.io |
| Anvil (local) | 31337 | `anvil-local` | on-demand | ETH | — |

Unknown chains get the slug `chain-<id>` and **no known block time**: the deploy scripts require
an explicit `BLOCK_SECONDS` override and fail with a named error before doing any arithmetic.

## Registry naming

Registries are chain-scoped so two chains never share token/market addresses:

```
deployment.<slug>.json          # wrapper + base/quote + marketId
deployment-assets.<slug>.json   # the token book (per-symbol base tokens + HKD)
deployment-vault.<slug>.json    # LP vault bindings
```

The legacy unsuffixed names (`deployment.json`, `deployment-assets.json`,
`deployment-vault.json`) remain readable during the migration but are never written. Every reader
prefers the chain-scoped file and falls back to the legacy one with a warning. A registry whose
`chainId` differs from the run's target is ignored (deploy) or refused (bot) — never consumed.

## Deploying a new chain

1. Add the chain to `script/networks.js` **and** `web/src/lib/chainParams.ts`.
2. Deploy the upstream Monoracle on that chain (`github.com/dixia/monoracle`), then verify it
   fingerprints as upstream "A" (`node script/oracle-doctor.js <address>`).
3. Deploy the IRMarket stack with `CHAIN_ID=<id> ORACLE_ADDRESS=<addr> node script/deploy-market-stack.js`.
4. Use a per-chain bot env (`bot/.env.<slug>`, selected with `BOT_ENV_FILE`) and set
   `EXPECTED_CHAIN_ID` to make a mis-pointed config fail loudly.
5. Point the frontend at the chain via the Vercel **Preview** env scope only until verified.

## Re-derived durations on Fuji (~2 s/block)

The product's wall-clock intent is preserved by converting seconds to blocks per chain. At
2 s/block, a Monad figure of *N* blocks becomes *N × 0.3 / 2* blocks.

| Purpose | Monad blocks | Fuji blocks |
|---|---|---|
| 1 min tenor | 200 | 30 |
| 3 min tenor | 600 | 90 |
| 10 min tenor | 2000 | 300 |
| ~25 min position lookback | 5000 | 750 |
| ~70 min market lookback | 14000 | 2100 |
| 30 min round (`ROUND_BLOCKS`) | 6000 | 900 |
| ~19 s settlement window | 60 | ~10–15 |
| ~1 s settlement quote lead | 3 | 1 |
| ~20 s near-expiry band | 65 | 10 |

`VERIFICATION_SLOTS = 2` and `MAX_VERIFICATION_SLOTS = 12000` are immutable upstream constants.
They are *suggestions/caps*, not the real window: every product path passes an explicit
`expiryBlock`, so 12,000 blocks becomes a harmless ~6.7 h cap on Fuji rather than a 1 h one.

## Fuji-specific notes

- **Front-running is live.** Fuji has a public mempool; `openPosition` reads the canonical price
  at execution time and can be sandwiched. `minPayoutOut` is designed but not implemented (V1.1).
  Accepted for the testnet demo, not for mainnet.
- **Gas billing differs.** Monad bills `gas_limit × price`; Fuji is EIP-1559 and refunds unused
  gas. The fixed gas limits in `web/src/lib/config.ts` and `web/src/hooks/useVaultTrade.ts` are
  safe but conservative.
- **Multicall3** exists at the canonical `0xcA11bde05977b3631167028862bE2a173976CA11`, so batched
  reads work unchanged.
- **`eth_getLogs`** allows ranges much larger than Monad's ~100 blocks; `LOG_CHUNK_BLOCKS = 975`
  remains valid.

## Deployed addresses — Avalanche Fuji (deployed 2026-10-20)

Upstream oracle deployed from `github.com/dixia/monoracle` (its own worktree, so its Monad
`deployment.json` was not touched). IRMarket stack written to the chain-scoped registries.

| Contract | Address |
|---|---|
| Monoracle (upstream) | `0x71b15f6638f3bBF2cdC8f8D6cdE54B3DFE052D57` |
| IRMarket wrapper | `0x3f5dEa6aEC7f8FF3B283B7e24421bc6a648A468B` |
| HKD quote (MockERC20) | `0x99a94E4E68997E7C7F687A1ebceC0D0f865c180f` |
| NVDA base + vault | `0xcD276DE522df0Ef5a3569c92b21e987B5C9dC77b` / `0xc5e66771aB07445745eE749a540B0E69d9E8EC69` |
| GLM base | `0xF136B7fB7804F20e2A619160c006F68E91789486` |
| SNDK base | `0x7C68d80E14e060E4cE6839c1D79EF5De350AC0EA` |
| DEEPSEEK base | `0x348292e46E3116d88009F6c449e3242d9BAbE233` |

Market ids NVDA/GLM/SNDK/DEEPSEEK = 1/2/3/4, `feeBps=100`, first-round `expiryBlock=59741913`.
Bot config: `bot/.env.fuji` (gitignored; fill in `PRIVATE_KEY`).

### GPU spot markets (added 2026-10-23)

The four Nebius spot pairs from the Monad set (`docs/design/bot-real-price-feed-spec.md` §5.1)
now exist on Fuji too, added with `script/deploy-assets.js` (merge mode — it keeps the pairs
already listed in the registry instead of replacing them):

| symbol | base token | marketId | seed (`fairPrice`) | live spot at deploy |
|---|---|---|---|---|
| B300 | `0x6CbC5c5677B09e0E1431CaB4cCa465B5358313f8` | 525 | 9.49 | 9.49 USD/GPU-hr |
| B200 | `0xe32E0B7e983a56f01dc45e0ae7e489235E4AA77C` | 526 | 2.30 | 2.30 |
| H200 | `0x0C5F28229d8b825F0f2510cCb069f81Dd45F1E85` | 527 | 0.95 | 0.95 |
| H100 | `0xfFF247D190E4bA80de38214c7a2772D62ad72665` | 528 | 0.79 | 0.79 |

`priceSource="nebius"`, `priceSymbol=<model>`, `assetClass="gpu"`; first-round
`expiryBlock=59895816`. Real pricing needs `PRICE_FEED_ENABLED=1` in `bot/.env.fuji` (enabled
on the ops server): pairs carrying a `priceSource` use their real feed (NVDA/GLM/SNDK and
these four), DEEPSEEK stays synthetic. The old first-round `marketId`s above are only a start
hint — the bot rolls a new round per pair, so the registry marketId goes stale by design and
is re-derived on restart.

Observed gas price during deploy was **160 wei/gas**, so the whole stack cost ~2.4 gwei of AVAX,
far below the conservative 1 AVAX budget.

### Fuji video walkthrough

`web/playwright.video.fuji.config.mts` records the LP-vault flow against this live stack (no
anvil). It writes `web/.env.local` from `deployment-assets.avalanche-fuji.json`, starts `next dev`,
and signs through the injected testnet bridge.

```powershell
cd web
$env:E2E_TESTNET_RPC="https://avalanche-fuji-c-chain-rpc.publicnode.com"
$env:E2E_BURNER_KEY="0x..."      # funded on Fuji; never committed
npm run test:video:fuji
```

**RPC note:** `api.avax-test.network` returns **403** when a request carries a browser `Origin`,
so it cannot be used as `NEXT_PUBLIC_RPC_URL` for a browser app. Use the CORS-open
`avalanche-fuji-c-chain-rpc.publicnode.com` (or another CORS-enabled Fuji endpoint). Node-side
scripts can keep using `api.avax-test.network`.

Video lands in `web/test-results/*/video.webm`.

### Measured timings (Fuji, 2026-10-21)

Probed against `avalanche-fuji-c-chain-rpc.publicnode.com`:

| Metric | Value |
|---|---|
| Average block time (300-block window) | **1.77 s** |
| Recent 50-block mean | **2.04 s** (1 s timestamp granularity; 2 zero-deltas, max gap 10 s) |
| Submit → receipt (5 × 21k-gas self-transfer) | mean **2.04 s**, median **2.10 s**, min 1.73 s, max 2.16 s |
| Gas price during probe | 160 wei |

So `blockSeconds: 2` in `script/networks.js` is a good (slightly conservative) fit: a 900-block
round is ~27 min, and a 3-block settlement lead (~6 s) comfortably covers ~2 s inclusion.

### Vercel deployment (Fuji)

| Item | Value |
|---|---|
| Project | `irmarket-avax` (team `h-fbf5`), CLI-only |
| Domain | https://avax.irmarket.xyz |
| Root Directory | `.` (the upload root) |
| Framework | Next.js (static export to `out/`) |
| Env | 10 `NEXT_PUBLIC_*` vars in both production and preview scopes |

Because this project's Root Directory is the upload root, **deploy it from `web/`**:

```powershell
cd web
vercel --prod --yes
```

That is the reverse of the Monad `irmarket` project (Root Directory `web`, deployed from the repo
root). The project link lives in `web/.vercel/` (gitignored).

`api.avax-test.network` returns **403** to browser requests (Origin header), so
`NEXT_PUBLIC_RPC_URL` must be a CORS-open endpoint such as
`https://avalanche-fuji-c-chain-rpc.publicnode.com`.

**Market list needs fresh rounds.** `useMarkets` scans `MARKET_LOOKBACK_BLOCKS` (2100 blocks on
Fuji, ~1 h). With no bot running, the last round ages out and the Market tab shows "No markets
yet"; either run the Fuji bot or roll a round with `createMarket`. The vault page keeps working
(it only needs a settled canonical price).

### Bot (Fuji)

Runs on the shared ops server (same box as `tick_book`) as a second systemd unit:

| Item | Value |
|---|---|
| Unit | `irmarket-bot-fuji` (`Restart=always`, enabled at boot) |
| Env | `BOT_ENV_FILE=<repo>/bot/.env.fuji` |
| Registry | `deployment-assets.avalanche-fuji.json` |
| Logs | `run-fuji.log` (stdout) / `run-fuji.err.log` (bot logs) |
| Wallet | `0xF5Cf…` — same address as the Fuji deployer |

`bot/verifier.py` honors `BOT_ENV_FILE` (default `bot/.env`); that is what lets two units share one
checkout and one venv. The Monad unit is unchanged and still loads `bot/.env`.





