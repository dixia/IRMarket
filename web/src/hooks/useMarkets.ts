"use client";

import { useReadContracts } from "wagmi";
import { useMemo } from "react";
import { IRMARKET_ABI } from "@/lib/abis/market";
import { useCurrentBlock } from "./useCurrentBlock";
import { useTokenMeta } from "./useTokenMeta";
import { MARKET_ADDRESS, MARKET_ADDRESS_RAW, hasWrapper } from "@/lib/config";
import type { MarketWithMeta } from "@/lib/types";

/** Markets: factory registry when the wrapper is configured; else empty. */
export function useMarkets(): MarketWithMeta[] {
  const blockNumber = useCurrentBlock();
  const configuredForWrapper = hasWrapper && MARKET_ADDRESS_RAW !== "";

  const { data } = useReadContracts({
    contracts: configuredForWrapper
      ? ([
          {
            address: MARKET_ADDRESS as `0x${string}`,
            abi: IRMARKET_ABI,
            functionName: "nextMarketId",
          },
        ] as const)
      : [],
    query: { enabled: configuredForWrapper },
  });

  const marketCount = (data?.[0]?.result as bigint | undefined) ?? 0n;

  const marketIds = useMemo(() => {
    if (!configuredForWrapper || marketCount === 0n) return [];
    const ids: bigint[] = [];
    for (let i = 0n; i < marketCount; i++) ids.push(i + 1n);
    return ids;
  }, [configuredForWrapper, marketCount]);

  const { data: marketsData } = useReadContracts({
    contracts: marketIds.map((marketId) => ({
      address: MARKET_ADDRESS as `0x${string}`,
      abi: IRMARKET_ABI,
      functionName: "markets",
      args: [marketId],
    })),
    query: { enabled: configuredForWrapper && marketIds.length > 0 },
  });

  const wrapperMarkets: MarketWithMeta[] = useMemo(() => {
    if (!configuredForWrapper) return [];
    return (marketsData ?? [])
      .map((entry, i) => {
        const r = entry.result;
        if (!r) return null;
        const base = Array.isArray(r) ? (r[0] as `0x${string}`) : (r as unknown as { baseToken: `0x${string}` }).baseToken;
        const quote = Array.isArray(r) ? (r[1] as `0x${string}`) : (r as unknown as { quoteToken: `0x${string}` }).quoteToken;
        return {
          marketId: marketIds[i],
          baseToken: base,
          quoteToken: quote,
          marketMaker: Array.isArray(r) ? (r[2] as `0x${string}`) : (r as unknown as { marketMaker: `0x${string}` }).marketMaker,
          feeBps: Array.isArray(r) ? (r[3] as bigint) : (r as unknown as { feeBps: bigint }).feeBps,
          expiryBlock: Array.isArray(r) ? (r[4] as bigint) : (r as unknown as { expiryBlock: bigint }).expiryBlock,
          createdAtBlock: Array.isArray(r) ? (r[5] as bigint) : (r as unknown as { createdAtBlock: bigint }).createdAtBlock,
          name: "Liuliumei",
          ticker: "LLM 06658.HK",
        } satisfies MarketWithMeta;
      })
      .filter((m): m is MarketWithMeta => m !== null);
  }, [configuredForWrapper, marketsData, marketIds]);

  const tokenAddresses = useMemo(
    () =>
      wrapperMarkets.reduce<`0x${string}`[]>((acc, m) => {
        if (!acc.includes(m.baseToken)) acc.push(m.baseToken);
        if (!acc.includes(m.quoteToken)) acc.push(m.quoteToken);
        return acc;
      }, []),
    [wrapperMarkets],
  );
  const metaMap = useTokenMeta(tokenAddresses);

  const enriched = useMemo(
    () =>
      wrapperMarkets.map((m) => {
        const baseMeta = metaMap.get(m.baseToken.toLowerCase());
        const quoteMeta = metaMap.get(m.quoteToken.toLowerCase());
        const baseSymbol = baseMeta?.symbol ?? "???";
        const quoteSymbol = quoteMeta?.symbol ?? "???";
        return {
          ...m,
          name: `${baseSymbol}/${quoteSymbol}`,
          ticker: `${baseSymbol}/${quoteSymbol}`,
        };
      }),
    [wrapperMarkets, metaMap],
  );

  // Sort so markets still in their quote window come first (soonest-expiring first), then
  // expired ones last. A market is "active" while its expiryBlock is still ahead of now.
  const sorted = useMemo(() => {
    if (blockNumber === undefined) return enriched;
    return [...enriched].sort((a, b) => {
      const aActive = a.expiryBlock > blockNumber ? 0 : 1;
      const bActive = b.expiryBlock > blockNumber ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return a.expiryBlock < b.expiryBlock ? -1 : a.expiryBlock > b.expiryBlock ? 1 : 0;
    });
  }, [enriched, blockNumber]);

  return sorted;
}