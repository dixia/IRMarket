"use client";

import { useMemo } from "react";
import { useAccount } from "wagmi";
import type { Position, Quote, Side } from "@/lib/types";
import { formatAmount, formatPrice } from "@/lib/format";
import { useQuotes } from "@/hooks/useQuotes";
import { useBalances } from "@/hooks/useBalances";
import { useCurrentBlock } from "@/hooks/useCurrentBlock";
import { useAllowance, payableFor, useTrade, TradeKind } from "@/hooks/useTrade";
import { TxStatusCard, mapTransactionError, TxState } from "@/components/common/TxStatusCard";

/**
 * Reverse-close (平仓, D-08): sign a DIRECT veto on MonoracleWindowed — no wrapper, no fee
 * (D-11/D-16). Close of a short pays the FULL quoteAmount HKD, which may exceed the
 * quoteAmount − fee received at open → 「需补足 X HKD」 (E3).
 */
export function ClosePanel({
  position,
  baseToken,
  quoteToken,
  onClosed,
}: {
  position: Position;
  baseToken: `0x${string}` | undefined;
  quoteToken: `0x${string}` | undefined;
  onClosed: () => void;
}) {
  const { address } = useAccount();
  const { activeQuotes } = useQuotes(baseToken && quoteToken ? { base: baseToken, quote: quoteToken } : null);
  const blockNumber = useCurrentBlock();
  const balances = useBalances(address);

  const active = activeQuotes.filter((q) => blockNumber === undefined || q.expiryBlock >= blockNumber);
  const selected: Quote | undefined = active.length > 0 ? active[active.length - 1] : undefined;

  // Reverse direction: closing a bull (holds LLM) = vetoOverpriced (short); closing a
  // bear (holds HKD) = vetoUnderpriced (long).
  const closeSide: Side = position.side === "bull" ? "bear" : "bull";

  const payAmount = useMemo(
    () => (selected ? (closeSide === "bull" ? selected.quoteAmount : selected.baseAmount) : 0n),
    [selected, closeSide],
  );
  const receiveAmount = useMemo(
    () => (selected ? (closeSide === "bull" ? selected.baseAmount : selected.quoteAmount) : 0n),
    [selected, closeSide],
  );

  // E3: short received quoteAmount − fee HKD at open; closing pays full quoteAmount HKD.
  const shortfall = useMemo(() => {
    if (closeSide !== "bull" || !selected) return 0n;
    const held = position.heldQuote;
    return selected.quoteAmount > held ? selected.quoteAmount - held : 0n;
  }, [closeSide, selected, position.heldQuote]);

  const payable = payableFor(closeSide, "close", false);
  const { data: allowance } = useAllowance(payable.token, address, payable.spender);

  const request = useMemo(() => {
    if (!selected) return null;
    return {
      side: closeSide,
      kind: "close" as TradeKind,
      quoteId: selected.quoteId,
      requiredAmount: payAmount,
      approveToken: payable.token,
      approveSpender: payable.spender,
    };
  }, [selected, closeSide, payAmount, payable.token, payable.spender]);

  const trade = useTrade(request, allowance as bigint | undefined);

  const balanceFor = closeSide === "bull" ? balances.hkd : balances.llm;
  const insufficient = balanceFor !== undefined && balanceFor < payAmount;

  const txState: TxState = useMemo(() => {
    if (trade.phase === "approving" || trade.phase === "trading") {
      return { status: "loading", label: trade.phase === "approving" ? "Awaiting approval signature…" : "Awaiting close confirmation…" };
    }
    if (trade.phase === "success" && trade.tradeHash) {
      return {
        status: "success",
        hash: trade.tradeHash,
        title: "Close succeeded",
        detail: "Position was swapped back to assets at the current quote; this card will self-remove.",
      };
    }
    if (trade.phase === "error" && trade.error) {
      return { status: "error", message: mapTransactionError(trade.error) };
    }
    return { status: "idle" };
  }, [trade]);

  const canSubmit =
    !!address && !!selected && !insufficient && trade.phase !== "approving" && trade.phase !== "trading";

  const buttonLabel = !address
    ? "Connect wallet"
    : !selected
      ? "No quote available"
      : insufficient
        ? "Insufficient balance"
        : trade.needApproval
          ? "Approve"
          : closeSide === "bull"
            ? "Confirm reverse close (cover long)"
            : "Confirm reverse close (cover short)";

  return (
    <div className="rounded-xl border border-primary/40 bg-card p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Reverse close #{position.quoteId.toString()}</h3>
        <button className="text-sm text-text-dim hover:text-text" onClick={onClosed}>
          ✕
        </button>
      </div>

      {!selected ? (
        <p className="mt-3 rounded-lg border border-bear/30 bg-bear/5 p-3 text-sm text-bear">
          No quote available (bot paused / collateral rolling) — please retry shortly.
        </p>
      ) : (
        <>
          <div className="mt-3 rounded-lg bg-primary/5 p-3 text-sm space-y-1">
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">Fill price</span>
              <span>{formatPrice(selected.price)} HKD/LLM</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">Pay</span>
              <span>{formatAmount(payAmount, 18, 4)} {closeSide === "bull" ? "HKD" : "LLM"}</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">Receive</span>
              <span>{formatAmount(receiveAmount, 18, 4)} {closeSide === "bull" ? "LLM" : "HKD"}</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">Fee</span>
              <span>0 (direct veto, bypasses wrapper)</span>
            </div>
            {shortfall > 0n && (
              <div className="flex justify-between gap-6 font-semibold text-bear">
                <span>Top-up required (fee deducted at open)</span>
                <span>{formatAmount(shortfall, 18, 4)} HKD</span>
              </div>
            )}
          </div>

          <div className="mt-2 flex justify-between text-xs text-text-dim">
            <span>Available {closeSide === "bull" ? "HKD" : "LLM"} balance: {formatAmount(balanceFor, 18, 4)}</span>
            {insufficient && <span className="text-bear">Insufficient balance</span>}
          </div>

          <button
            className={`mt-3 w-full rounded-lg py-3 text-sm font-bold transition-colors disabled:cursor-not-allowed ${
              closeSide === "bull" ? "bg-bull text-white hover:bg-bull/90 disabled:bg-bull/40" : "bg-bear text-white hover:bg-bear/90 disabled:bg-bear/40"
            }`}
            disabled={!canSubmit}
            onClick={() => (trade.needApproval ? trade.doApprove() : trade.doTrade())}
          >
            {buttonLabel}
          </button>

          <div className="mt-3">
            <TxStatusCard state={txState} />
          </div>
        </>
      )}
    </div>
  );
}