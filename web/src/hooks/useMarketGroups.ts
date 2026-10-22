"use client";

import { useMemo } from "react";
import type { Market, MarketWithMeta, Quote, Round } from "@/lib/types";
import { useMarkets } from "./useMarkets";
import { useQuotes } from "./useQuotes";
import { useCurrentBlock } from "./useCurrentBlock";

/**
 * One entry per asset pair (e.g. NVDA/KD) regardless of how many trading rounds exist.
 * The Market tab shows a single card per asset instead of every historical round.
 *
 * One-market-per-pair model (docs/web-tech-design.md §4.2): rounds + countdown
 * come from QUOTE expiryBlocks, not from market.expiryBlock (inert — openLong validates
 * the quote's expiry). One shared quote batch (all pairs) drives every group, the same
 * pattern the home page already uses to mark prices.
 */
export interface MarketGroup {
  baseToken: Market["baseToken"];
  quoteToken: Market["quoteToken"];
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  /** Rounds of this pair, live first (soonest-expiring first), then past (newest first). */
  rounds: Round[];
  /** Soonest-expiring live round — the tradeable one (rounds[0] while live). */
  active: Round | null;
  /** Highest live expiry; the card still needs a countdown target while rounds await. */
  latestLive: Round | null;
  /** The pair's trade target market (fee/MM holder for openLong/openShort). */
  market: MarketWithMeta | null;
}

function roundsForPair(quotes: Quote[], base: string, quote: string, block: bigint | undefined): Round[] {
  const byExpiry = new Map<string, Quote[]>();
  for (const q of quotes) {
    if (q.baseToken.toLowerCase() !== base || q.quoteToken.toLowerCase() !== quote) continue;
    const key = q.expiryBlock.toString();
    byExpiry.set(key, [...(byExpiry.get(key) ?? []), q]);
  }
  const out: Round[] = [];
  for (const [expiry, qs] of byExpiry) {
    out.push({
      expiryBlock: BigInt(expiry),
      quotes: [...qs].sort((a, b) => (a.quoteId < b.quoteId ? -1 : 1)),
      live: block !== undefined && BigInt(expiry) >= block,
    });
  }
  const live = out.filter((r) => r.live).sort((a, b) => (a.expiryBlock < b.expiryBlock ? -1 : 1));
  const past = out.filter((r) => !r.live).sort((a, b) => (a.expiryBlock > b.expiryBlock ? -1 : 1));
  return [...live, ...past];
}

/**
 * Groups the deduped pair markets with quote-derived rounds:
 * - `active`: soonest live quote round (null = waiting for the bot's next round).
 * - `market`: the pair's trade target (newest wrapper market for that pair).
 */
export function useMarketGroups(): MarketGroup[] {
  const markets = useMarkets();
  const { quotes } = useQuotes(null);
  const blockNumber = useCurrentBlock();

  return useMemo(() => {
    return markets.map((m) => {
      const pairQuotes = roundsForPair(quotes, m.baseToken.toLowerCase(), m.quoteToken.toLowerCase(), blockNumber);
      const live = pairQuotes.filter((r) => r.live);
      return {
        baseToken: m.baseToken,
        quoteToken: m.quoteToken,
        baseSymbol: m.baseSymbol,
        quoteSymbol: m.quoteSymbol,
        baseDecimals: m.baseDecimals,
        quoteDecimals: m.quoteDecimals,
        rounds: pairQuotes,
        active: live[0] ?? null,
        latestLive: live.length > 0 ? live[live.length - 1] : null,
        market: m,
      };
    });
  }, [markets, quotes, blockNumber]);
}
