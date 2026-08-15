"use client";

import { formatAmount, formatPnl, formatPrice } from "@/lib/format";
import type { Position } from "@/lib/types";
import { BlockCountdown } from "@/components/market/BlockCountdown";
import { useCurrentBlock } from "@/hooks/useCurrentBlock";

/**
 * Mark-to-market a position with the current price (1e18). Returns value & pnl in HKD terms.
 * bull: value = heldBase × price ; cost = paidQuote
 * bear: value = heldQuote        ; cost = paidBase × openPrice (HKD equivalent)
 */
export function computePositionValuation(p: Position, price: bigint | undefined) {
  if (price === undefined) return { value: undefined as bigint | undefined, cost: undefined as bigint | undefined, pnl: undefined as bigint | undefined };
  if (p.side === "bull") {
    const value = (p.heldBase * price) / 10n ** 18n;
    return { value, cost: p.paidQuote, pnl: value - p.paidQuote };
  }
  // bear: value = HKD held (already 1e18). cost basis in HKD = paidBase × openPrice / 1e18.
  const cost = (p.paidBase * p.openPrice) / 10n ** 18n;
  return { value: p.heldQuote, cost, pnl: p.heldQuote - cost };
}

export function PositionCard({
  position,
  price,
  settling,
  onClose,
  canClose,
}: {
  position: Position;
  price?: bigint;
  settling?: boolean;
  onClose: (p: Position) => void;
  canClose: boolean;
}) {
  const blockNumber = useCurrentBlock();
  const expired = blockNumber !== undefined && position.expiryBlock <= blockNumber;
  const { pnl } = computePositionValuation(position, price);

  return (
    <div className="rounded-xl border border-card-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                position.side === "bull" ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear"
              }`}
            >
              {position.side === "bull" ? "看涨 · 持有 LLM" : "看跌 · 持有 HKD"}
            </span>
            <span className="rounded-md bg-card-border/40 px-2 py-0.5 text-[11px] text-text-dim">
              #{position.quoteId.toString()}
            </span>
          </div>
          <div className="mt-3 space-y-1 text-sm">
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">开仓价</span>
              <span>{formatPrice(position.openPrice)}</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">当前报价</span>
              <span>
                {settling ? "终价结算中…" : formatPrice(price)}
              </span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">{expired ? "最终市值" : "持仓市值"}</span>
              <span>
                {position.side === "bull"
                  ? `${formatAmount(position.heldBase, 18, 4)} LLM`
                  : `${formatAmount(position.heldQuote, 18, 4)} HKD`}
              </span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">{expired ? "最终盈亏" : "浮动盈亏"}</span>
              <span className={pnl !== undefined && pnl >= 0n ? "text-bull" : "text-bear"}>
                {settling ? "结算中…" : formatPnl(pnl)}
              </span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">到期</span>
              <BlockCountdown expiryBlock={position.expiryBlock} />
            </div>
          </div>
        </div>
        <div className="shrink-0">
          {expired ? (
            <span className="rounded-md bg-primary/15 px-2 py-1 text-xs font-semibold text-primary">
              已结算
            </span>
          ) : (
            canClose && (
              <button
                className="rounded-lg border border-primary px-3 py-1.5 text-sm text-primary hover:bg-primary/10 transition-colors"
                onClick={() => onClose(position)}
              >
                反向平仓
              </button>
            )
          )}
        </div>
      </div>
      {expired && (
        <p className="mt-3 text-xs text-text-dim">
          最终盈亏以终价标记；资产已在你的钱包，可反向平仓变现或继续持有。无需结算/领取。
        </p>
      )}
    </div>
  );
}