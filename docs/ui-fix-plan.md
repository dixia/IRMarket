# IRMarket UI / Business Logic Fix Plan

This plan turns the audit findings into a sequenced implementation plan. It focuses on
functional/architectural bugs, not trivial string tweaks.

## Scope / Non-goals
- Includes: P0 functional bugs, P1 generic multi-market UI, P4 config cleanup.
- Excludes: P2 close-semantics redesign (needs contract upgrade), 429/RPC throttling,
  `.env.local` secret hygiene.

## Source of truth files
- `web/src/hooks/useMarkets.ts`
- `web/src/hooks/useBalances.ts`
- `web/src/hooks/useTrade.ts`
- `web/src/hooks/usePositions.ts`
- `web/src/app/page.tsx`
- `web/src/app/trade/page.tsx`
- `web/src/app/positions/page.tsx`
- `web/src/components/trade/TradePanel.tsx`
- `web/src/components/position/ClosePanel.tsx`
- `web/src/components/position/PositionCard.tsx`
- `web/src/components/market/MarketCard.tsx`
- `web/src/components/faucet/FaucetModal.tsx`
- `web/src/components/wallet/WalletButton.tsx`
- `web/src/lib/config.ts`
- `web/src/lib/format.ts`
- `web/src/lib/types.ts`
- `web/src/lib/abis/market.ts`
- `contracts/IRMarket.sol`

## Phase 1 — P0 functional bugs

### 1.1 `payableFor()` must honor the selected market's pair
- **Why it's a real bug**: `useTrade.ts:174-181` picks token from global
  `BASE_TOKEN_RAW/QUOTE_TOKEN_RAW`, while `IRMarket.sol:239-240` validates
  `q.baseToken == m.baseToken && q.quoteToken == m.quoteToken`. In a multi-market
  world the UI signs the wrong token and tx reverts.
- **Plan**: change `payableFor(side, kind, marketIdEnabled)` to accept the market
  context (`market?: Market`) and derive `baseToken/quoteToken` from it; fall back to
  global tokens only when market is unavailable.
- **Verify**: Playwright opens two different markets and successfully signs long +
  short on each.

### 1.2 Remove ghost demo market
- **Why it's a real bug**: `useMarkets.ts:89-95` fabricates a market when wrapper is
  absent; expiry recalculates every block so countdown never reaches zero.
- **Plan**: return `[]` when wrapper isn't configured. Pages already handle
  `markets.length === 0`.
- **Verify**: unconfigured `/` shows "No markets yet" instead of a fake card.

### 1.3 `/trade` default market selection
- **Why it matters**: `trade/page.tsx:23` defaults `m=1`, which is usually the first
  expired round. The page then shows "No quote available" even though newer markets
  exist.
- **Plan**: when `?m` is absent, pick the first active market from the already-sorted
  `useMarkets()` output.
- **Verify**: `GET /trade` loads an active market without query params.

## Phase 2 — P1 generic multi-market UI

### 2.1 Dynamic token metadata (`symbol()`, `decimals()`)
- **Why it's a design gap**: `MarketWithMeta.name/ticker` are hardcoded because
  `contracts/IRMarket.sol`'s `Market` struct has no metadata fields. Amounts are
  hardcoded 18 decimals because the UI never reads `ERC20.decimals()`.
- **Plan**: add `useTokenMeta(addresses)` via `useReadContracts` batching
  `symbol()` + `decimals()`, cache in react-query / useMemo. Update `Quote`,
  `MarketWithMeta`, and formatting helpers to carry decimals.
- **Verify**: deploy tokens with 6/18 decimals and confirm amounts display correctly.

### 2.2 Genericize balances hook
- **Why it's a real bug**: `useBalances.ts:8-11` returns `{ llm, hkd }` and every
  caller hardcodes the same names.
- **Plan**: accept `tokens: { base: Address; quote: Address }` and return
  `{ base, quote }`. Update `page.tsx`, `WalletButton.tsx`, `TradePanel.tsx`,
  `ClosePanel.tsx`.
- **Verify**: switching markets updates balance labels automatically.

### 2.3 Dynamic labels in Trade/Close/Quote/Position cards
- **Why it matters**: "HKD"/"LLM" strings are hardcoded in many places.
- **Plan**: thread `baseSymbol/quoteSymbol/baseDecimals/quoteDecimals` from the
  market into `TradePanel`, `ClosePanel`, `QuoteCard`, `PositionCard`.
- **Verify**: different pairs render different symbols end-to-end.

### 2.4 `canClose` per position
- **Why it's a real bug**: `positions/page.tsx:46-47` returns true when ANY active
  quote exists anywhere. With multiple markets this enables close buttons on positions
  whose own market has no live quote.
- **Plan**: for wrapped positions use `position.marketId` to look up that market's
  pair; for direct-veto positions use the quote's pair. Check active quotes for that
  pair only.
- **Verify**: create two markets, open a position in one, ensure close button only
  appears when THAT market has an active quote.

## Phase 3 — deferred (needs contract upgrade)
- Close semantics: distinguish open/close veto off-chain, or add `PositionClosed`
  event.
- `Market` struct on-chain metadata fields.

## Phase 4 — config / hygiene cleanup
- Move `EXPLORER_BASE`, `FAUCET_AMOUNT`, `MON_RESERVE_FLOOR`, gas constants into
  `config.ts`.
- Add `web/tests/helpers/addresses.json` to `.gitignore`.
- Keep `useMarkets.ts` block-time constants centralized and documented.

## Execution model
- **Impl agent**: implements Phases 1, 2, 4 in dependency order.
- **Review agent**: reads the final diff and checks payableFor() call chain,
  multi-market routing, positions pairing logic, decimals edge cases, and test gaps.
- **Human checkpoint**: after impl, before merge, summarize technical difficulties.
