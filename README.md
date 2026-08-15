# IRMarket

An exotic option market on any priced asset — A-share stocks, Labubu, whatever has a price.
Built on the **Monad** blockchain on top of the **Monoracle** veto-arbitrage primitive: settlement
prices are enforced by bilateral collateral and permissionless on-chain arbitrage. No off-chain
data feeds, no validators.

> **Status:** Scaffold — structure mirrors the Monoracle project. Product requirement analysis in progress.

## How It Works

(TODO: describe the option market flow — quoting, collateral, settlement via Monoracle)

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
│   └── IRMarket.sol    # Exotic option market (WIP)
├── abi/                # Interface ABIs (Monoracle referenced upstream, ABI only)
├── test/               # Hardhat test suite
├── script/             # Deploy / demo / test scripts
├── bot/                # Python verification/settlement bot
├── web/                # Next.js frontend dapp
├── hardhat.config.js
├── requirement.md      # Software requirements document
├── tech-spec.md        # Technical specification
└── README.md
```

---

# 中文

## 简介

**IRMarket** 是一个奇异性期权市场，任意有价格的资产（A 股、Labubu 等）都可以做标的，
部署在 **Monad** 区块链上，构建于 **Monoracle** 的否决-套利原语之上：结算价格由双边抵押品与
无许可链上套利保证——不需要链下数据源，也不需要验证节点。

> **状态：** 脚手架——目录与文档结构镜像 Monoracle 项目。产品需求分析进行中。

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