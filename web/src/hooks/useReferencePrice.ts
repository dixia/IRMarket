"use client";

import { useReadContract } from "wagmi";
import { MONORACLE_ABI } from "@/lib/abis/oracle";
import { useQuotes } from "./useQuotes";
import { useMemo } from "react";
import { useCurrentBlock } from "./useCurrentBlock";
import { ORACLE_ADDRESS, isFullyConfigured } from "@/lib/config";
import type { PriceState } from "@/lib/types";

/**
 * Reference price for a pair.
 * - Mid-round: market/position valuation marks to the latest ACTIVE quote's price (B12),
 *   since getLatestPrice only updates on settle.
 * - After expiry: getLatestPrice is the canonical 终价, but only once the bot settles the
 *   final quote (D-06/B12). Until then the previous round's value persists → show a
 *   「终价结算中（等待 settle）」 transient (E4) instead of a stale number.
 */
export function useReferencePrice(pair: { base: `0x${string}`; quote: `0x${string}` } | null) {
  const { quotes, activeQuotes, nextQuoteId } = useQuotes(pair);
  const blockNumber = useCurrentBlock();

  const latestPrice = useReadContract({
    address: ORACLE_ADDRESS as `0x${string}`,
    abi: MONORACLE_ABI,
    functionName: "getLatestPrice",
    args: pair ? [pair.base, pair.quote] : undefined,
    query: { enabled: isFullyConfigured && pair !== null, refetchInterval: 2000 },
  });

  const settled = latestPrice.data as
    | readonly [bigint, number, boolean]
    | undefined;

  const activePrice = useMemo(
    () => (activeQuotes.length > 0 ? activeQuotes[activeQuotes.length - 1].price : undefined),
    [activeQuotes],
  );

  // Newest quote of the pair. If it has passed its expiryBlock and is still ACTIVE, the final
  // quote hasn't settled yet (E4) — getLatestPrice would still hold the previous round's value.
  const newestQuote = quotes.length > 0 ? quotes[quotes.length - 1] : undefined;
  const settlePending =
    blockNumber !== undefined &&
    newestQuote !== undefined &&
    newestQuote.status === 0 &&
    newestQuote.expiryBlock < blockNumber;

  const state: PriceState = useMemo(() => {
    if (!isFullyConfigured || !pair) return { status: "missing", exists: false };
    if (nextQuoteId === undefined && latestPrice.isPending) return { status: "loading" };
    // Prefer ACTIVE quote price for live mid-round display.
    if (activePrice !== undefined && !settlePending) return { status: "ok", price: activePrice, settledSlot: 0, exists: true };
    // Market expired but the final quote hasn't settled → transient (E4).
    if (settlePending) return { status: "settling", exists: false };
    // Fall back to canonical (settled) price.
    const canonical = settled && settled[2] ? { price: settled[0], settledSlot: settled[1] } : null;
    if (canonical) return { status: "ok", price: canonical.price, settledSlot: canonical.settledSlot, exists: true };
    if (nextQuoteId !== undefined && nextQuoteId > 1n && settled && settled[2]) {
      return { status: "ok", price: settled[0], settledSlot: settled[1], exists: true };
    }
    return { status: "missing", exists: false };
  }, [pair, nextQuoteId, latestPrice.isPending, settled, activePrice, settlePending]);

  return state;
}