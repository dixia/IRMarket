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
        <span>报价 #{quote.quoteId.toString()}</span>
        {expired ? (
          <span className="text-bear">已过期</span>
        ) : (
          <span className="text-primary">
            到期还剩 {blockNumber !== undefined ? formatCountdown(quote.expiryBlock - blockNumber) : "…"}
          </span>
        )}
      </div>
      <div className="mt-1 text-2xl font-bold text-primary">
        {formatPrice(quote.price)} HKD/LLM
      </div>
      <div className="mt-1 text-xs text-text-dim">
        报价规模（整单成交）: 付 {formatAmount(quote.quoteAmount, 18, 4)} HKD / 收 {formatAmount(quote.baseAmount, 18, 4)} LLM
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
      return { status: "loading", label: trade.phase === "approving" ? "等待授权签名…" : "等待交易确认…" };
    }
    if (trade.phase === "success" && trade.tradeHash) {
      return {
        status: "success",
        hash: trade.tradeHash,
        title: "开仓成功",
        detail: `已收到资产并实时到账，可在持仓页查看。`,
      };
    }
    if (trade.phase === "error" && trade.error) {
      return { status: "error", message: mapTransactionError(trade.error) };
    }
    return { status: "idle" };
  }, [trade]);

  const canTrade = isFullyConfigured && !!account && !!selected && !insufficientBalance && !trade.phase?.startsWith("approv") && trade.phase !== "trading";

  const buttonLabel = !account
    ? "连接钱包"
    : !selected
      ? "无可用报价"
      : insufficientBalance
        ? "余额不足"
        : trade.needApproval
          ? "授权"
          : side === "bull"
            ? "确认看涨开仓"
            : "确认看跌开仓";

  return (
    <div className="rounded-xl border border-card-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">交易面板</h2>
        <span className="text-xs text-text-dim">多空市场 · 默认 3 分钟到期 · 随时反向平仓 · 无爆仓风险</span>
      </div>

      {!isFullyConfigured && (
        <div className="mt-3 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm text-primary">
          合约尚未配置部署地址，等待 bot 建立报价后即可交易。
        </div>
      )}

      {isFullyConfigured && !selected && (
        <div className="mt-3 rounded-lg border border-bear/30 bg-bear/5 p-3 text-sm text-bear">
          无可用报价 —— bot 暂停或抵押不足（等待报价中）。
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
              看涨（做多）
            </button>
            <button
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                side === "bear" ? "bg-primary text-black" : "bg-card-border/40 text-text-dim hover:bg-card-border/60"
              }`}
              onClick={() => setManualSide("bear")}
            >
              看跌（做空）
            </button>
          </div>

          {/* preview */}
          <div className="mt-3 rounded-lg bg-card-border/20 p-3 text-sm space-y-1">
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">付</span>
              <span>{preview ? formatAmount(preview.payAmount, 18, 4) : "—"} {preview?.payLabel}</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">收</span>
              <span>{preview ? formatAmount(preview.receiveAmount, 18, 4) : "—"} {preview?.receiveLabel}</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">手续费 ({Number(feeBps) / 100}%)</span>
              <span>{preview ? formatAmount(preview.fee, 18, 4) : "—"} HKD</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">成交价</span>
              <span>{selected ? formatPrice(selected.price) : "—"}</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">最大亏损</span>
              <span className="text-bear">{preview ? formatAmount(preview.maxLoss, 18, 4) : "—"}</span>
            </div>
          </div>

          <div className="mt-2 flex justify-between text-xs text-text-dim">
            <span>{side === "bull" ? "可用 HKD 余额" : "可用 LLM 余额"}: {formatAmount(balanceFor, 18, 4)}</span>
            {insufficientBalance && <span className="text-bear">余额不足</span>}
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