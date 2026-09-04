# Cluster I — Infra

**Area:** `script/`, `deployment.json`, `web/.env*`, CI
**Owner:** DevOps / deployment / config

## Goal
Keep IRMarket deployment, configuration, and operational scripts reliable.

## Scope
- `script/deploy.js` — contract deployment
- `deployment.json` — live addresses
- `web/.env.local`, `web/.env.example` — frontend config
- `docs/deploy.md`, `docs/liverun/` — runbooks
- `scripts/ops/` — testnet live run, health checks, monitoring

## Tasks
1. Review deployment issues (failed txs, wrong addresses, env drift).
2. Update `deployment.json` after any new contract deployment.
3. Ensure `NEXT_PUBLIC_*` vars are literal strings (Turbopack requirement).
4. Run deployment scripts on testnet and verify.

## STOP condition
- Deployment fails due to contract revert (escalate to Cluster C).
- Monad testnet RPC is down and blocks verification.

## Commit
```
fix(infra): <describe the fix or improvement>
```
