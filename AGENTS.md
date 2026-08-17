<!-- BEGIN:workflow-rules -->
# Workflow Rules

## Push policy
Do not auto-push. Only push when the user explicitly asks to commit/push.
<!-- END:workflow-rules -->

## Project Context

**IRMarket** is an exotic option market on any priced asset (e.g., A-share stocks, Labubu)
built on the **Monad** blockchain. It builds on the **Monoracle** veto-arbitrage primitive:
every settlement price is enforced by bilateral collateral and permissionless on-chain
arbitrage — no off-chain data feeds, no validators.

This repo build on top of the Monoracle project (`github.com/dixia/monoracle`).

## Layout

| Path | Purpose |
|------|---------|
| `contracts/` | Solidity contracts (option market + mocks) |
| `script/` | Deploy / demo / test scripts |
| `test/` | Hardhat test suite |
| `bot/` | Python verification/settlement bot |
| `web/` | Next.js frontend dapp |
| `docs/` | Workflows + DeltaV records (some gitignored) |
| `plan/` | Roadmap |
| `product/` | Product analysis, USP, comparisons (GTM.md gitignored) |



## Commands

```bash
npm install        # Hardhat deps (repo root)
npx hardhat test   # run contract tests
python -m venv bot/.venv && bot/.venv/Scripts/pip install -r bot/requirements.txt  # bot env
cd web && npm install && npx next dev -p 3000  # frontend
```

## Project Conventions

### Architecture at a glance
Monad veto-arbitrage 长/短市场：
- 长 = `vetoUnderpriced`（付 HKD 收 LLM），短 = `vetoOverpriced`；多空 = Monoracle veto 方向，勿用传统订单簿语义。
- `contracts/MonoracleWindowed.sol` = 上游 Monoracle 的分叉（per-quote `expiryBlock`，验证窗口 = 期权到期，已取代 2-slot 假设；勿再引入上游 Monoracle 全文）。**已废弃，见 `TODO.md`**。
- `contracts/IRMarket.sol` = 1% HKD fee wrapper：`openLong/openShort(marketId, quoteId)`。

### Commit & hygiene
- 提交前必扫硬编码密钥（`rg` hex `0x…{40}`、`PRIVATE_KEY`）；密钥只从 env 读取，禁止拼接/硬编码。
- 提交 message 须基于 `git diff`/`rg` 核对的真实改动，勿凭文件名臆测。
- 仓库文件禁写本机绝对路径（`C:\Users\iamh4\…`），统一用 `github.com/dixia/…` 引用。
- 不自动 push，用户明确要求才 push。

### Monad testnet
- `eth_getLogs` 有约 100 区块范围上限，历史事件查询必须分块（5000 块回看 = 50 个 100 块窗口）。`usePositions` 曾因 `fromBlock:0→latest` 被 RPC 拒绝 + `.catch(()=>[])` 吞错而静默空白；初版 25000 块串行超时，最终方案 = 5000 块 + `Promise.all` 并行、15s 轮询。
- 持仓由 `VetoWrapped`/`QuoteVetoed` 事件派生，无独立账本。
- 合约已部署 Monad 测试网，地址见根目录 `deployment.json`；bot 用 `0xF5Cf…` 钱包。

### Frontend (web/)
- `NEXT_PUBLIC_*` 必须字面量引用（Turbopack 只内联字面量，动态 `env[key]` 在浏览器为 `""`，导致配置探测失败）。
- wagmi 水合不一致需 `useHydrated` 钩子。
- 合约价格为 1e18 固定点，显示需除以 1e18；一律走 `formatPrice`/`formatPnl`（`web/src/lib/format.ts`），勿直接用 `toNumberString(price, 6)`。
- 函数 selector 用 ethers 现算，勿手写。
- 本地 env 在 `web/.env.local`（gitignored）；Vercel 部署需在 `web/` 目录执行 `vercel --prod`。
- 改动后先 `tsc`+`lint`+`build` 再部署；Vercel 链上 chunk 验证耗时，先本地验证。

### Bot (bot/verifier.py)
- 引号按轮次归属：quote/settle/restock 必须按 `expiryBlock == market.expiryBlock` 过滤，禁止只按交易对匹配（曾因只按 pair 把活跃轮引号当到期引号 settle 而崩溃）。
- 运行：`bot\.venv\Scripts\python.exe bot\verifier.py`（前台窗口可见）；清后台进程须按 CommandLine 匹配 `verifier`，勿凭 exe 名误杀。
- web3 v7 异常为 `Web3RPCError`（非 `ValueError`），nonce 竞争需 `except Exception` 后重新读取 nonce。
- `load_dotenv()` 默认不覆盖已有环境变量；用 `$env:MARKET_ID=n`（PowerShell）可覆盖 `bot/.env` 验证不同轮次。
- 解码事件勿用 `process_receipt`（对收据中 ERC20 Transfer 等日志报 `MismatchedABI` 噪声）；按 oracle 地址 + topic0 定向抽取（`_oracle_event_id`/`_market_created_id`）。

### Deployment
- 合约部署入口 `script/deploy.js`，地址结果写入 `deployment.json`，web 依赖根 env 示例。

### TODO tracking
- `TODO.md` is **only an index**: each item = one GH issue link + status (OPEN/DONE/blocked).
- 详情一律写进 GH issue body（`gh issue create -R dixia/IRMarket`）；`TODO.md` 不放细节。
- 新事项：先开 GH issue，再在 `TODO.md` 加一行引用；完成时更新 issue 状态并同步那一行。

## Monad Reference Docs

For Monad-specific details (architecture, async/parallel execution, gas model,
block states, EIP-7702, RPC endpoints, tooling), consult the full LLM-friendly
Monad docs index: https://docs.monad.xyz/llms-full.txt

## Submission docs

`hackathon.md` is the Mojo submission (has been submitted for BJ Blitz Hack@v2 and no need to update for now) doc and does **not** support complex markdown.