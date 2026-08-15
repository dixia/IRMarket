"use client";

import { useCallback, useMemo, useState } from "react";
import { useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { maxUint256 } from "viem";
import { ERC20_ABI, IRMARKET_ABI } from "@/lib/abis/market";
import { MONORACLE_ABI } from "@/lib/abis/oracle";
import { MARKET_ADDRESS, MARKET_ADDRESS_RAW, ORACLE_ADDRESS, ORACLE_ADDRESS_RAW, QUOTE_TOKEN_RAW, BASE_TOKEN_RAW, hasWrapper, isFullyConfigured } from "@/lib/config";
import type { Side } from "@/lib/types";

export type TradeKind = "open" | "close";

export const GAS_APPROVE = 60_000n;
export const GAS_VETO = 300_000n;
export const GAS_WRAPPER = 450_000n;

interface TradeRequest {
  side: Side;
  kind: TradeKind;
  marketId?: bigint;
  quoteId: bigint;
  // token + amount the user must hold to afford this trade (payable asset)
  requiredAmount: bigint;
  // token + spender to approve before the trade
  approveToken?: `0x${string}`;
  approveSpender?: `0x${string}`;
}

export interface TradeResult {
  phase: "idle" | "approving" | "approve-confirmed" | "trading" | "success" | "error";
  approveHash?: `0x${string}`;
  tradeHash?: `0x${string}`;
  error?: Error | null;
  needApproval: boolean;
  allowance: bigint | undefined;
  requiredAmount: bigint;
}

/**
 * Two-step order flow:
 *   open  → approve payable asset to wrapper (if configured) or oracle → veto / openLong|openShort
 *   close → approve payable asset to oracle → direct reverse veto (no fee)
 *
 * Whole-quote fills: payable amount is fixed by the quote (B4).
 */
export function useTrade(
  request: TradeRequest | null,
  allowance: bigint | undefined,
) {
  const approve = useWriteContract();
  const trade = useWriteContract();

  const requiredAmount = request?.requiredAmount ?? 0n;

  const needApproval = useMemo(() => {
    if (!request || !isFullyConfigured) return false;
    if (requiredAmount === 0n) return false;
    // Approval is "needed" until the allowance covers the payable amount.
    // approve-max means a single approval clears all future trades of this token.
    return allowance === undefined || allowance < requiredAmount;
  }, [request, requiredAmount, allowance]);

  const [pendingApproval, setPendingApproval] = useState(false);
  const [tradeStarted, setTradeStarted] = useState(false);

  const approveReceipt = useWaitForTransactionReceipt({ hash: approve.data });
  const tradeReceipt = useWaitForTransactionReceipt({ hash: trade.data });

  // Derive the current phase from write/receipt state instead of syncing via effects.
  const phase: TradeResult["phase"] = useMemo(() => {
    if (!request) return "idle";
    if (tradeStarted) {
      if (tradeReceipt.status === "success") return "success";
      if (tradeReceipt.isError || trade.isError) return "error";
      return "trading";
    }
    if (pendingApproval) {
      if (approveReceipt.status === "success") return "approve-confirmed";
      if (approveReceipt.isError || approve.isError) return "error";
      return "approving";
    }
    return "idle";
  }, [
    request,
    tradeStarted,
    tradeReceipt.status,
    tradeReceipt.isError,
    trade.isError,
    pendingApproval,
    approveReceipt.status,
    approveReceipt.isError,
    approve.isError,
  ]);

  const doApprove = useCallback(() => {
    if (!request?.approveToken || !request.approveSpender) return;
    setPendingApproval(true);
    approve.writeContract({
      address: request.approveToken,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [request.approveSpender, maxUint256],
      gas: GAS_APPROVE,
    });
  }, [approve, request]);

  const doTrade = useCallback(() => {
    if (!request) return;
    setTradeStarted(true);

    const payViaWrapper = hasWrapper && request.kind === "open" && request.marketId !== undefined;
    if (payViaWrapper) {
      trade.writeContract({
        address: MARKET_ADDRESS as `0x${string}`,
        abi: IRMARKET_ABI,
        functionName: (request.side === "bull" ? "openLong" : "openShort") as "openLong" | "openShort",
        args: [request.marketId as bigint, request.quoteId],
        gas: GAS_WRAPPER,
      });
    } else {
      trade.writeContract({
        address: ORACLE_ADDRESS as `0x${string}`,
        abi: MONORACLE_ABI,
        functionName: (request.side === "bull" ? "vetoUnderpriced" : "vetoOverpriced") as "vetoUnderpriced" | "vetoOverpriced",
        args: [request.quoteId],
        gas: GAS_VETO,
      });
    }
  }, [trade, request]);

  const error = approve.error ?? trade.error;

  return useMemo(
    () => ({
      phase,
      allowance,
      requiredAmount,
      needApproval,
      approveHash: approve.data,
      tradeHash: trade.data,
      error,
      approveError: approve.error,
      tradeError: trade.error,
      approvePending: approve.isPending,
      tradePending: trade.isPending,
      doApprove,
      doTrade,
      reset: () => {
        setTradeStarted(false);
        setPendingApproval(false);
      },
    }),
    [
      phase, allowance, requiredAmount, needApproval, approve.data, trade.data, error,
      approve.error, trade.error, approve.isPending, trade.isPending,
      doApprove, doTrade,
    ],
  );
}

/** ERC20 allowance of `owner` to `spender`. Disabled when not fully configured. */
export function useAllowance(token: string, owner: `0x${string}` | undefined, spender: string | undefined) {
  const ok = token !== "" && !!owner && !!spender;
  return useReadContract({
    address: token as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner ?? "0x0000000000000000000000000000000000000000", (spender ?? "") as `0x${string}`],
    query: { enabled: isFullyConfigured && ok },
  });
}

/** Resolve the payable asset + spender for a side/kind (opens via wrapper, closes direct). */
export function payableFor(side: Side, kind: TradeKind, marketIdEnabled: boolean) {
  const viaWrapper = hasWrapper && kind === "open" && marketIdEnabled;
  const spender = viaWrapper ? (MARKET_ADDRESS_RAW as `0x${string}`) : (ORACLE_ADDRESS_RAW as `0x${string}`);
  // HKD for long, LLM for short.
  const token = side === "bull"
    ? QUOTE_TOKEN_RAW
    : BASE_TOKEN_RAW;
  return { token: token as `0x${string}`, spender };
}