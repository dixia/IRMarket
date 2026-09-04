# Cluster B — Bot

**Area:** `bot/`
**Owner:** Python verifier / settlement bot

## Goal
Keep the IRMarket verifier bot reliable on Monad testnet: quoting, veto handling, settlement, and market creation.

## Scope
- `bot/verifier.py` — main bot loop
- `bot/.env.example` — configuration reference
- `bot/requirements.txt` — Python deps
- On-chain monitoring (veto events, quote states)

## Tasks
1. Review bot logs from the latest testnet run (`docs/liverun/testnet/`).
2. Fix any quoting / settlement / restock bugs.
3. Add or update bot-level tests if applicable.
4. Ensure `.env.example` matches actual config keys.

## STOP condition
- Bot crashes with an unhandled exception and the root cause requires contract changes (escalate to Cluster C).
- Web3.py / RPC behavior changed and you need upstream clarification.

## Commit
```
fix(bot): <describe the fix or improvement>
```
