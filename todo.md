# TODO

_Tracking convention: this file is only an index — each item references a GH issue
(+ status). Details live in the issue body, not here. See AGENTS.md "TODO tracking"._

## Migrate `MonoracleWindowed.sol` to latest upstream Monoracle (CWV-01)

- GH: https://github.com/dixia/IRMarket/issues/2
- Status: **DONE** — upstream `github.com/dixia/monoracle` merged per-quote `expiryBlock`; replaced fork with `IMonoracle.sol` + upstream `Monoracle.json` artifact; added `contracts/test/MonoracleMock.sol` for Hardhat tests.

## LP vault: settlement/capital-flow model — unresolved concerns (parked, revisit before V1)

- GH: https://github.com/dixia/IRMarket/issues/9
- Status: **OPEN — blocked/parked** (deliberate; not blocking P5 migration or demo)

## V1 feature: market-priced option premium for the LP vault (BSM: spec + probe + backtest done on PR #10; implementation open)

- GH: https://github.com/dixia/IRMarket/issues/11
- Status: **OPEN** — spec/tools complete; implementation awaits post-judging review (planned first task of the V0.1 board)

## One market per pair (Option B): stop per-round createMarket; rounds keyed by quote expiry

- GH: https://github.com/dixia/IRMarket/issues/12
- Plan: `docs/plan/one-market-per-pair-plan.md`
- Status: **TODO** — plan complete (**Not started**); implementation pending.

## Merge the real price-feed change (`feat/real-price-feed` → `main`)

- GH: https://github.com/dixia/IRMarket/issues/13
- Spec: `docs/design/bot-real-price-feed-spec.md` (in the `IRMarket-pricefeed` worktree)
- Status: **PR #21 open, MERGEABLE — all checks green; ready to merge.** 11 commits on `feat/real-price-feed` (spec, feed module + wiring, SOXX/descriptors, test marker, outage-halt fix, main merges, Nebius GPU feed from #28, retry throttle + step guard, CI/nits). All review items closed: outage halt policy, retry throttle (1 attempt/TTL), throttled-tick log spam, malformed-row robustness, CI `bot` job (green), Nasdaq market-status logging, nits. Bot suite 54/54; `contracts`/`web`/Vercel green. Remaining: the merge itself. (The `feat/monoracle-upstream` base named in the issue does not exist on the remote; base is `main`.)

## Nebius spot GPU price feed (research + impl)

- GH: https://github.com/dixia/IRMarket/issues/28
- Status: **DONE** — `NebiusSource` (unauthenticated `api.nebius.cloud/billing/v1alpha1/spot-price`, lowest-across-regions or `@region` pin, USD/GPU-hour) implemented on `feat/real-price-feed` (commit `9448a95`, part of PR #21); live-verified against nebius.com/spot-prices; 46/46 tests. Issue closed; merges with PR #21.

## Pilot Envio HyperIndex/HyperSync for web + bot on-chain data layer

- GH: https://github.com/dixia/IRMarket/issues/15
- Status: **OPEN** — from the Oct 2026 competitor/tech scan (`docs/product/competitor-tech-scan-2026-10.md` §2.1). Monad-native HyperSync could replace `usePositions`' chunked `getLogs` and bot historical sweeps; reorg safety included.

## Collateral-sizing audit: Monoracle quote collateral vs manipulation profit

- GH: https://github.com/dixia/IRMarket/issues/14
- Status: **OPEN** — from the Oct 2026 competitor/tech scan (§7.5). UMA 2026 failures show bond security must exceed max extractable profit from a wrong settlement price; verify per-notional-tier sizing and vault-path invariants.

## P2：黑客松资料结构化，搭建「营销素材 ↔ PRD ↔ PPT ↔ Landing」双向内容流水线

- GH: https://github.com/dixia/IRMarket/issues/18
- Status: **OPEN** — 依赖：无（可并行）；输入含 P4（#16）回流的产品/募资信息；输出：机器可读素材库、多 repo 关联链路、PRD、代码化 PPT、内容自动同步机制。

## P3：Landing Page 配置

- GH: https://github.com/dixia/IRMarket/issues/19
- Status: **OPEN** — 依赖：P2（#18）；输出：落地页，可跟随 P2 的 PRD/营销素材自动更新。

## P4：期权定价模型迭代 + 募资策略设计

- GH: https://github.com/dixia/IRMarket/issues/16
- Status: **OPEN** — 依赖：无（独立并行）；输出：期权定价测试结果、产品业务假设、募资叙事、估值逻辑；回流：变更时触发更新 P2（#18）的 PRD/营销文案/Pitch PPT。

## P5：项目管理平台选型 + Agent 任务底座

- GH: https://github.com/dixia/IRMarket/issues/17
- Status: **OPEN** — 依赖：无，优先搭建（底盘）；输出：多项目任务系统、Agent 认领 task、每日自动报告。

## Bot: the mark quote reverts on testnet (delivery latency, wide)

- GH: https://github.com/dixia/IRMarket/issues/22
- Status: **FIXED (code)** — root cause: the bot's loop period (~42–65 blocks on the ops box, each RPC ~1.5 s) exceeded the 2-block submission window, so the closing-price quote was submitted after its own expiry and reverted; measured inclusion latency is 0–2 blocks, so the network was never the bottleneck. Fix: the round's final quote gets its own expiry `E + SETTLEMENT_WINDOW_BLOCKS` (default 60), a fresh trading quote settles right after `E`, the wrapper gates trading at the market expiry, and the loop polls fast near the bell. Merged to `main`; live-verified on the AWS ops box (0 reverted txs; `dt_send_s` 0.52–0.9 s there vs 1.0–3.3 s locally). Plan: `docs/plan/settlement-quote-timing-plan.md`.

## Production cutover: wrapper redeploy (trade gate + right-sized gas)

- GH: https://github.com/dixia/IRMarket/issues/27
- Status: **DONE (2026-10-19)** — `irmarket.xyz` now runs the redeployed wrapper `0x3B08bd1C…` (oracle `0x8073…` unchanged; vault `0x95a7…` and all tokens reused, 15,002 HKD LP equity intact). Ops bot re-pointed + restarted (first line: `create_market=250,000`). Rollback = re-promote the previous production deployment + restore the server's `*.bak-preW2` bot config. Old wrapper `0x39A1…` stays on-chain, dormant.

## Frontend: real-time market data & interaction performance overhaul (P0–P2)

- GH: https://github.com/dixia/IRMarket/issues/29
- Status: **OPEN** — WS push relay + global store (P0-1), RollingNumber (P0-2), fine-grained selectors (P0-3), theme bootstrap + up/down colors (P0-4); P1 optimistic UI / tiered polling / chunk preload / PWA / i18n; P2 session keys / stream origin / docs SSG / brand visuals. No contract changes; relay is a stateless indexer.

## Monoracle lazy/implicit settlement migration (code + production cutover done)

- GH: https://github.com/dixia/IRMarket/issues/23
- Status: **DONE** — mock+tests, bot `settle_round` simplify, backtest dual-mode, docs, ABI refresh, and wrapper/vault re-point to the new oracle `0x0BC3…` landed as PR #24 (`4b2351e`); the production flip is #33.

## Production cutover: run the lazy-settlement oracle on irmarket.xyz

- GH: https://github.com/dixia/IRMarket/issues/33
- Status: **DONE (2026-10-24)** — fresh wrapper `0x05475037…` + vault `0x3d52a82a…` bound to the lazy oracle `0x0BC36e1a…`; tokens + 7 pairs reused, fee recipient = bot `0x5ceF…`. Ops box pulled to `main`, `bot/.env` re-pointed (`GAS_SUBMIT_QUOTE_WEI=366000` — the lazy `submitQuote` needs ~348k) and restarted; Vercel Production+Preview env updated and `irmarket.xyz` redeployed. Rollback = restore the pre-lazy values (`0x3B08bd1C…` / `0x95a74C58…` / `0x80732110…`) in Vercel + the ops `bot/.env` and restart — no contract changes.

## Bot: retire NVDA quoting; add Moutai (600519.SH) A-share feed

- GH: https://github.com/dixia/IRMarket/issues/35
- Status: **OPEN** — `SinaSource`/`TencentSource` now cover `hk|sh|sz` (A-share last price = field 3); `MOUTAI` descriptor + default `ASSETS` (`NVDA` dropped) + web label; `BOT_SKIP_SYMBOLS=NVDA` stops quoting without touching the registry. Live ¥1318.49 both sources; 66/66 bot tests.
