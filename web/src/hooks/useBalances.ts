"use client";

import { useReadContracts } from "wagmi";
import { useMemo } from "react";
import { ERC20_ABI } from "@/lib/abis/market";
import { BASE_TOKEN, QUOTE_TOKEN, isFullyConfigured } from "@/lib/config";

export interface Balances {
  llm: bigint | undefined;
  hkd: bigint | undefined;
}

/**
 * ERC20 balances for LLM (base) and HKD (quote) of the connected account, plus native MON.
 * Returns undefined per-token when not configured/connected.
 */
export function useBalances(address: `0x${string}` | undefined) {
  const { data } = useReadContracts({
    contracts: isFullyConfigured
      ? [
          {
            address: BASE_TOKEN as `0x${string}`,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [address ?? "0x0000000000000000000000000000000000000000"],
          },
          {
            address: QUOTE_TOKEN as `0x${string}`,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [address ?? "0x0000000000000000000000000000000000000000"],
          },
        ]
      : [],
    query: { enabled: isFullyConfigured && !!address, refetchInterval: 3000 },
  });

  return useMemo<Balances>(
    () => ({
      llm: data?.[0]?.result as bigint | undefined,
      hkd: data?.[1]?.result as bigint | undefined,
    }),
    [data],
  );
}