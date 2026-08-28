"use client";

import { useReadContracts } from "wagmi";
import { useMemo } from "react";
import { ERC20_ABI } from "@/lib/abis/market";

export interface TokenMeta {
  symbol: string;
  decimals: number;
}

/**
 * Batch-fetch symbol() + decimals() for a set of token addresses.
 * Returns a Map keyed by lowercase address for O(1) lookup.
 * Falls back to { symbol: "???", decimals: 18 } when a call fails.
 */
export function useTokenMeta(addresses: `0x${string}`[]) {
  const unique = useMemo(
    () => [...new Set(addresses.map((a) => a.toLowerCase()))],
    [addresses],
  );

  const { data } = useReadContracts({
    contracts: unique.flatMap((addr) => [
      { address: addr as `0x${string}`, abi: ERC20_ABI, functionName: "symbol", args: [] as never[] },
      { address: addr as `0x${string}`, abi: ERC20_ABI, functionName: "decimals", args: [] as never[] },
    ]),
    query: { enabled: unique.length > 0 },
  });

  const metaMap = useMemo(() => {
    const map = new Map<string, TokenMeta>();
    for (let i = 0; i < unique.length; i++) {
      const symbolResult = data?.[i * 2]?.result as string | undefined;
      const decimalsResult = data?.[i * 2 + 1]?.result as number | undefined;
      map.set(unique[i], {
        symbol: symbolResult ?? "???",
        decimals: decimalsResult ?? 18,
      });
    }
    return map;
  }, [data, unique]);

  return metaMap;
}
