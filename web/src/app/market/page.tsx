"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { MarketCard } from "@/components/market/MarketCard";
import { TradePanel } from "@/components/trade/TradePanel";
import { useMarkets } from "@/hooks/useMarkets";
import { useReferencePrice } from "@/hooks/useReferencePrice";
import { BlockCountdown } from "@/components/market/BlockCountdown";
import { toNumberString } from "@/lib/format";
import { isFullyConfigured } from "@/lib/config";

export default function MarketDetailPage() {
  return (
    <Suspense fallback={<p className="text-sm text-text-dim">加载市场…</p>}>
      <MarketDetailContent />
    </Suspense>
  );
}

function MarketDetailContent() {
  const params = useSearchParams();
  const id = Number(params.get("id") ?? "1");
  const markets = useMarkets();

  const market = useMemo(
    () => markets.find((m) => Number(m.marketId) === id) ?? markets[0],
    [markets, id],
  );

  const price = useReferencePrice(
    market && isFullyConfigured ? { base: market.baseToken, quote: market.quoteToken } : null,
  );

  if (!market) {
    return <p className="text-sm text-text-dim">市场不存在。</p>;
  }

  return (
    <div className="space-y-6">
      {/* header */}
      <section>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{market.name}</h1>
            <span className="rounded-md bg-card-border/40 px-2 py-0.5 text-xs text-text-dim">
              {market.ticker}
            </span>
          </div>
          <div className="text-right">
            <div className="text-xs text-text-dim">到期</div>
            <BlockCountdown expiryBlock={market.expiryBlock} />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="当前价格" value={price.status === "ok" ? `${toNumberString(price.price, 6)} HKD` : "—"} accent />
          <Stat label="市场状态" value="Ongoing" />
          <Stat label="报价方式" value="Bot 报价" />
          <Stat label="手续费" value="1% (仅开仓)" />
        </div>
      </section>

      {/* market card snapshot */}
      <MarketCard market={market} price={price.status === "ok" ? price.price : undefined} />

      {/* trade panel */}
      <TradePanel
        baseToken={isFullyConfigured ? market.baseToken : undefined}
        quoteToken={isFullyConfigured ? market.quoteToken : undefined}
        marketId={market.marketId}
        feeBps={market.feeBps}
      />

      {/* how it works */}
      <section className="rounded-xl border border-card-border bg-card p-4">
        <h2 className="font-semibold">它是怎么结算的？</h2>
        <ul className="mt-3 grid gap-2 text-sm text-text-dim md:grid-cols-3">
          <li>1. 报价：bot 通过双边抵押提交价格报价，报价期内任何人可校验。</li>
          <li>2. 交易：看涨持有资产、看跌持有现金，方向看错最大亏损=整单报价，无爆仓。</li>
          <li>3. 结算：若报价失真，链上套利者行使否决权并扣抵押 —— 结算价由市场背书。</li>
        </ul>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-card-border bg-card p-3">
      <div className="text-xs text-text-dim">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold ${accent ? "text-primary" : ""}`}>{value}</div>
    </div>
  );
}