"use client";

import { useMemo } from "react";
import { useAccount } from "wagmi";
import { useMarkets } from "@/hooks/useMarkets";
import { usePositions } from "@/hooks/usePositions";
import { useQuotes } from "@/hooks/useQuotes";
import { useReferencePrice } from "@/hooks/useReferencePrice";
import { PositionCard, computePositionValuation } from "@/components/position/PositionCard";
import { useCurrentBlock } from "@/hooks/useCurrentBlock";
import { isFullyConfigured } from "@/lib/config";
import { Position } from "@/lib/types";

export default function PositionsPage() {
  const { address } = useAccount();
  const markets = useMarkets();
  const market = markets.length > 0 ? markets[0] : undefined;

  const pair = useMemo(
    () => (market && isFullyConfigured ? { base: market.baseToken, quote: market.quoteToken } : null),
    [market],
  );

  const { positions, refetch } = usePositions(address);
  const priceState = useReferencePrice(pair);
  const blockNumber = useCurrentBlock();
  const { activeQuotes } = useQuotes(pair);

  const mark = priceState.status === "ok" ? priceState.price : undefined;

  const canClose = (p: Position) => {
    if (blockNumber === undefined) return false;
    if (p.expiryBlock < blockNumber) return false;
    // need a live ACTIVE quote to reverse-veto against
    return activeQuotes.some((q) => q.expiryBlock >= blockNumber);
  };

  const totalPnl = positions.reduce((sum, p) => {
    const v = computePositionValuation(p, mark);
    return sum + (v.pnl ?? 0n);
  }, 0n);

  if (!isFullyConfigured) {
    return (
      <p className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm text-primary">
        合约尚未配置部署地址。配置后即可查看你在链上开的大小仓。
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">我的持仓</h1>
          <p className="mt-1 text-sm text-text-dim">
            事件派生 · 实时到账 · 随时反向平仓 · 无爆仓风险 · 最大亏损=整单报价
          </p>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-right">
            <div className="text-xs text-text-dim">总浮动盈亏</div>
            <div className={`text-lg font-bold ${totalPnl >= 0n ? "text-bull" : "text-bear"}`}>
              {totalPnl >= 0n ? "+" : ""}
              {(Number(totalPnl) / 10 ** 18).toFixed(2)} HKD
            </div>
          </div>
          <button
            className="rounded-lg border border-card-border px-3 py-2 text-sm text-text-dim hover:text-text transition-colors"
            onClick={() => refetch()}
          >
            刷新
          </button>
        </div>
      </section>

      {!address ? (
        <p className="rounded-lg border border-card-border bg-card p-4 text-sm text-text-dim">
          连接钱包以查看持仓。
        </p>
      ) : positions.length === 0 ? (
        <div className="rounded-xl border border-card-border bg-card p-8 text-center">
          <p className="text-sm text-text-dim">还没有持仓。—— 前往市场页开一单看涨或看跌试试。</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {positions.map((p) => (
            <PositionCard
              key={p.id}
              position={p}
              price={mark}
              canClose={canClose(p)}
              onClose={(pos) => {
                // reverse-veto close handled on the market page (query param side select)
                window.location.href = `/market?id=${pos.marketId?.toString() ?? "1"}`;
              }}
            />
          ))}
        </div>
      )}

      <p className="text-xs text-text-dim">
        说明：持仓由链上事件实时派生的，无需再领取（无中央账本）。反向平仓 = 使用当前 bot 报价买入相反方向。
      </p>
    </div>
  );
}