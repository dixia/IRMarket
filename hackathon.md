# IRMarket

**Monad Blitz@北京V2 — Submission**

## English

### One-Liner

Trade call/put options on anything with a price (A-share stocks, Labubu, ...) on Monad — settled by an on-chain veto-arbitrage oracle, no off-chain feeds, no liquidation.

### Problem

Long-tail assets (stocks, collectibles like Labubu) have prices, but there is no on-chain market that lets casual users make a simple directional bet without understanding complex derivatives or trusting a centralized oracle. Off-chain price feeds are not permissionless, and settlement prices can be gamed.

### Solution

IRMarket is an on-chain European-style option market: pick call/put, invest HKD, get position units, and earn a linear spread PNL at expiry. No margin calls, max loss = principal. Settlement prices come from the Monoracle veto-arbitrage primitive: a provider posts quotes with bilateral collateral, anyone can permissionlessly arbitrage mispriced quotes within a ~600ms verification window, and surviving quotes become the canonical price. Price integrity is enforced by collateral and arbitrage, not by validators or data feeds.

### How It Works

- Price: Monoracle getLatestPrice — canonical price enforced by bilateral collateral and permissionless veto arbitration
- Markets: anyone opens a market on any priced asset; demo underlying = 溜溜梅 LLM (06658.HK), settled in test HKD
- Trade: call/put with ~1% spread, default 3-minute expiry
- Close & settle: reverse close anytime against the provider pool; bot auto-settles at expiry — linear PNL capped at principal
- No liquidation, no margin calls

### Why Monad

~300ms block time with 2-slot finality gives a ~600ms verification window — fast enough for a snappy 3-minute option lifecycle. High-performance EVM keeps the whole quote - arbitrage - settle loop on-chain and permissionless.

### Tech Stack

- **Solidity ^0.8.20** — Smart contract
- **Hardhat** — Development, testing, deployment
- **Python** — Market-making / settlement bot
- **Next.js** — Frontend dapp
- **Monad Testnet** — Deployment target

---

## 中文

### 一句话简介

在 Monad 上，任何有价格的资产（A 股、Labubu 等）都能交易看涨/看跌期权——结算价由链上否决-套利预言机保证，无链下数据源、无爆仓。

### 问题

长尾资产（股票、潮玩 Labubu 等）都有价格，却没有让普通用户做简单方向判断的链上市场：要么不懂复杂衍生品，要么被迫信任中心化预言机。链下价格源不可免许可，结算价也可能被操纵。

### 解决方案

IRMarket 是链上欧式期权市场：选择看涨/看跌，投入 HKD 即得持仓份数，到期按线性差价 PNL 兑付,无追缴、最大亏损即本金。结算价来自 Monoracle 否决-套利原语：provider 以双边抵押提交报价，验证窗口（约 600ms）内任何人都可以免许可否决套利错误报价，未被否决者成为 canonical 价格。价格可信度由抵押品和套利约束，而非验证者或数据源。

### 运行原理

- 价格：Monoracle getLatestPrice —— 双边抵押 + 免许可否决套利约束的 canonical 价格
- 开市：任何人为任意有价格资产开市场；Demo 标的 = 溜溜梅 LLM（06658.HK），以测试币 HKD 结算
- 交易：看涨/看跌，约 1% 升水，默认 3 分钟到期
- 平仓与结算：到期前随时反向平仓（provider 资金池接盘）；到期 bot 自动结算 —— 线性 PNL 封顶本金
- 无爆仓、无保证金追缴

### 为什么选择 Monad

约 300ms 出块 + 2-slot finality 提供约 600ms 验证窗口，足以支撑流畅的 3 分钟期权完整生命周期。高性能 EVM 让「报价 → 仲裁 → 结算」整条链路都在链上且免许可。

### 技术栈

- **Solidity ^0.8.20** — 智能合约
- **Hardhat** — 开发、测试、部署框架
- **Python** — 做市 / 结算机器人
- **Next.js** — 前端
- **Monad Testnet** — 部署目标网络

### Demo Frontend

https://irmarket-g6pflvq3o-h-fbf5.vercel.app