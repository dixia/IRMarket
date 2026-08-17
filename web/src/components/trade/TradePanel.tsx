"use client";

import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { Quote, Side } from "@/lib/types";
import { computeFee, formatAmount, formatCountdown, formatPrice } from "@/lib/format";
import { useQuotes } from "@/hooks/useQuotes";
import { useBalances } from "@/hooks/useBalances";
import { useHydrated } from "@/hooks/useHydrated";
import { useAllowance, payableFor, useTrade, TradeKind } from "@/hooks/useTrade";
import { TxStatusCard, mapTransactionError, TxState } from "@/components/common/TxStatusCard";
import { useCurrentBlock } from "@/hooks/useCurrentBlock";
import { isFullyConfigured } from "@/lib/config";

function QuoteCard({ quote, blockNumber }: { quote: Quote; blockNumber: bigint | undefined }) {
  const expired = blockNumber !== undefined && quote.expiryBlock < blockNumber;
  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center justify-between text-xs text-text-dim">
        <span>Quote #{quote.quoteId.toString()}</span>
        {expired ? (
          <span className="text-bear">Expired</span>
        ) : (
          <span className="text-primary">
            Expires in {blockNumber !== undefined ? formatCountdown(quote.expiryBlock - blockNumber) : "…"}
          </span>
        )}
      </div>
      <div className="mt-1 text-2xl font-bold text-primary">
        {formatPrice(quote.price)} HKD/LLM
      </div>
      <div className="mt-1 text-xs text-text-dim">
        Quote size (all-or-nothing): pay {formatAmount(quote.quoteAmount, 18, 4)} HKD / receive {formatAmount(quote.baseAmount, 18, 4)} LLM
      </div>
    </div>
  );
}

export function TradePanel({
  baseToken,
  quoteToken,
  marketId,
  feeBps,
  initialSide,
}: {
  baseToken: `0x${string}` | undefined;
  quoteToken: `0x${string}` | undefined;
  marketId: bigint;
  feeBps: bigint;
  initialSide?: Side;
}) {
  const mounted = useHydrated();
  const { address } = useAccount();
  const account = mounted ? address : undefined;
  const { activeQuotes } = useQuotes(baseToken && quoteToken ? { base: baseToken, quote: quoteToken } : null);
  const blockNumber = useCurrentBlock();
  const balances = useBalances(account);
  // null until the user picks a tab; then it locks in (route side only pre-selects).
  const [manualSide, setManualSide] = useState<Side | null>(null);
  const side: Side = manualSide ?? initialSide ?? "bull";

  const active = activeQuotes.filter((q) => blockNumber === undefined || q.expiryBlock >= blockNumber);
  const selected: Quote | undefined = active.length > 0 ? active[active.length - 1] : undefined;

  // payable + preview
  const preview = useMemo(() => {
    if (!selected) return null;
    const fee = computeFee(selected.quoteAmount, feeBps);
    if (side === "bull") {
      return {
        payLabel: "HKD",
        payAmount: selected.quoteAmount + fee,
        receiveLabel: "LLM",
        receiveAmount: selected.baseAmount,
        fee,
        maxLoss: selected.quoteAmount + fee,
      };
    }
    return {
      payLabel: "LLM",
      payAmount: selected.baseAmount,
      receiveLabel: "HKD",
      receiveAmount: selected.quoteAmount - fee,
      fee,
      maxLoss: selected.baseAmount,
    };
  }, [selected, side, feeBps]);

  // allowance gating
  const payable = payableFor(side, "open", true);
  const { data: allowance } = useAllowance(payable.token, account, payable.spender);
  const requiredAmount = preview?.payAmount ?? 0n;

  const request = useMemo(() => {
    if (!selected || !preview) return null;
    return {
      side,
      kind: "open" as TradeKind,
      marketId,
      quoteId: selected.quoteId,
      requiredAmount,
      approveToken: payable.token,
      approveSpender: payable.spender,
    };
  }, [selected, preview, side, marketId, requiredAmount, payable.token, payable.spender]);

  const trade = useTrade(request, allowance as bigint | undefined);

  const balanceFor = side === "bull" ? balances.hkd : balances.llm;
  const insufficientBalance = preview !== null && balanceFor !== undefined && balanceFor < preview.payAmount;

  const txState: TxState = useMemo(() => {
    if (trade.phase === "approving" || trade.phase === "trading") {
      return { status: "loading", label: trade.phase === "approving" ? "Awaiting approval signature…" : "Awaiting transaction confirmation…" };
    }
    if (trade.phase === "success" && trade.tradeHash) {
      return {
        status: "success",
        hash: trade.tradeHash,
        title: "Position opened",
        detail: "Assets were settled to your wallet instantly — view them on the positions page.",
      };
    }
    if (trade.phase === "error" && trade.error) {
      return { status: "error", message: mapTransactionError(trade.error) };
    }
    return { status: "idle" };
  }, [trade]);

  const canTrade = isFullyConfigured && !!account && !!selected && !insufficientBalance && !trade.phase?.startsWith("approv") && trade.phase !== "trading";

  const buttonLabel = !account
    ? "Connect wallet"
    : !selected
      ? "No quote available"
      : insufficientBalance
        ? "Insufficient balance"
        : trade.needApproval
          ? "Approve"
          : side === "bull"
            ? "Confirm long position"
            : "Confirm short position";

  return (
    <div className="rounded-xl border border-card-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Trade panel</h2>
        <span className="text-xs text-text-dim">Long/short market · 3-minute default expiry · reverse-close anytime · no liquidations</span>
      </div>

      {!isFullyConfigured && (
        <div className="mt-3 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm text-primary">
          Contract addresses not configured; trading starts once the bot posts quotes.
        </div>
      )}

      {isFullyConfigured && !selected && (
        <div className="mt-3 rounded-lg border border-bear/30 bg-bear/5 p-3 text-sm text-bear">
          No quote available — bot paused or out of collateral (waiting for quotes).
        </div>
      )}

      {isFullyConfigured && selected && (
        <div className="mt-3">
          <QuoteCard quote={selected} blockNumber={blockNumber} />

          {/* tabs */}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                side === "bull" ? "bg-primary text-black" : "bg-card-border/40 text-text-dim hover:bg-card-border/60"
              }`}
              onClick={() => setManualSide("bull")}
            >
              Long
            </button>
            <button
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                side === "bear" ? "bg-primary text-black" : "bg-card-border/40 text-text-dim hover:bg-card-border/60"
              }`}
              onClick={() => setManualSide("bear")}
            >
              Short
            </button>
          </div>

          {/* preview */}
          <div className="mt-3 rounded-lg bg-card-border/20 p-3 text-sm space-y-1">
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">Pay</span>
              <span>{preview ? formatAmount(preview.payAmount, 18, 4) : "—"} {preview?.payLabel}</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">Receive</span>
              <span>{preview ? formatAmount(preview.receiveAmount, 18, 4) : "—"} {preview?.receiveLabel}</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">Fee ({Number(feeBps) / 100}%)</span>
              <span>{preview ? formatAmount(preview.fee, 18, 4) : "—"} HKD</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">Fill price</span>
              <span>{selected ? formatPrice(selected.price) : "—"}</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">Max loss</span>
              <span className="text-bear">{preview ? formatAmount(preview.maxLoss, 18, 4) : "—"}</span>
            </div>
          </div>

          <div className="mt-2 flex justify-between text-xs text-text-dim">
            <span>{side === "bull" ? "Available HKD balance" : "Available LLM balance"}: {formatAmount(balanceFor, 18, 4)}</span>
            {insufficientBalance && <span className="text-bear">Insufficient balance</span>}
          </div>

          {/* order button */}
          <button
            className={`mt-3 w-full rounded-lg py-3 text-sm font-bold transition-colors disabled:cursor-not-allowed ${
              side === "bull"
                ? "bg-bull text-white hover:bg-bull/90 disabled:bg-bull/40"
                : "bg-bear text-white hover:bg-bear/90 disabled:bg-bear/40"
            }`}
            disabled={!canTrade}
            onClick={() => (trade.needApproval ? trade.doApprove() : trade.doTrade())}
          >
            {buttonLabel}
          </button>

          <div className="mt-3">
            <TxStatusCard state={txState} />
          </div>
        </div>
      )}
    </div>
  );
}