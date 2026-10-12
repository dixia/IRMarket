"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { VAULT_ABI } from "@/lib/abis/vault";
import { VAULT_ADDRESS, VAULT_ADDRESS_RAW, hasVault } from "@/lib/config";
import { useCurrentBlock } from "./useCurrentBlock";
import type { VaultPosition, VaultSideValue, VaultStatusValue } from "@/lib/vault";

/** Trader positions held by the vault, filtered to `account`. Index-derived, no log scans. */
export function useVaultPositions(account: `0x${string}` | undefined): {
  positions: VaultPosition[];
  isLoading: boolean;
  refetch: () => void;
} {
  const publicClient = usePublicClient();
  const blockNumber = useCurrentBlock();

  const query = useQuery({
    queryKey: ["vaultPositions", account?.toLowerCase(), VAULT_ADDRESS_RAW],
    queryFn: async (): Promise<VaultPosition[]> => {
      if (!publicClient || !account || !hasVault) return [];

      const count = await publicClient
        .readContract({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "positionCount" })
        .catch(() => 0n);
      if (count <= 0n) return [];

      const results = await Promise.all(
        Array.from({ length: Number(count) }, (_, i) =>
          publicClient
            .readContract({
              address: VAULT_ADDRESS,
              abi: VAULT_ABI,
              functionName: "positions",
              args: [BigInt(i)],
            })
            .catch(() => null),
        ),
      );

      const me = account.toLowerCase();
      const positions: VaultPosition[] = [];
      results.forEach((p, i) => {
        if (!p) return;
        if (p.owner.toLowerCase() !== me) return;
        positions.push({
          id: BigInt(i),
          owner: p.owner,
          side: p.side as VaultSideValue,
          deposit: p.deposit,
          fee: p.fee,
          notional: p.notional,
          entryPrice: p.entryPrice,
          maxPayout: p.maxPayout,
          expiryBlock: p.expiryBlock,
          status: p.status as VaultStatusValue,
        });
      });
      return positions;
    },
    enabled: hasVault && !!VAULT_ADDRESS && !!publicClient && !!account,
    refetchInterval: blockNumber !== undefined ? 15000 : 5000,
    staleTime: 5000,
  });

  return { positions: query.data ?? [], isLoading: query.isLoading, refetch: query.refetch };
}
