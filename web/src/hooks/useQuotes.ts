"use client";

import { useReadContract, useReadContracts } from "wagmi";
import { useMemo } from "react";
import { MONORACLE_ABI } from "@/lib/abis/oracle";
import { useCurrentBlock } from "./useCurrentBlock";
import { ORACLE_ADDRESS, isFullyConfigured } from "@/lib/config";
import type { Quote } from "@/lib/types";

const MAX_TRACKED_QUOTES = 200; // demo sanity cap

/** Latest quoteId from the oracle. */
export function useNextQuoteId() {
  return useReadContract({
    address: ORACLE_ADDRESS as `0x${string}`,
    abi: MONORACLE_ABI,
    functionName: "nextQuoteId",
    query: { enabled: isFullyConfigured },
  });
}

/**
 * Read quotes in a trailing window [nextQuoteId − N, nextQuoteId). Filters to ACTIVE,
 * in-window quotes for the given pair. Used by the market list (mid-round marks) and the
 * trading panel (pick a tradeable quote).
 */
export function useQuotes(pair: { base: `0x${string}`; quote: `0x${string}` } | null) {
  const nextQuoteIdRaw = useNextQuoteId();
  const nextQuoteId = nextQuoteIdRaw.data as bigint | undefined;
  const blockNumber = useCurrentBlock();

  const quoteIds = useMemo(() => {
    if (!nextQuoteId || nextQuoteId <= 1n) return [];
    const ids: bigint[] = [];
    const start = nextQuoteId > BigInt(MAX_TRACKED_QUOTES)
      ? nextQuoteId - BigInt(MAX_TRACKED_QUOTES)
      : 1n;
    for (let id = start; id < nextQuoteId; id++) ids.push(id);
    return ids;
  }, [nextQuoteId]);

  const enabled = isFullyConfigured && pair !== null && quoteIds.length > 0;

  const { data, refetch } = useReadContracts({
    contracts: quoteIds.map((quoteId) => ({
      address: ORACLE_ADDRESS as `0x${string}`,
      abi: MONORACLE_ABI,
      functionName: "quotes",
      args: [quoteId],
    })),
    query: { enabled, refetchInterval: 4000 },
  });

  const quotes = useMemo(() => {
    if (!data || !pair) return [];
    const list: Quote[] = [];
    (data ?? []).forEach((entry, i) => {
      const r = entry.result;
      if (!r || typeof r === "undefined") return;
      const [provider, baseToken, quoteToken, baseAmount, quoteAmount, price, startSlot, settledSlot, expiryBlock, status] = r as readonly [
        `0x${string}`, `0x${string}`, `0x${string}`, bigint, bigint, bigint, number, number, bigint, number,
      ];
      if (provider === "0x0000000000000000000000000000000000000000") return;
      if (baseToken.toLowerCase() !== pair.base.toLowerCase()) return;
      if (quoteToken.toLowerCase() !== pair.quote.toLowerCase()) return;
      list.push({
        quoteId: quoteIds[i],
        provider,
        baseToken,
        quoteToken,
        baseAmount,
        quoteAmount,
        price,
        startSlot,
        settledSlot,
        expiryBlock,
        status: status as Quote["status"],
      });
    });
    return list;
  }, [data, pair, quoteIds]);

  const activeQuotes = useMemo(() => {
    if (!blockNumber) return quotes.filter((q) => q.status === 0);
    return quotes.filter((q) => q.status === 0 && q.expiryBlock >= blockNumber);
  }, [quotes, blockNumber]);

  return { quotes, activeQuotes, nextQuoteId, blockNumber, refetch };
}