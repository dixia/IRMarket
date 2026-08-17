"use client";

import { useReadContracts } from "wagmi";
import { useMemo } from "react";
import { IRMARKET_ABI } from "@/lib/abis/market";
import { useCurrentBlock } from "./useCurrentBlock";
import { BASE_TOKEN, DEMO_MARKET_ID, EXPIRY_SECONDS, MARKET_ADDRESS, MARKET_ADDRESS_RAW, QUOTE_TOKEN, hasWrapper } from "@/lib/config";
import type { MarketWithMeta } from "@/lib/types";

const EXPIRY_BLOCKS = BigInt(EXPIRY_SECONDS) / 300n; // ~300ms blocks

/** The demo market as the default fallback when the wrapper isn't deployed yet. */
function demoMarket(): MarketWithMeta {
  return {
    marketId: DEMO_MARKET_ID,
    baseToken: BASE_TOKEN as `0x${string}`,
    quoteToken: QUOTE_TOKEN as `0x${string}`,
    marketMaker: "0x0000000000000000000000000000000000000000",
    feeBps: 100n, // 1%
    createdAtBlock: 0n,
    expiryBlock: EXPIRY_BLOCKS,
    name: "Liuliumei",
    ticker: "LLM 06658.HK",
  };
}

/** Markets: factory registry when the wrapper is configured; else the demo market config. */
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

  // Union: wrapper markets if any; otherwise demo market. Demo market expiry is relative to
  // the current block when the wrapper is absent (bot uses this cadence per D-05/D-13).
  const demo = useMemo(() => {
    const m = demoMarket();
    if (blockNumber !== undefined && !configuredForWrapper) {
      m.expiryBlock = blockNumber + EXPIRY_BLOCKS;
    }
    return m;
  }, [configuredForWrapper, blockNumber]);

  // Sort so markets still in their quote window come first (soonest-expiring first), then
  // expired ones last. A market is "active" while its expiryBlock is still ahead of now.
  const sorted = useMemo(() => {
    const list = wrapperMarkets.length > 0 ? wrapperMarkets : [demo];
    if (blockNumber === undefined) return list;
    return [...list].sort((a, b) => {
      const aActive = a.expiryBlock > blockNumber ? 0 : 1;
      const bActive = b.expiryBlock > blockNumber ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return a.expiryBlock < b.expiryBlock ? -1 : a.expiryBlock > b.expiryBlock ? 1 : 0;
    });
  }, [wrapperMarkets, demo, blockNumber]);

  return sorted;
}