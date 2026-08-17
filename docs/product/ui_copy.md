# IRMarket — English UI Copy

Canonical English copy for the IRMarket frontend (`web/`). The app UI is English;
all user-facing strings live inline in the components below. Keep copy consistent
with this doc when adding or editing screens.

## Home (`src/app/page.tsx`)

| Key | Copy |
|-----|------|
| Hero H1 | Anything with a price can become an option |
| Hero paragraph | A-shares, Labubu, sports cards… — Monoracle veto-arbitrage settlement: every settlement price is backed by bilateral collateral and on-chain arbitrageurs. No price feeds, no validator nodes. |
| Hero CTA | Claim test tokens |
| Wallet balance | Wallet balance · HKD {amount} · LLM {amount} |
| Markets H2 | Market |
| Markets subtitle | Symmetric long/short · 3-minute expiry · transactional quotes |
| Empty market state | No markets yet. |
| Settling banner | Final price settling — the bot is settling the final quote. |
| Config missing banner | Contract addresses not configured (missing NEXT_PUBLIC_ORACLE_ADDRESS / BASE_TOKEN / QUOTE_TOKEN). Live quotes and trading will appear once configured. |

## Trade (`src/app/trade/page.tsx`)

| Key | Copy |
|-----|------|
| Loading fallback | Loading market… |
| Missing market | Market not found. |
| Expiry label | Expiry |
| Stat: Current price | Current price |
| Stat value (settling) | Settling |
| Stat: Market status | Market status / Ongoing |
| Stat: Quote mode | Quote mode / Bot quotes |
| Stat: Fee | Fee / {pct}% (open only) |
| Settling banner | Final price settling — the last quote hasn't been settled yet; the price shown is from the previous round. Please wait. |
| How it settles H2 | How does it settle? |
| Step 1 | 1. Quote: the bot posts a price backed by bilateral collateral; anyone can verify during the quote window. |
| Step 2 | 2. Trade: bulls hold the asset, bears hold cash. Max loss = the full quote you paid; no liquidations. |
| Step 3 | 3. Settle: if a quote is off-market, on-chain arbitrageurs exercise the veto and slash collateral — the settlement price is market-backed. |

## Positions (`src/app/positions/page.tsx`)

| Key | Copy |
|-----|------|
| Config missing | The contract deployment addresses aren't configured. Once configured you'll be able to see your on-chain positions. |
| H1 | My positions |
| Subtitle | Event-derived · instantly settled · reverse-close anytime · no liquidations · max loss = full quote |
| Open PnL label | Open PnL |
| Total PnL unit | {±amount} HKD |
| Refresh | Refresh |
| Not connected | Connect a wallet to view your positions. |
| No positions | No positions yet. — Head to the market page and open a long or short to try it out. |
| Tab: Open | Open ({count}) |
| Tab: Settled | Settled ({count}) |
| Settling banner | Final price settling — the bot is settling the final quote; the final price will show shortly. |
| Empty open tab | No open positions. |
| Empty settled tab | No settled positions. |
| Footnote | Note: positions are derived live from on-chain events — nothing to claim (no central ledger). Reverse-closing = buy the opposite side with the current bot quote, a direct veto with no fee; closing a short requires topping up the difference to the open fee. |

## Navigation (`src/components/layout/AppShell.tsx`)

| Key | Copy |
|-----|------|
| Nav: Market | Market |
| Nav: Positions | Positions |
| Faucet button | Claim test tokens |

## Transaction status (`src/components/common/TxStatusCard.tsx`)

| Error | Copy |
|-------|------|
| VerificationWindowExpired / QuoteWindowExpired | Quote window passed — please select the latest quote. |
| VerificationWindowActive | Quote window is still open; cannot veto yet. |
| QuoteDoesNotExist | Quote not found — please refresh and retry. |
| QuoteNotActive | Quote is no longer active (vetoed or settled) — please select the latest quote. |
| QuoteAmountTooSmall | Quote amount too small. |
| ZeroBaseAmount | Quote asset amount is 0. |
| ExpiryMustBeFuture | Expiry must be later than the current block. |
| NotQuoteProvider | Only the quote provider can perform this action. |
| NotWithdrawable | Collateral can't be withdrawn yet. |
| MarketDoesNotExist | Market not found — please refresh and retry. |
| QuotePairMismatch | Quote doesn't match this market's assets — please select the latest quote. |
| FeeTooHigh | Fee rate is invalid. |
| InvalidToken | Invalid token address. |
| IdenticalTokens | Base and quote tokens can't be the same. |
| ERC20 allowance | Insufficient allowance — please approve first. |
| ERC20 balance | Insufficient asset balance. |
| ERC20 transfer | Token transfer failed — check your balance and allowance. |
| ReentrancyGuardReentrantCall | Transaction conflict — please retry. |
| User rejected | Signature rejected. |
| Nonce conflict | Nonce conflict — please retry. |
| General revert | Transaction reverted — please check the quote window and allowance. |
| Loading label | Awaiting confirmation… |
| Success title | Transaction succeeded |
| Success detail | Assets were settled to your wallet instantly — view them on the positions page. |
| Explorer link | View transaction {hash0x…}… |
| Error header | Transaction failed |

## Faucet (`src/components/faucet/FaucetModal.tsx`)

| Key | Copy |
|-----|------|
| Title | Test token faucet |
| Config missing | Token contracts aren't configured; can't mint. |
| Body | Claim {amt} LLM and {amt} HKD for free (test tokens to try out trading). |
| Recipient label | Recipient address |
| Placeholder | 0x… |
| Busy button | Minting… |
| Done button | Done ✓ |
| Default button | Claim test tokens |
| Mint error | Minting failed — please retry. |

## Market card (`src/components/market/MarketCard.tsx`)

| Key | Copy |
|-----|------|
| Category tag | HK food stock |
| Price label | Current price (HKD) |
| Expiry label | Expiry |
| Long button | Long |
| Short button | Short |
| Trade link aria | Open trading |

## Position card (`src/components/position/PositionCard.tsx`)

| Key | Copy |
|-----|------|
| Bull badge | Long · Holds LLM |
| Bear badge | Short · Holds HKD |
| Open price | Open price |
| Current quote | Current quote |
| Settling price | Settling… |
| Market value (open) | Market value |
| Market value (settled) | Final value |
| PnL (open) | Floating PnL |
| PnL (settled) | Final PnL |
| PnL settling | Settling… |
| Expiry | Expiry |
| Settled badge | Settled |
| Reverse close | Reverse close |
| Settled footnote | Final PnL is marked at the final price; the assets are already in your wallet — reverse-close to cash out or hold. No settlement or claim needed. |

## Close panel (`src/components/position/ClosePanel.tsx`)

| Key | Copy |
|-----|------|
| Loading (approve) | Awaiting approval signature… |
| Loading (close) | Awaiting close confirmation… |
| Success title | Close succeeded |
| Success detail | Position was swapped back to assets at the current quote; this card will self-remove. |
| Button: no wallet | Connect wallet |
| Button: no quote | No quote available |
| Button: insufficient | Insufficient balance |
| Button: approve | Approve |
| Button: close long | Confirm reverse close (cover long) |
| Button: close short | Confirm reverse close (cover short) |
| Title | Reverse close #{quoteId} |
| No-quote alert | No quote available (bot paused / collateral rolling) — please retry shortly. |
| Fill price | Fill price |
| Pay | Pay |
| Receive | Receive |
| Fee | Fee |
| Fee value | 0 (direct veto, bypasses wrapper) |
| Shortfall label | Top-up required (fee deducted at open) |
| Available | Available {HKD\|LLM} balance: {amount} |
| Insufficient | Insufficient balance |

## Trade panel (`src/components/trade/TradePanel.tsx`)

| Key | Copy |
|-----|------|
| Quote card title | Quote #{quoteId} |
| Expired tag | Expired |
| Countdown | Expires in {countdown} |
| Quote price | {price} HKD/LLM |
| Quote size | Quote size (all-or-nothing): pay {amount} HKD / receive {amount} LLM |
| Loading (approve) | Awaiting approval signature… |
| Loading (trade) | Awaiting transaction confirmation… |
| Success title | Position opened |
| Success detail | Assets were settled to your wallet instantly — view them on the positions page. |
| Button: no wallet | Connect wallet |
| Button: no quote | No quote available |
| Button: insufficient | Insufficient balance |
| Button: approve | Approve |
| Button: open long | Confirm long position |
| Button: open short | Confirm short position |
| Panel title | Trade panel |
| Panel subtitle | Long/short market · 3-minute default expiry · reverse-close anytime · no liquidations |
| Config missing | Contract addresses not configured; trading starts once the bot posts quotes. |
| No-quote alert | No quote available — bot paused or out of collateral (waiting for quotes). |
| Tab: long | Long |
| Tab: short | Short |
| Pay / Receive / Fee / Fill price / Max loss | Pay / Receive / Fee ({pct}%) / Fill price / Max loss |
| Available | Available HKD balance: {amount} / Available LLM balance: {amount} |
| Insufficient | Insufficient balance |

## Wallet (`src/components/wallet/WalletButton.tsx`, `NetworkBadge.tsx`)

| Key | Copy |
|-----|------|
| Connect button | Connect wallet |
| Correct chain | Monad Testnet |
| Wrong chain | Chain {chainId} |
| Balances | HKD {amount} / LLM {amount} / MON {amount} |
| Wrong network banner | Please switch to Monad Testnet (Chain ID {chainId}) |
| Switch button | Switch now |

## Format helpers (`src/lib/format.ts`)

| Key | Copy |
|-----|------|
| formatCountdown expired | Expired |
| Countdown units | {n}h {m}m / {n}m {s}s / {n}s |

## Market labels (`src/hooks/useMarkets.ts`)

| Key | Copy |
|-----|------|
| Market name | Liuliumei |
| Market ticker | LLM 06658.HK |

## Metadata (`src/app/layout.tsx`)

| Key | Copy |
|-----|------|
| Title | IRMarket — Exotic Option Market on Monad |
| Description | Exotic options on any priced asset (A-share stocks, Labubu, ...) with Monoracle-style veto-arbitrage settlement on Monad. |