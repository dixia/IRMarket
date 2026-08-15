# IRMarket — Deployment & Release Workflow

## Remote setup

(TODO — remote name, URL, visibility)

## Daily development

```bash
git add . && git commit -m "..." && git push
```

## Deploy contracts

### Prerequisites

- `.env` file with `PRIVATE_KEY` (with MON testnet balance)
- Optionally set `RPC_URL` and `CHAIN_ID` (defaults: Monad testnet)

### 1. Deploy mock tokens

```bash
node script/deploy-tokens.js
```

### 2. Deploy IRMarket contracts

```bash
node script/deploy.js
```

Saves deployment info to `deployment.json` (gitignored).

### 3. Configure environment

Set the new addresses in `.env`, `bot/.env`, and `web/.env.local`.

### 4. Verify

```bash
npx hardhat test
```

## Vercel (frontend)

(TODO — Vercel project + `NEXT_PUBLIC_*` env vars)