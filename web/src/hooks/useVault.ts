"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { VAULT_ABI } from "@/lib/abis/vault";
import { MONORACLE_ABI } from "@/lib/abis/oracle";
import { VAULT_ADDRESS, VAULT_ADDRESS_RAW, hasVault } from "@/lib/config";
import { vaultSharePrice } from "@/lib/vault";
import { useCurrentBlock } from "./useCurrentBlock";

export interface VaultMeta {
  oracle?: `0x${string}`;
  priceBase?: `0x${string}`;
  settlementToken?: `0x${string}`;
  feeBps?: bigint;
  isLoading: boolean;
}

/** Immutable vault config (oracle + token pair + fee). */
export function useVaultMeta(): VaultMeta {
  const publicClient = usePublicClient();

  const query = useQuery({
    queryKey: ["vaultMeta", VAULT_ADDRESS_RAW],
    queryFn: async () => {
      if (!publicClient || !hasVault) return undefined;
      // NB: use plain reads, not publicClient.multicall — the wagmi chain config sets
      // `contracts: {}` (web/src/lib/wagmi.ts), so viem multicall throws
      // "multicallAddress is required" in the browser.
      const [oracle, priceBase, settlementToken, feeBps] = await Promise.all([
        publicClient.readContract({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "oracle" }),
        publicClient.readContract({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "priceBase" }),
        publicClient.readContract({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "settlementToken" }),
        publicClient.readContract({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "feeBps" }),
      ]);
      return { oracle, priceBase, settlementToken, feeBps };
    },
    enabled: hasVault && !!VAULT_ADDRESS && !!publicClient,
    staleTime: Infinity,
  });

  return {
    oracle: query.data?.oracle,
    priceBase: query.data?.priceBase,
    settlementToken: query.data?.settlementToken,
    feeBps: query.data?.feeBps,
    isLoading: query.isLoading,
  };
}

export interface VaultStats {
  equity?: bigint;
  balance?: bigint;
  pendingPayout?: bigint;
  totalShares?: bigint;
  shares?: bigint;
  sharePrice?: bigint;
  isLoading: boolean;
  refetch: () => void;
}

/** Pool accounting + the connected wallet's LP shares. */
export function useVaultStats(account: `0x${string}` | undefined): VaultStats {
  const publicClient = usePublicClient();
  const blockNumber = useCurrentBlock();

  const query = useQuery({
    queryKey: ["vaultStats", account?.toLowerCase(), VAULT_ADDRESS_RAW],
    queryFn: async () => {
      if (!publicClient || !hasVault) return undefined;
      const [equity, balance, pendingPayout, totalShares, shares] = await Promise.all([
        publicClient.readContract({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "equity" }),
        publicClient.readContract({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "balance" }),
        publicClient.readContract({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "pendingPayout" }),
        publicClient.readContract({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "totalShares" }),
        account
          ? publicClient.readContract({
              address: VAULT_ADDRESS,
              abi: VAULT_ABI,
              functionName: "shares",
              args: [account],
            })
          : Promise.resolve(0n),
      ]);
      return { equity, balance, pendingPayout, totalShares, shares };
    },
    enabled: hasVault && !!VAULT_ADDRESS && !!publicClient,
    refetchInterval: blockNumber !== undefined ? 15000 : 5000,
    staleTime: 5000,
  });

  return {
    equity: query.data?.equity,
    balance: query.data?.balance,
    pendingPayout: query.data?.pendingPayout,
    totalShares: query.data?.totalShares,
    shares: query.data?.shares ?? 0n,
    sharePrice: query.data ? vaultSharePrice(query.data.equity, query.data.totalShares) : undefined,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}

export interface VaultPriceState {
  price?: bigint;
  exists: boolean;
  isLoading: boolean;
  refetch: () => void;
}

/** Canonical settlement price from Monoracle (`getLatestPrice`). Price-only — no quoting. */
export function useVaultPrice(): VaultPriceState {
  const meta = useVaultMeta();
  const publicClient = usePublicClient();
  const blockNumber = useCurrentBlock();

  const enabled =
    hasVault && !!publicClient && !!meta.oracle && !!meta.priceBase && !!meta.settlementToken;

  const query = useQuery({
    queryKey: ["vaultPrice", VAULT_ADDRESS_RAW],
    queryFn: async () => {
      if (!publicClient || !meta.oracle || !meta.priceBase || !meta.settlementToken) return undefined;
      const result = await publicClient.readContract({
        address: meta.oracle,
        abi: MONORACLE_ABI,
        functionName: "getLatestPrice",
        args: [meta.priceBase, meta.settlementToken],
      });
      return result as readonly [bigint, number, boolean];
    },
    enabled,
    refetchInterval: blockNumber !== undefined ? 15000 : 5000,
    staleTime: 5000,
  });

  const decoded = query.data;
  return {
    price: decoded?.[0],
    exists: decoded !== undefined && decoded[2] === true && decoded[0] > 0n,
    isLoading: meta.isLoading || query.isLoading,
    refetch: query.refetch,
  };
}
