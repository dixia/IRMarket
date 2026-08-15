"use client";

import { useReadContract } from "wagmi";
import { MONORACLE_ABI } from "@/lib/abis/oracle";
import { useQuotes } from "./useQuotes";
import { useMemo } from "react";
import { ORACLE_ADDRESS, isFullyConfigured } from "@/lib/config";
import type { PriceState } from "@/lib/types";

/**
 * Reference price for a pair.
 * - Mid-round: market/position valuation marks to the latest ACTIVE quote's price (B12),
 *   since getLatestPrice only updates on settle.
 * - After a quote settles, getLatestPrice is the canonical/mark (终价).
 */
export function useReferencePrice(pair: { base: `0x${string}`; quote: `0x${string}` } | null) {
  const { activeQuotes, nextQuoteId } = useQuotes(pair);

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

  const state: PriceState = useMemo(() => {
    if (!isFullyConfigured || !pair) return { status: "missing", exists: false };
    if (nextQuoteId === undefined && latestPrice.isPending) return { status: "loading" };
    // Prefer ACTIVE quote price for live mid-round display; fall back to canonical.
    const canonical = settled && settled[2] ? { price: settled[0], settledSlot: settled[1] } : null;
    if (activePrice !== undefined) return { status: "ok", price: activePrice, settledSlot: 0, exists: true };
    if (canonical) return { status: "ok", price: canonical.price, settledSlot: canonical.settledSlot, exists: true };
    if (nextQuoteId !== undefined && nextQuoteId > 1n && settled && settled[2]) {
      // have quotes but none active yet; show canonical if it exists
      return { status: "ok", price: settled[0], settledSlot: settled[1], exists: true };
    }
    return { status: "missing", exists: false };
  }, [pair, nextQuoteId, latestPrice.isPending, settled, activePrice]);

  return state;
}