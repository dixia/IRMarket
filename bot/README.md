# IRMarket Bot

> Market-maker & settlement bot for IRMarket on the MonoracleWindowed veto-arbitrage
> primitive (V0.9 Veto-Market, docs/sc-tech-spec.md §5.1/§8.2).

## Quick Start

```bash
# Install dependencies
py -m venv .venv && .venv/Scripts/pip install -r requirements.txt

# Configure environment
cp .env.example .env   # fill PRIVATE_KEY, MARKET_ID, addresses

# Run the bot (long-running loop)
.venv/Scripts/python verifier.py

# Single pass (for testing / cron-style runs)
.venv/Scripts/python verifier.py --once
```

## How It Works

- **Quoting (FR-BOT-001)** — keeps one ACTIVE quote per round at the tracked fair price
  (per-quote `expiryBlock` = the market's expiry, D-13). Restocks immediately after a veto.
- **Settlement quote (FR-BOT-002)** — `SETTLEMENT_QUOTE_LEAD_BLOCKS` before expiry it
  submits one final quote at the current fair price, which settles LAST and becomes the
  round mark (终价, D-06).
- **Auto-settle (FR-BOT-003)** — after expiry: settles all ACTIVE quotes oldest-first
  (final quote last = canonical price), withdraws its own collateral, then optionally
  creates the next round's market (`AUTO_CREATE_MARKET`) and keeps quoting.
- **Veto watch (FR-BOT-004)** — detects vetoes on its quotes, withdraws the 2× other-side
  return, and logs provider P&L against the fair price.

## Configuration

See `.env.example` for all parameters. Key round controls: `MARKET_ID`, `ROUND_BLOCKS`,
`AUTO_CREATE_MARKET`, `FEE_BPS`, `SETTLEMENT_QUOTE_LEAD_BLOCKS`.

## Production Deployment

( TODO — replace the static `PriceFeed` with a real 06658.HK feed per D-12/B5.)
