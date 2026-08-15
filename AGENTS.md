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

This repo mirrors the folder/document structure of the Monoracle project
(`github.com/dixia/monoracle`) as the reference scaffold.

## Layout

| Path | Purpose |
|------|---------|
| `contracts/` | Solidity contracts (option market + mocks) |
| `script/` | Deploy / demo / test scripts |
| `test/` | Hardhat test suite |
| `bot/` | Python verification/settlement bot |
| `web/` | Next.js frontend dapp |
| `docs/` | Workflows + DeltaV records (some gitignored) |
| `plan/` | Roadmap |
| `product/` | Product analysis, USP, comparisons (GTM.md gitignored) |

## Submission docs

`hackathon.md` is the Mojo submission doc and does **not** support complex markdown. Keep it
plain: simple `#`/`##` headings, **bold**, and `-` bullet lists only — no tables, fenced code
blocks, blockquotes, images, or HTML.

## Commands

```bash
npm install        # Hardhat deps (repo root)
npx hardhat test   # run contract tests
python -m venv bot/.venv && bot/.venv/Scripts/pip install -r bot/requirements.txt  # bot env
cd web && npm install && npx next dev -p 3000  # frontend
```