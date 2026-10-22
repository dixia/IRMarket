"use client";

import { useMemo } from "react";
import type { Quote, Round } from "@/lib/types";
import { useCurrentBlock } from "./useCurrentBlock";
import { useQuotes } from "./useQuotes";

/**
 * Rounds derived from QUOTE expiryBlocks — one-market-per-pair model
 * (docs/web-tech-design.md §4.2).
 *
 * The wrapper market's own expiryBlock is inert (openLong validates the QUOTE's
 * expiry), so a "round" is a distinct quote expiryBlock for a pair. Quotes are one
 * global id space across providers/pairs, so rounds are grouped per (pair, expiry)
 * from the trailing quote window the shared `useQuotes` batch already decoded.
 *
 * `active` = the soonest-expiring LIVE round; `rounds` keeps live first (soonest
 * first) then past rounds (newest first) for the trade page's round selector.
 */
export interface PairKey {
  base: `0x${string}`;
  quote: `0x${string}`;
}

export function useRounds(pair: PairKey | null) {
  const { quotes } = useQuotes(pair);
  const blockNumber = useCurrentBlock();

  return useMemo(() => {
    if (!pair || blockNumber === undefined) {
      return { rounds: [] as Round[], active: null as Round | null, activeExpiry: null as bigint | null };
    }
    const base = pair.base.toLowerCase();
    const quote = pair.quote.toLowerCase();
    const byExpiry = new Map<string, Quote[]>();
    for (const q of quotes) {
      if (q.baseToken.toLowerCase() !== base || q.quoteToken.toLowerCase() !== quote) continue;
      const key = q.expiryBlock.toString();
      byExpiry.set(key, [...(byExpiry.get(key) ?? []), q]);
    }
    const rounds: Round[] = [];
    for (const [expiry, quotesOfRound] of byExpiry) {
      rounds.push({
        expiryBlock: BigInt(expiry),
        quotes: [...quotesOfRound].sort((a, b) => (a.quoteId < b.quoteId ? -1 : 1)),
        live: BigInt(expiry) >= blockNumber,
      });
    }
    const live = rounds
      .filter((r) => r.live)
      .sort((a, b) => (a.expiryBlock < b.expiryBlock ? -1 : 1));
    const past = rounds
      .filter((r) => !r.live)
      .sort((a, b) => (a.expiryBlock > b.expiryBlock ? -1 : 1));
    const ordered = [...live, ...past];
    return { rounds: ordered, active: live[0] ?? null, activeExpiry: live[0]?.expiryBlock ?? null };
  }, [pair, quotes, blockNumber]);
}
