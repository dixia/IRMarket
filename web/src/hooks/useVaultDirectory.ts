"use client";

import { useMemo } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import { FACTORY_ABI } from "@/lib/abis/factory";
import { VAULT_ABI } from "@/lib/abis/vault";
import { FACTORY_ADDRESS, hasFactory } from "@/lib/config";

export interface DirectoryVault {
  address: `0x${string}`;
  baseToken: `0x${string}`;
  quoteToken: `0x${string}`;
  feeBps: bigint;
  equity: bigint;
  totalShares: bigint;
  pendingPayout: bigint;
}

/**
 * Every vault the factory created, with its pair + LP stats.
 *
 * The factory is the directory: `vaultCount()`/`vaults(i)` enumerate, and each
 * vault's immutable `priceBase`/`settlementToken` give the pair. One multicall,
 * so the page costs two RPC round trips regardless of how many vaults exist.
 */
export function useVaultDirectory(): { vaults: DirectoryVault[]; isLoading: boolean } {
  const enabled = hasFactory && FACTORY_ADDRESS !== "0x";

  const { data: count } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: "vaultCount",
    query: { enabled },
  });
  const n = Number(count ?? 0n);

  const { data: addrResults, isLoading: loadingAddrs } = useReadContracts({
    contracts: Array.from({ length: n }, (_, i) => ({
      address: FACTORY_ADDRESS,
      abi: FACTORY_ABI,
      functionName: "vaults" as const,
      args: [BigInt(i)] as const,
    })),
    query: { enabled: enabled && n > 0 },
  });

  const addresses = useMemo(
    () =>
      (addrResults ?? [])
        .map((r) => r?.result as `0x${string}` | undefined)
        .filter((a): a is `0x${string}` => !!a && a !== "0x"),
    [addrResults],
  );

  const { data: metaResults, isLoading: loadingMeta } = useReadContracts({
    contracts: addresses.flatMap((vault) => [
      { address: vault, abi: VAULT_ABI, functionName: "priceBase" as const, args: [] as const },
      { address: vault, abi: VAULT_ABI, functionName: "settlementToken" as const, args: [] as const },
      { address: vault, abi: VAULT_ABI, functionName: "feeBps" as const, args: [] as const },
      { address: vault, abi: VAULT_ABI, functionName: "equity" as const, args: [] as const },
      { address: vault, abi: VAULT_ABI, functionName: "totalShares" as const, args: [] as const },
      { address: vault, abi: VAULT_ABI, functionName: "pendingPayout" as const, args: [] as const },
    ]),
    query: { enabled: addresses.length > 0 },
  });

  const vaults = useMemo<DirectoryVault[]>(() => {
    if (!metaResults) return [];
    return addresses.map((address, i) => {
      const row = metaResults.slice(i * 6, i * 6 + 6).map((r) => r?.result);
      return {
        address,
        baseToken: (row[0] ?? "0x") as `0x${string}`,
        quoteToken: (row[1] ?? "0x") as `0x${string}`,
        feeBps: (row[2] ?? 0n) as bigint,
        equity: (row[3] ?? 0n) as bigint,
        totalShares: (row[4] ?? 0n) as bigint,
        pendingPayout: (row[5] ?? 0n) as bigint,
      };
    });
  }, [addresses, metaResults]);

  return { vaults, isLoading: loadingAddrs || loadingMeta };
}

/** The vault for one pair, or the zero address when it has none yet. */
export function usePairVault(baseToken?: `0x${string}`, quoteToken?: `0x${string}`) {
  const { data, isLoading } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: "vaultFor",
    args: baseToken && quoteToken ? [baseToken, quoteToken] : undefined,
    query: { enabled: hasFactory && !!baseToken && !!quoteToken },
  });
  const address = data as `0x${string}` | undefined;
  return { address: address && address !== "0x" ? address : undefined, isLoading };
}
