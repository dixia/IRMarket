# IRMarket

**Monad Blitz@北京V2 — Submission**

## English

### One-Liner

A permissionless binary options market on Monad — short A-shares, short Labubu, short anything with a price. No off-chain oracles, no liquidation, max loss = principal.

### Problem

Many assets can't be shorted — investors can only go long, which rewards blind optimism and punishes rational judgment. Bubbles inflate and price discovery breaks down; shorting is what keeps price discovery honest. Off-chain price feeds aren't permissionless, and centralized settlement can be gamed.

### Solution

IRMarket is a permissionless binary options market on Monad. Anyone can list a market on any priced asset — A-share stocks, Labubu, whatever. Pick call or put, invest HKD, get position units instantly. Payout is a linear spread PNL at expiry — no margin calls, no liquidation, max loss = principal. Default 3-minute expiry, reverse-close anytime. Settlement prices are enforced on-chain by collateral and permissionless arbitrage — no off-chain data feeds, no trusted validators.

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

Monad 上的免许可二元期权市场——可以做空 A 股、做空 Labubu、做空任何有价格的资产。无链下预言机、无爆仓、最大亏损即本金。

### 问题

许多资产无法做空 —— 投资者只能做多，市场只奖励盲目乐观、惩罚理性判断，泡沫越吹越大，价格发现失灵。做空让价格发现回归有效。链下价格源不免许可，中心化结算也可能被操纵。

### 解决方案

IRMarket 是 Monad 上的免许可二元期权市场。任何人都可以为任意有价格的资产（A 股、Labubu 等）创建市场。选择看涨/看跌，投入 HKD 即得持仓份数，到期按线性差价 PNL 兑付——无追缴、无爆仓、最大亏损即本金。默认 3 分钟到期，到期前随时反向平仓。结算价由链上抵押品与免许可套利保证——无链下数据源、无需信任验证节点。

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

https://irmarket-h-fbf5.vercel.app