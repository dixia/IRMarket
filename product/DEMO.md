# Live Demo: IRMarket — 5 Minutes (Veto-Market V0.9)

> **Narrative:** 溜溜梅 (06658.HK / HKG:6658) is "hot" — LLM is trading at **130 HKD**.
> IRMarket runs a live option round on Monad testnet where every trade IS a
> Monoracle veto-arbitrage: bilateral collateral backs every quote, and any wallet
> can challenge a mispriced quote by trading against it. Zero-sum with the market
> maker, no oracles, no validators, no pool.

---

## Before Demo (prep, ~10 min)

### 1. Environment

Contracts (Monad testnet, deployed & verified):

| Contract | Address |
|---|---|
| MonoracleWindowed (oracle fork, D-13) | `0xb6523DA6f177dB25d766a27575624B3e1fe0a00e` |
| IRMarket (factory + 1% fee wrapper) | `0x03b181080878515a01c5DA3EB262bf07C595dFef` |
| LLM (base token) | `0xC065c5C371DFfcA7C167418810498506c57D1F35` |
| HKD (quote token) | `0x34675029742e7E5Fea3637F68c911414a47F9752` |

### 2. Start a fresh demo round (right before the demo)

```powershell
# 5-minute round so expiry happens live during the demo
$env:EXPIRY_SECONDS = "300"
node script/create-market.js          # prints the new marketId (e.g. 3)
```

Update the pointers to the new marketId, then restart the bot and the web:

```powershell
# bot/.env  ->  MARKET_ID=<newId>   (already 130 in MONITORED_PAIRS)
# web/.env.local -> NEXT_PUBLIC_DEMO_MARKET_ID=<newId>, NEXT_PUBLIC_EXPIRY_SECONDS=300

# restart the market-maker bot (quotes at fair 130 HKD)
Get-CimInstance Win32_Process -Filter "Name like 'python%'" | Where-Object { $_.CommandLine -match 'verifier' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Process cmd -ArgumentList "/c","cd /d C:\Users\iamh4\Documents\repo\IRMarket && bot\.venv\Scripts\python bot\verifier.py > %TEMP%\irmarket-bot.log 2>&1" -WindowStyle Hidden

# start the frontend
cd web && npm run dev        # http://localhost:3000
```

### 3. Wallets & faucets

- Two browser profiles / wallets on **Monad testnet** (chain 10143, RPC
  `https://testnet-rpc.monad.xyz`, symbol MON, explorer `testnet.monadscan.com`).
- Fund each wallet's MON via a testnet faucet (gas only — quotes/trades are small).
- In the dapp, open the **faucet modal** and mint LLM + HKD (public `MockERC20.mint`,
  2000 each). Wallet A = trader, Wallet B = second trader / counterparty.
- Open the oracle + market contract pages on monadscan to show live txs.

### 4. Sanity check

- Home page shows the market card with **price ≈ 130 HKD** and a countdown
  (price comes from the bot's latest ACTIVE quote).
- `bot/.env` `MONITORED_PAIRS` fair price = `130000000000000000000`.

---

## PATH 1: 看涨开仓 — Go Long via the Wrapper (~90s)

**Point:** "On IRMarket, going long = vetoing an underpriced quote."

1. Home page: show the market card — LLM at **130 HKD**, round countdown, fee 1% (HKD).
2. Go to **Trade** → pick **Bull (看涨)**.
3. Wallet A approves HKD and submits **openLong(marketId, quoteId)**.
4. Narrate what just happened:
   - The tx called `IRMarket.openLong` → pulled `130 + 1` HKD → paid the 1 HKD fee
     to the market maker → then **`vetoUnderpriced(quoteId)`** on the oracle.
   - You now hold **1 LLM**, bought at 130 HKD against the market maker's quote.
5. Show on monadscan: `QuoteVetoedUnderpriced` + `VetoWrapped(fee=1 HKD)` logs.
6. **Positions** page: the long appears — cost basis 130 HKD, holds 1 LLM.
7. Show the **bot log** (`%TEMP%\irmarket-bot.log`):
   `VETO qX UNDERPRICED | pnl≈-X HKD` → the bot withdrew its 2× HKD return and
   restocked a fresh quote. **Trader profit = market-maker loss (zero-sum, D-10).**

## PATH 2: 看跌开仓 — Go Short via the Wrapper (~60s)

**Point:** "Shorting = vetoing an overpriced quote."

1. Wallet B goes to **Trade** → **Bear (看跌)** on the bot's fresh quote.
2. Wallet B approves LLM and submits **openShort(marketId, quoteId)** → pays 1 LLM,
   receives `130 − 1` HKD (fee deducted from payout).
3. Positions page shows the short. Bot log shows `VETO qY OVERPRICED` + restock.

## PATH 3: 反向平仓 — Reverse Close (D-08) (~60s)

**Point:** "Closing = the reverse veto, direct on the oracle, **no fee** (A5)."

1. Wallet A (holding LLM) calls the oracle directly: **`vetoOverpriced(newQuoteId)`**
   → pays its LLM back, receives HKD. Exposure closed, no wrapper fee.
2. Positions page re-values both legs; show the round-trip P&L vs cost basis.
3. (Optional) Show the same works the other way: Wallet B's short holder does
   `vetoUnderpriced` on a later quote to get LLM back.

## PATH 4: 到期结算 — Expiry = Mark, No Claim (~60s)

**Point:** "At expiry the round's FINAL quote settles last → 终价. Assets are already
in your wallet — there is nothing to claim."

1. Wait for the countdown; the bot logs:
   - `final settlement quote` (submitted `SETTLEMENT_QUOTE_LEAD_BLOCKS` before expiry),
   - `settle qX` ... oldest-first, **final quote last**,
   - `round settled: canonical price=130...`,
   - `NEXT ROUND: marketId=N+1 ...` (auto-rolls to the next round).
2. Show `getLatestPrice(LLM, HKD)` on monadscan = **130** → positions re-value at the
   mark. Note: **no "claim" button** — long holders already own LLM, shorts already
   own HKD (D-09/Q4).
3. The bot has already created the next market — point the web at it if you want to
   keep trading live (`NEXT_PUBLIC_DEMO_MARKET_ID`).

## Wrap-Up (~30s)

- **No price feeds, no validators, no pool.** Every settlement price is enforced by
  bilateral collateral + permissionless on-chain veto arbitrage (Monoracle primitive).
- **Zero-sum:** trader P&L = market maker's mirror loss `|T−P|×size`.
- **Monad:** ~300ms blocks, gas billed by gas limit, streaming events drive the UI.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Price shows old value (e.g. 100) | A stale ACTIVE quote from an earlier round is still on-chain; veto it (trader) or wait for expiry — the bot's newest quote is the reference (web reads latest ACTIVE). |
| "No tradeable quote" / waiting for bot | Bot is down or the round expired. Check `%TEMP%\irmarket-bot.log`; restart bot, or create a fresh round (`create-market.js`) and update `MARKET_ID`/`NEXT_PUBLIC_DEMO_MARKET_ID`. |
| Bot crashed with nonce error | web3 nonce race (e.g. two processes sharing a key) — bot auto-resyncs on retry now; just restart it. |
| Demo round expired mid-walkthrough | Expected: bot auto-rolled to `marketId=N+1` (30-min round). Point the web at the new id, or spin a fresh 5-min round. |
| MetaMask can't find chain | Add Monad testnet: chain 10143, RPC `https://testnet-rpc.monad.xyz`, symbol MON, explorer `https://testnet.monadscan.com`. |
