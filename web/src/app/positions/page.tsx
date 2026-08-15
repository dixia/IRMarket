"use client";

import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { useMarkets } from "@/hooks/useMarkets";
import { usePositions } from "@/hooks/usePositions";
import { useQuotes } from "@/hooks/useQuotes";
import { useHydrated } from "@/hooks/useHydrated";
import { useReferencePrice } from "@/hooks/useReferencePrice";
import { PositionCard, computePositionValuation } from "@/components/position/PositionCard";
import { ClosePanel } from "@/components/position/ClosePanel";
import { useCurrentBlock } from "@/hooks/useCurrentBlock";
import { isFullyConfigured } from "@/lib/config";
import type { Position } from "@/lib/types";

export default function PositionsPage() {
  const mounted = useHydrated();
  const { address } = useAccount();
  const account = mounted ? address : undefined;
  const markets = useMarkets();
  const market = markets.length > 0 ? markets[0] : undefined;

  const pair = useMemo(
    () => (market && isFullyConfigured ? { base: market.baseToken, quote: market.quoteToken } : null),
    [market],
  );

  const { positions, refetch } = usePositions(account);
  const priceState = useReferencePrice(pair);
  const blockNumber = useCurrentBlock();
  const { activeQuotes } = useQuotes(pair);

  const [tab, setTab] = useState<"open" | "settled">("open");
  const [closing, setClosing] = useState<Position | null>(null);

  const mark = priceState.status === "ok" ? priceState.price : undefined;
  const settling = priceState.status === "settling";

  const isExpired = (p: Position) => blockNumber !== undefined && p.expiryBlock < blockNumber;

  const openPositions = positions.filter((p) => !isExpired(p));
  const settledPositions = positions.filter((p) => isExpired(p));

  const visible = tab === "open" ? openPositions : settledPositions;

  const canClose = (p: Position) =>
    !isExpired(p) && activeQuotes.some((q) => q.expiryBlock >= (blockNumber ?? 0n));

  const totalPnl = openPositions.reduce((sum, p) => {
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
            <div className="text-xs text-text-dim">进行中浮动盈亏</div>
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

      {!account ? (
        <p className="rounded-lg border border-card-border bg-card p-4 text-sm text-text-dim">
          连接钱包以查看持仓。
        </p>
      ) : positions.length === 0 ? (
        <div className="rounded-xl border border-card-border bg-card p-8 text-center">
          <p className="text-sm text-text-dim">还没有持仓。—— 前往市场页开一单看涨或看跌试试。</p>
        </div>
      ) : (
        <>
          {/* tabs: 进行中 / 已结算 */}
          <div className="flex gap-2">
            <TabButton active={tab === "open"} onClick={() => setTab("open")}>
              进行中 ({openPositions.length})
            </TabButton>
            <TabButton active={tab === "settled"} onClick={() => setTab("settled")}>
              已结算 ({settledPositions.length})
            </TabButton>
          </div>

          {closing && (
            <ClosePanel
              position={closing}
              baseToken={market?.baseToken}
              quoteToken={market?.quoteToken}
              onClosed={() => setClosing(null)}
            />
          )}

          {settling && tab === "open" && (
            <p className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm text-primary">
              终价结算中（等待 settle）—— bot 正在结算最终报价，稍后显示终价。
            </p>
          )}

          {visible.length === 0 ? (
            <p className="text-sm text-text-dim">
              {tab === "open" ? "没有进行中的持仓。" : "没有已结算的持仓。"}
            </p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {visible.map((p) => (
                <PositionCard
                  key={p.id}
                  position={p}
                  price={mark}
                  settling={settling}
                  canClose={canClose(p)}
                  onClose={(pos) => setClosing(pos)}
                />
              ))}
            </div>
          )}
        </>
      )}

      <p className="text-xs text-text-dim">
        说明：持仓由链上事件实时派生的，无需再领取（无中央账本）。反向平仓 = 使用当前 bot 报价买入相反方向，
        直接否决、无手续费；看跌平仓需补足与开仓手续费的差额。
      </p>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
        active ? "bg-primary text-black" : "bg-card text-text-dim hover:text-text"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}