# IRMarket

An option market on any priced asset — A-share stocks, Labubu, whatever has a price.
Built on top of the **Monoracle** veto-arbitrage primitive:
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
- **Monoracle settlement contract (Monad testnet):** lazy-settlement deployment
  `0x0BC36e1ac475AdEF75F102deb1708BE6E45aA16f` (canonical price is derived at read time).
  IRMarket's production wrapper/vault still bind the pre-lazy deployment
  `0x807321100748d75a618e508de214123CB77C9f4D` until the re-point in #23's ops follow-up;
  the older `0x151286e6…` / `0x1ABABc60…` deployments stay live.
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
