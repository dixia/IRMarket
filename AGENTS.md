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
| `docs/` | Design docs, product docs, workflows, DeltaV records (some gitignored) |
| `docs/product/` | Product requirements (PRD), demo scripts, work logs |
| `docs/design/` | Smart contract tech spec, web tech design |
| `docs/design/lp-pool-tech-spec.md` | **LP 资金池设计（V1.0 draft）**：目标设计 + §1.4 MVP 范围与已接受风险（**MVP 已实现并收口**，§15.1 含 close-out）；vault / capped linear payoff / 风控参数 / PriceAdapter |
| `docs/design/lp-pool-frontend-design.md` | **LP pool 前端 design & as-built spec（web/）**：hooks / 数据层坑（Multicall3、Monoracle ABI 顺序、useTokenMeta 占位地址）/ UI 面 / 测试与视频命令 / 已部署地址 |

> ⚠️ 两套语义勿混用：**V0.9 veto-market**（已部署；Monoracle 既是价格也是撮合场所，交易 = veto，
> bot 双边抵押当对手方，**无资金池**）与 **LP pool MVP**（已实现：`contracts/IRMarketVault.sol`；
> Monoracle **只做价格**，交易 = vault 持仓，池子做对手方）。不要在同一笔持仓里混用，也不要让 vault
> 用它自己提交的报价结算。
>
> 🧭 **未来模型（已确认方向，详见 `docs/architecture.md` §7；本文仅约法）**：oracle 世界保持免许可
> （任何人可对任何 pair 报价/仲裁）；IRMarket 只做**精选 pair** 的展示层（前端白名单，
> `NEXT_PUBLIC_SELECTED_BASE_TOKENS`）；**每个精选 pair 独立 `IRMarketVault`**（MVP 仅 NVDA 一个），
> LP 只能存该 pair 的 vault。硬规则：① IRMarket 侧脚本**永不部署 Monoracle**——oracle 是消费输入
> （`ORACLE_ADDRESS` 必填，A-shape 指纹门禁，见 `script/deploy-market-stack.js`）；② oracle 绑定
> immutable ⇒ 换 oracle = 重部署 wrapper/vault，绝不改 ABI；③ 测试代币是注册表
> （`deployment-assets.json`）——按 symbol 复用 + mint 补充（`script/mint-demo-tokens.js`），**永不重部署**；
> ④ 结算永远只分割**开仓时已托管**的资金，不存在事后追债（详见 architecture.md §5）。



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
- `contracts/IRMarket.sol` = 1% HKD fee wrapper：`openLong/openShort(marketId, quoteId)`。
- 上游 `Monoracle.sol`（`github.com/dixia/monoracle`）提供 quoting + veto + settlement；本 repo 不 vendoring 上游代码，仅通过 `contracts/IMonoracle.sol` 接口调用。

### Commit & hygiene
- 提交前必扫硬编码密钥（`rg` hex `0x…{40}`、`PRIVATE_KEY`）；密钥只从 env 读取，禁止拼接/硬编码。
- 提交 message 须基于 `git diff`/`rg` 核对的真实改动，勿凭文件名臆测。
- 仓库文件禁写本机绝对路径（`C:\Users\iamh4\…`），统一用 `github.com/dixia/…` 引用。
- 不自动 push，用户明确要求才 push。

### Merge flow (protected `main`)
- `main` 受保护：禁止直推；每个改动走 PR，必需检查 `contracts` / `web` / `bot`，且分支必须与 `main` 同步（strict）。
- 合并方式只有 **squash**；合并后自动删分支。`gh pr merge <n> --auto --squash`。
- 一次只合一个 PR；其余分支在每次合并后 rebase 到新 `main`。冲突在 **feature 分支** 解决，勿在 `main` 上解决。
- 不把长期 staging 分支合进 `main`（staging 分支 ≠ staging 环境；registry 共享且上链）。
- 完整流程与回滚/发布约定：`docs/workflows/git-merge-procedure.md`。

### Long-running commands (agent session hygiene)
- 预计 **> ~60–90s** 的命令（playwright/e2e/视频套件、`next build`、`hardhat test`、合约部署、Vercel build）**禁止用单次前台 tool call 挂满大 timeout**：会话表现为"卡死"，协作者只能手动催。
- 正确姿势：`Start-Process … -WindowStyle Hidden -RedirectStandardOutput/-RedirectStandardError <log>` 后台化跑，然后**短轮询**（每次 sleep 2–5s，一次 ≤ ~90s）读日志文件判断进度/完成，并在轮询之间向协作者播报中间状态；完成后再做收尾。
- 跑完后台栈后清理残留进程（dev server / anvil / bot），按 `CommandLine` 匹配 kill，勿凭 exe 名误杀。
- 短命令（< ~60s）仍可直接前台执行。

### Monad testnet
- `eth_getLogs` 有约 100 区块范围上限，历史事件查询必须分块（5000 块回看 = 50 个 100 块窗口）。`usePositions` 曾因 `fromBlock:0→latest` 被 RPC 拒绝 + `.catch(()=>[])` 吞错而静默空白；初版 25000 块串行超时，最终方案 = 5000 块 + `Promise.all` 并行、15s 轮询。
- 持仓由 `VetoWrapped`/`QuoteVetoed` 事件派生，无独立账本。
- 合约已部署 Monad 测试网，地址见根目录 `deployment.monad-testnet.json`；bot 用 `0xF5Cf…` 钱包。

### Frontend (web/)
- `NEXT_PUBLIC_*` 必须字面量引用（Turbopack 只内联字面量，动态 `env[key]` 在浏览器为 `""`，导致配置探测失败）。
- wagmi 水合不一致需 `useHydrated` 钩子。
- 合约价格为 1e18 固定点，显示需除以 1e18；一律走 `formatPrice`/`formatPnl`（`web/src/lib/format.ts`），勿直接用 `toNumberString(price, 6)`。
- 函数 selector 用 ethers 现算，勿手写。
- 本地 env 在 `web/.env.local`（gitignored）。
- 改动后先 `tsc`+`lint`+`build` 再部署；Vercel 链上 chunk 验证耗时，先本地验证。
- Vercel 项目 `irmarket`（h-fbf5），域名 `irmarket.xyz`。**从 repo root 部署**（`npx vercel --yes` 预览 / `npx vercel --prod --yes` 生产）。项目 Root Directory（dashboard 设定）= `web`，它是**相对上传内容**解析的 build 设置：从 root 部署时上传里存在 `web/` 子目录 → build 正常；从 `web/` 里运行 CLI 会让上传根变成 web 的内容，`web/` 于是不存在 → 报 `Root Directory "web" does not exist`（实测，2026-10-17）。
- **Avalanche Fuji 项目 `irmarket-avax`（h-fbf5，域名 `avax.irmarket.xyz`）**：独立项目、CLI-only，**从 `web/` 部署**（`cd web && npx vercel --prod --yes`）。它的 Root Directory = `.`（上传根），与上面的 `irmarket` 相反。env 全为 Fuji：`NEXT_PUBLIC_CHAIN_ID=43113`、`NEXT_PUBLIC_RPC_URL` 必须 CORS-open（`api.avax-test.network` 带 Origin 返回 403；用 `avalanche-fuji-c-chain-rpc.publicnode.com`）。`web/vercel.json` 固定 `framework: nextjs`（静态导出 `out/`）。Market 列表只扫 `MARKET_LOOKBACK_BLOCKS`（Fuji 2100 块 ≈ 1h），无 bot 时常跑轮次会老化 → 需跑 Fuji bot 或手动 roll 一轮。
- repo root 的 `.vercel/project.json` 是 root-side 部署的 CLI link，gitignored（`.gitignore:53`）；缺失时用 `npx vercel link --project irmarket --yes` 重建。repo-root `.vercelignore`（`e83b56f`）保持上传精简并排除 `.env*`/`bot/`/`test/`/`docs/`/`node_modules`——本地 env 文件永不上传。
- 新增/修改 `NEXT_PUBLIC_*`（如 `NEXT_PUBLIC_VAULT_ADDRESS`）：`"<value>" | npx vercel env add <NAME> <scope>`（scope = `production` / `preview`；从任意已 link 目录执行均可）；改后必须对该 scope 重新部署，值才会内联进客户端 chunk。要不动生产就先在 **Preview** scope 验证。

### Bot (bot/verifier.py)
- 引号按轮次归属：quote/settle/restock 必须按 `expiryBlock == market.expiryBlock` 过滤，禁止只按交易对匹配（曾因只按 pair 把活跃轮引号当到期引号 settle 而崩溃）。
- 运行：`bot\.venv\Scripts\python.exe bot\verifier.py`（前台窗口可见）；清后台进程须按 CommandLine 匹配 `verifier`，勿凭 exe 名误杀。
- web3 v7 异常为 `Web3RPCError`（非 `ValueError`），nonce 竞争需 `except Exception` 后重新读取 nonce。
- `load_dotenv()` 默认不覆盖已有环境变量；用 `$env:MARKET_ID=n`（PowerShell）可覆盖 `bot/.env` 验证不同轮次。
- 解码事件勿用 `process_receipt`（对收据中 ERC20 Transfer 等日志报 `MismatchedABI` 噪声）；按 oracle 地址 + topic0 定向抽取（`_oracle_event_id`/`_market_created_id`）。
- **远程部署**：生产 bot 以 systemd 服务常驻在共享 ops 服务器（与 `tick_book` 同机），`Restart=always` 随崩溃自动重启、开机自启；服务器上按仓库布局放置（`bot/verifier.py` + `abi/` + hardhat `artifacts/` + `deployment-assets.<slug>.json` + `bot/.env`）。**同一钱包只跑一个实例**——服务器侧在跑时本地不要再起（nonce 竞争）。多链时该规则按链分别成立：不同链可用同一钱包，同链不可双开。`EXPECTED_CHAIN_ID` 保持可选（服务器 `.env` 未设置），设置后 bot 会在启动时校验 RPC 链与 registry 链。**每链一个 unit**：`irmarket-bot`（Monad，读 `bot/.env`）与 `irmarket-bot-fuji`（Fuji，`Environment=BOT_ENV_FILE=<repo>/bot/.env.fuji`）；`BOT_ENV_FILE` 未设置时回退 `bot/.env`，因此旧部署与 `scripts/ops/run_testnet_live.sh` 行为不变。服务器的连接方式 / 路径 / 密钥不在本 repo（public）记录，见 `tick_book` 仓库的 ops 文档。

### Deployment
- 合约部署入口 `script/deploy.js`（V0.9）与 `script/deploy-market-stack.js`（生产 stack，消费上游
  oracle），地址结果写入 chain-scoped registry（见下节）。
- **多链（per-chain registry）**：脚本通过 `script/networks.js` 解析链参数（slug / blockSeconds /
  explorer / native symbol）。registry 文件按链命名：
  `deployment.<slug>.json` / `deployment-assets.<slug>.json` / `deployment-vault.<slug>.json`
  （如 `deployment.avalanche-fuji.json`）。旧的无后缀文件名仅作**只读兼容**，不再写入。
- **硬规则①**：绝不消费 `chainId` 与本次目标链不一致的 registry——跨链复用地址会把 `mint()` 打到
  错链合约上（`script/stack-reuse.js` 的 `sameChain()`；`bot/verifier.py` 的链断言）。
- **硬规则②**：IRMarket 侧脚本永不部署 Monoracle；先把上游 oracle 部署到目标链并过 A-shape 指纹门禁
  （`script/deploy-market-stack.js` / `script/oracle-doctor.js`）。
- **每链独立 env**：`bot/.env.monad`、`bot/.env.fuji`（`BOT_ENV_FILE` 选择）；`EXPECTED_CHAIN_ID`
  可选，但一旦设置即强制校验。前端 `NEXT_PUBLIC_EXPLORER_BASE` 可按链覆盖，默认取
  `script/networks.js` 同表的 chain explorer。
- 当前链参数表：Monad testnet `10143`（0.3s/block）、Avalanche Fuji `43113`（~2s/block）、
  anvil `31337`。新链先在 `script/networks.js` + `web/src/lib/chainParams.ts` 登记，再部署。
- Monad 与 Fuji 共用同一份 `bot/verifier.py`、不同 `.env`——现在靠 `BOT_ENV_FILE` 区分。以后重启任一服务前确认这个变量还在，否则会重现 nonce 冲突。

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
