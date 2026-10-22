# IRMarket Bot

> Market-maker & settlement bot for IRMarket on the Monoracle veto-arbitrage
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
  (per-quote `expiryBlock` = the ROUND expiry — rounds are QUOTE expiryBlocks, not markets;
  docs/sc-tech-spec.md). Restocks immediately after a veto.
- **Settlement quote (FR-BOT-002)** — `SETTLEMENT_QUOTE_LEAD_BLOCKS` before expiry it
  submits one final quote at the current fair price, which settles LAST and becomes the
  round mark (终价, D-06).
- **Auto-settle (FR-BOT-003)** — after expiry: settles all expired ACTIVE quotes of the pair
  oldest-first (final quote last = canonical price), withdraws its own collateral, then starts
  the next round by quoting a fresh `expiryBlock`. **The bot never calls `createMarket`** —
  one long-lived market per pair (the optional `AUTO_CREATE_MARKET=1` is a one-shot ensure
  for a missing market only).
- **Veto watch (FR-BOT-004)** — detects vetoes on its quotes, withdraws the 2× other-side
  return, and logs provider P&L against the fair price.

## Configuration

See `.env.example` for all parameters. Key round controls: `MARKET_ID`, `ROUND_BLOCKS`
(15 min default = 3000 blocks), `AUTO_CREATE_MARKET`, `FEE_BPS`, `SETTLEMENT_QUOTE_LEAD_BLOCKS`.

## Gas

Monad charges **gas limit × price**, not gas used — so an inflated limit is money
burned on every send. The bot therefore sends fixed limits from the `GAS` table in
`verifier.py` (each overridable with `GAS_<OP>_WEI`, e.g. `GAS_SUBMIT_QUOTE_WEI`).

**Never tune the table from the bot's own logs.** On Monad
`eth_getTransactionReceipt.gasUsed` equals the limit you sent, so the `ok (gas N)` line
is not a usage measurement. Re-measure instead:

```bash
npx hardhat run script/gas-report.js   # every write path, gasUsed + recommended limit
```

`test/gas.test.js` fails if any limit drifts outside 120–400% of measured usage, in
either direction (too tight = reverts, too loose = overpaying).

## Production Deployment

( TODO — replace the static `PriceFeed` with a real 06658.HK feed per D-12/B5.)
