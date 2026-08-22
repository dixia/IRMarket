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

**Project:** `irmarket` (h-fbf5/irmarket)
**Custom domain:** https://www.irmarket.xyz
**Root Directory:** `web`

### Prerequisites

- `web/.env.local` with `NEXT_PUBLIC_*` vars (see `web/.env.local.example`)
- Vercel CLI authenticated (`npx vercel login`)

### 1. Link project (one-time)

```bash
cd web
npx vercel link --yes --project irmarket
```

Creates `.vercel/project.json` in `web/`. **Do NOT create `.vercel` in the repo root** — it overrides the `web` root directory setting and causes "Root Directory does not exist" errors.

### 2. Deploy

```bash
npx vercel --prod --yes
```

Run from the **repo root**, not from `web/`.

### 3. Verify

- Production: https://irmarket.xyz
- Inspect: https://vercel.com/h-fbf5/irmarket