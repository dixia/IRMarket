"use client";

import { useReadContracts } from "wagmi";
import { useMemo } from "react";
import { IRMARKET_ABI } from "@/lib/abis/market";
import { useTokenMeta } from "./useTokenMeta";
import { MARKET_ADDRESS, MARKET_ADDRESS_RAW, SELECTED_BASE_TOKENS, hasWrapper } from "@/lib/config";
import { TOKEN_META_PENDING } from "@/lib/types";
import type { Market, MarketWithMeta } from "@/lib/types";

/** Markets: factory registry when the wrapper is configured; else empty.
 *  One-market-per-pair: returns ONE trade-target market per pair (newest marketId);
 *  trading rounds come from `useRounds` (quote expiryBlock). */
export function useMarkets(): MarketWithMeta[] {
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

  // nextMarketId is the NEXT unused id, so valid markets are 1..nextMarketId-1.
  // (Enumerating up to nextMarketId inclusive reads a non-existent market → ???/???.)
  const nextMarketId = (data?.[0]?.result as bigint | undefined) ?? 0n;

  const marketIds = useMemo(() => {
    if (!configuredForWrapper || nextMarketId <= 1n) return [];
    const ids: bigint[] = [];
    for (let id = 1n; id < nextMarketId; id++) ids.push(id);
    return ids;
  }, [configuredForWrapper, nextMarketId]);

  const { data: marketsData } = useReadContracts({
    contracts: marketIds.map((marketId) => ({
      address: MARKET_ADDRESS as `0x${string}`,
      abi: IRMARKET_ABI,
      functionName: "markets",
      args: [marketId],
    })),
    query: { enabled: configuredForWrapper && marketIds.length > 0 },
  });

  const wrapperMarkets: Market[] = useMemo(() => {
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
          // uint16 → viem decodes it as a JS number, not a bigint; coerce so the
          // declared `bigint` type holds at runtime (computeFee does bigint math).
          feeBps: BigInt(Array.isArray(r) ? (r[3] as bigint | number) : (r as unknown as { feeBps: bigint | number }).feeBps),
          expiryBlock: Array.isArray(r) ? (r[4] as bigint) : (r as unknown as { expiryBlock: bigint }).expiryBlock,
          createdAtBlock: Array.isArray(r) ? (r[5] as bigint) : (r as unknown as { createdAtBlock: bigint }).createdAtBlock,
        } satisfies Market;
      })
      .filter((m): m is Market => m !== null);
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
        const baseSymbol = baseMeta?.symbol ?? TOKEN_META_PENDING;
        const quoteSymbol = quoteMeta?.symbol ?? TOKEN_META_PENDING;
        return {
          ...m,
          baseSymbol,
          quoteSymbol,
          baseDecimals: baseMeta?.decimals ?? 18,
          quoteDecimals: quoteMeta?.decimals ?? 18,
          name: `${baseSymbol}/${quoteSymbol}`,
          ticker: `${baseSymbol}/${quoteSymbol}`,
        };
      }),
    [wrapperMarkets, metaMap],
  );

  // Curation (frontend-only registry, per-pair vault model - docs/architecture.md §7):
  // keep only markets whose base token is on the selected list; absent/empty shows all.
  const curated = useMemo(() => {
    if (SELECTED_BASE_TOKENS.length === 0) return enriched;
    const set = new Set(SELECTED_BASE_TOKENS);
    return enriched.filter((m) => set.has(m.baseToken.toLowerCase()));
  }, [enriched]);
  // One-market-per-pair (docs/plan/one-market-per-pair-plan.md): markets are the PAIR
  // TRADE TARGET (openLong needs marketId + feeBps/marketMaker; pair/MM/fee never change),
  // NOT rounds — trading rounds come from useRounds (quote expiryBlock). Dedup to the
  // newest market per pair. `markets()` still enumerates every id (the wrapper has no
  // pair→id lookup) but under Option B nextMarketId freezes at ~#pairs.
  const deduped = useMemo(() => {
    const byPair = new Map<string, MarketWithMeta>();
    for (const m of curated) {
      const key = `${m.baseToken.toLowerCase()}/${m.quoteToken.toLowerCase()}`;
      const cur = byPair.get(key);
      if (!cur || m.marketId > cur.marketId) byPair.set(key, m);
    }
    return [...byPair.values()];
  }, [curated]);

  return deduped;
}