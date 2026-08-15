"use client";

import Link from "next/link";
import { BlockCountdown } from "./BlockCountdown";
import { toNumberString } from "@/lib/format";
import type { MarketWithMeta } from "@/lib/types";

export function MarketCard({
  market,
  price,
}: {
  market: MarketWithMeta;
  price: bigint | undefined;
}) {
  return (
    <Link
      href={`/market?id=${market.marketId.toString()}`}
      className="group block rounded-xl border border-card-border bg-card p-4 transition-colors hover:border-primary/40"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{market.name}</span>
          <span className="rounded-md bg-card-border/40 px-1.5 py-0.5 text-[11px] text-text-dim">
            {market.ticker}
          </span>
        </div>
        <span className="text-[11px] text-text-dim">港股食品股</span>
      </div>

      <div className="mt-3 flex items-end justify-between">
        <div>
          <div className="text-xs text-text-dim">当前价格 (HKD)</div>
          <div className="text-2xl font-bold text-primary">
            {price !== undefined ? toNumberString(price, 6) : "—"}
          </div>
        </div>
        <div className="text-right text-xs text-text-dim">
          <div>到期</div>
          <BlockCountdown expiryBlock={market.expiryBlock} />
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <div className="flex gap-2">
          <span className="rounded-lg bg-bull/15 px-3 py-1 text-sm font-semibold text-bull">看涨</span>
          <span className="rounded-lg bg-bear/15 px-3 py-1 text-sm font-semibold text-bear">看跌</span>
        </div>
        <span className="text-text-dim transition-transform group-hover:translate-x-0.5">→</span>
      </div>
    </Link>
  );
}