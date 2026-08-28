"use client";

import { useReadContracts } from "wagmi";
import { useMemo } from "react";
import { ERC20_ABI } from "@/lib/abis/market";
import { BASE_TOKEN_RAW, QUOTE_TOKEN_RAW, isFullyConfigured } from "@/lib/config";

export interface Balances {
  base: bigint | undefined;
  quote: bigint | undefined;
}

/**
 * ERC20 balances for base + quote tokens of the connected account.
 * When `tokens` is provided the query is driven by those addresses; otherwise it
 * falls back to the global BASE_TOKEN / QUOTE_TOKEN defaults.
 */
export function useBalances(
  address: `0x${string}` | undefined,
  tokens?: { base: `0x${string}`; quote: `0x${string}` } | null,
) {
  const baseAddr = tokens?.base ?? (BASE_TOKEN_RAW as `0x${string}`);
  const quoteAddr = tokens?.quote ?? (QUOTE_TOKEN_RAW as `0x${string}`);
  const configured = isFullyConfigured || (!!baseAddr && !!quoteAddr);

  const { data } = useReadContracts({
    contracts: configured && !!address
      ? [
          {
            address: baseAddr,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [address],
          },
          {
            address: quoteAddr,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [address],
          },
        ]
      : [],
    query: { enabled: configured && !!address, refetchInterval: 3000 },
  });

  return useMemo<Balances>(
    () => ({
      base: data?.[0]?.result as bigint | undefined,
      quote: data?.[1]?.result as bigint | undefined,
    }),
    [data],
  );
}
