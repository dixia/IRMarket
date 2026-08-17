# IRMarket

An option market on any priced asset — A-share stocks, Labubu, whatever has a price.
Built on the **Monad** blockchain on top of the **Monoracle** veto-arbitrage primitive:
settlement prices are enforced by bilateral collateral and permissionless on-chain arbitrage.
No off-chain data feeds, no validators.

> **Status:** PRD v0.6 confirmed (`docs/prd.md`) — entering development.

## How It Works

- **Price basis:** every reference/settlement price comes from the Monoracle primitive —
  a provider posts a quote with bilateral collateral (base + quote token), then any
  permissionless actor can veto-arbitrage it during a ~600ms verification window; if it
  survives, `getLatestPrice` returns the canonical price. No off-chain feeds.
- **Markets:** anyone can open an option market on any priced asset. Demo underlying:
  (**LLM**, 6658), settled in a test **HKD** token.
- **Trading:** users pick **call / put**, invest HKD, and get position units
  (`investment ÷ open reference price`). A ~1% spread is charged as implicit fees.
- **Expiry:** default **3 minutes** (≈600 blocks), selectable in UI. No liquidation,
  no margin calls — max loss is the principal.
- **Close & settle:** early reverse close anytime against the provider pool; at expiry the
  bot auto-settles. Payout is a **linear spread PNL** — call: `(settle − open) × units`,
  put inverted — capped at principal.
- **Low barrier:** real derivative markets are gated by high minimums — A-share options, for
  example, need tens of thousands of RMB per contract. IRMarket drops that to cents, so anyone
  can use long/short derivatives for price discovery with a tiny amount.

## Getting Started

### Prerequisites

- **Node.js** ≥ 18
- **Python** ≥ 3.10
- A wallet with Monad testnet MON (get from [Monad faucet](https://testnet.monad.xyz))

### 1. Smart Contract

```bash
npm install
npx hardhat compile
npx hardhat test
# deploy: npx hardhat run script/deploy.js --network monadTestnet
```

### 2. Verification Bot (Python)

```bash
cd bot
pip install -r requirements.txt
cp .env.example .env
python verifier.py
```

### 3. Frontend

```bash
cd web
npm install
npx next dev -p 3000
```

## Network

| Network | Chain ID | RPC |
|---|---|---|
| Monad Testnet | 10143 | `https://testnet-rpc.monad.xyz` |
| Monad Mainnet | 143 | `https://rpc.monad.xyz` |

## Monoracle dependency (referenced)

IRMarket builds on the **Monoracle** veto-arbitrage primitive. The contract source is **not
vendored** into this repo — it is referenced from the upstream project
(`github.com/dixia/monoracle`). Only the Monoracle ABI is copied here (`abi/Monoracle.abi.json`)
so the frontend and bot can interface with the deployed settlement oracle.

- **Monoracle source (upstream):** `github.com/dixia/monoracle` → `contracts/Monoracle.sol`
- **Monoracle settlement contract (Monad testnet):** `0x1ABABc60Ca6950C94eA80F2f611AB06aAAAD28c0`
- To refresh the ABI: copy from `monoracle/artifacts/contracts/Monoracle.sol/Monoracle.json`
  into `abi/Monoracle.abi.json`.

## Project Structure

```
IRMarket/
├── contracts/          # Solidity contracts (option market + mocks)
│   └── IRMarket.sol    # Option market core (WIP)
├── abi/                # Interface ABIs (Monoracle referenced upstream, ABI only)
├── test/               # Hardhat test suite
├── script/             # Deploy / demo / test scripts
├── bot/                # Python market-making / settlement bot
├── web/                # Next.js frontend dapp
├── hardhat.config.js
├── docs/prd.md         # Product requirement + UI design (v0.6, canonical)
├── requirement.md      # Software requirements document
├── tech-spec.md        # Technical specification
└── README.md
```

---

# 中文

## 简介

**IRMarket** 是一个任意有价格的资产（A 股、Labubu 等）都可以做标的的期权市场，
部署在 **Monad** 区块链上，构建于 **Monoracle** 的否决-套利原语之上：结算价格由双边抵押品与
无许可链上套利保证——不需要链下数据源，也不需要验证节点。

> **状态：** PRD v0.6 已定稿（`docs/prd.md`），进入开发阶段。

## 运行机制

- **价格基准**：所有参考价 / 结算价均来自 Monoracle 原语——provider 以双边抵押（base+quote 两种代币）
  提交报价，验证窗口（约 600ms）内任何人均可对照真实行情进行否决套利；无人否决则 `getLatestPrice`
  返回该 canonical 价格。无链下数据源。
- **开市**：任何人都可以为任意有价格的资产创建期权市场。Demo 标的：溜溜梅（**LLM**，06658.HK），
  以测试币 **HKD** 计价结算。
- **交易**：用户选择**看涨 / 看跌**、投入 HKD，即得持仓份数（投入 ÷ 开仓参考价）。约 1% 升水
  以买卖价差形式隐性收取费用。
- **到期**：默认 **3 分钟**（≈600 blocks），UI 可选其它期限。无爆仓、无保证金追缴，最大亏损即本金。
- **平仓与结算**：到期前可随时反向平仓（对手方 = provider 资金池）；到期由 bot 自动结算。
  盈亏为**线性差价 PNL**——看涨 `(结算价 − 开仓价) × 份数`，看跌相反，封顶本金。
- **低门槛**：现实衍生品市场门槛极高——比如 A 股期权一张合约动辄十万元本金；IRMarket 把这个门槛
  降到几分钱，小额即可用做多/做空衍生品参与价格发现。

## 快速开始

### 前置条件

- **Node.js** ≥ 18
- **Python** ≥ 3.10
- 一个持有 Monad 测试网 MON 的钱包（可通过 [Monad 水龙头](https://testnet.monad.xyz) 获取）

### 1. 智能合约

```bash
npm install
npx hardhat compile
npx hardhat test
# 部署：npx hardhat run script/deploy.js --network monadTestnet
```

### 2. 验证机器人（Python）

```bash
cd bot
pip install -r requirements.txt
cp .env.example .env
python verifier.py
```

### 3. 前端

```bash
cd web
npm install
npx next dev -p 3000
```

## 网络

| 网络 | 链 ID | RPC |
|---|---|---|
| Monad 测试网 | 10143 | `https://testnet-rpc.monad.xyz` |
| Monad 主网 | 143 | `https://rpc.monad.xyz` |
