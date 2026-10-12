"use client";

import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePublicClient, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { maxUint256 } from "viem";
import { VAULT_ABI } from "@/lib/abis/vault";
import { ERC20_ABI } from "@/lib/abis/market";
import { VAULT_ADDRESS, VAULT_ADDRESS_RAW, hasVault } from "@/lib/config";
import type { VaultSideValue } from "@/lib/vault";

export type VaultWritePhase = "idle" | "pending" | "success" | "error";

const GAS_VAULT_WRITE = 500_000n;
const GAS_APPROVE = 60_000n;

export function useVaultTrade(): {
  approveQuote: (token: `0x${string}`, amount?: bigint) => void;
  deposit: (amount: bigint) => void;
  withdraw: (shareAmount: bigint) => void;
  openPosition: (side: VaultSideValue, depositAmount: bigint, tenorBlocks: bigint) => void;
  settlePosition: (positionId: bigint) => void;
  phase: VaultWritePhase;
  hash?: `0x${string}`;
  error?: Error | null;
  reset: () => void;
} {
  const { writeContract, data: hash, error: writeError, isPending, reset } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });
  const queryClient = useQueryClient();

  const phase: VaultWritePhase =
    writeError || receipt.isError
      ? "error"
      : receipt.isSuccess
        ? "success"
        : isPending || (!!hash && receipt.isLoading)
          ? "pending"
          : "idle";

  useEffect(() => {
    if (!receipt.isSuccess) return;
    void queryClient.invalidateQueries({ queryKey: ["vaultStats"] });
    void queryClient.invalidateQueries({ queryKey: ["vaultPositions"] });
    void queryClient.invalidateQueries({ queryKey: ["vaultAllowance"] });
  }, [receipt.isSuccess, hash, queryClient]);

  const approveQuote = useCallback(
    (token: `0x${string}`, amount: bigint = maxUint256) => {
      writeContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [VAULT_ADDRESS, amount],
        gas: GAS_APPROVE,
      });
    },
    [writeContract],
  );

  const deposit = useCallback(
    (amount: bigint) => {
      writeContract({
        address: VAULT_ADDRESS,
        abi: VAULT_ABI,
        functionName: "deposit",
        args: [amount],
        gas: GAS_VAULT_WRITE,
      });
    },
    [writeContract],
  );

  const withdraw = useCallback(
    (shareAmount: bigint) => {
      writeContract({
        address: VAULT_ADDRESS,
        abi: VAULT_ABI,
        functionName: "withdraw",
        args: [shareAmount],
        gas: GAS_VAULT_WRITE,
      });
    },
    [writeContract],
  );

  const openPosition = useCallback(
    (side: VaultSideValue, depositAmount: bigint, tenorBlocks: bigint) => {
      writeContract({
        address: VAULT_ADDRESS,
        abi: VAULT_ABI,
        functionName: "openPosition",
        args: [side, depositAmount, tenorBlocks],
        gas: GAS_VAULT_WRITE,
      });
    },
    [writeContract],
  );

  const settlePosition = useCallback(
    (positionId: bigint) => {
      writeContract({
        address: VAULT_ADDRESS,
        abi: VAULT_ABI,
        functionName: "settlePosition",
        args: [positionId],
        gas: GAS_VAULT_WRITE,
      });
    },
    [writeContract],
  );

  return {
    approveQuote,
    deposit,
    withdraw,
    openPosition,
    settlePosition,
    phase,
    hash,
    error: writeError ?? receipt.error ?? undefined,
    reset,
  };
}

/** ERC20 allowance of `owner` to the vault. */
export function useVaultAllowance(
  owner: `0x${string}` | undefined,
  token: `0x${string}` | undefined,
): { allowance?: bigint; refetch: () => void } {
  const publicClient = usePublicClient();

  const query = useQuery({
    queryKey: ["vaultAllowance", owner?.toLowerCase(), token?.toLowerCase(), VAULT_ADDRESS_RAW],
    queryFn: async () => {
      if (!publicClient || !owner || !token) return undefined;
      return publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [owner, VAULT_ADDRESS],
      });
    },
    enabled: hasVault && !!VAULT_ADDRESS && !!publicClient && !!owner && !!token,
    refetchInterval: 3000,
  });

  return { allowance: query.data, refetch: query.refetch };
}
