# IRMarket Bot — PRD

> **Status:** Draft — core requirements confirmed (PRD decisions D-02..D-06).

## Overview

The bot is the **price provider** for IRMarket's Monoracle-backed pricing:

1. **Continuous quoting (D-05)** — submits fresh quotes at the tracked fair price so
   `getLatestPrice` stays fresh; interval is a configurable parameter tuned to the 3-min demo cycle.
2. **Settlement quote (D-06)** — at option expiry, submits one **final quote** at the end price,
   waits out the 2-slot window, and settles it (`settleValidQuote`) so IRMarket can read the
   canonical settlement price.
3. **Auto-settle (D-04)** — triggers IRMarket option settlement and claims rewards once due.

### Requirements

- **FR-BOT-001**: Quote loop — fetch fair price for each monitored pair, `submitQuote` with
  bilateral collateral, settle own quote after the 2-slot window, withdraw previous round to
  recycle collateral. Interval configurable (`QUOTE_INTERVAL_SECONDS` / `QUOTE_INTERVAL_BLOCKS`).
- **FR-BOT-002**: Expiry settlement quote — on option expiry (with `SETTLEMENT_QUOTE_LEAD_BLOCKS`
  lead), submit + settle a final quote used as the settlement price.
- **FR-BOT-003**: Auto-settle — detect settled/matured positions and trigger IRMarket settlement;
  handle gas (fixed `GAS_LIMIT`, Monad charges by limit).
- **FR-BOT-004**: Veto watching — log any veto on our quotes and surface provider P&L
  (out of demo scope to compete, but observable).