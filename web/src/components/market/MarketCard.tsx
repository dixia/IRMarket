"use client";

import Link from "next/link";
import { BlockCountdown } from "./BlockCountdown";
import { formatPrice } from "@/lib/format";
import type { MarketWithMeta } from "@/lib/types";

export function MarketCard({
  market,
  price,
}: {
  market: MarketWithMeta;
  price: bigint | undefined;
}) {
  const href = `/trade?m=${market.marketId.toString()}`;

  return (
    <div className="block rounded-xl border border-card-border bg-card p-4 transition-colors hover:border-primary/40">
      <Link href={href} className="group block">
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
              {formatPrice(price)}
            </div>
          </div>
          <div className="text-right text-xs text-text-dim">
            <div>到期</div>
            <BlockCountdown expiryBlock={market.expiryBlock} />
          </div>
        </div>
      </Link>

      <div className="mt-4 flex items-center justify-between">
        <div className="flex gap-2">
          <Link
            href={`${href}&side=long`}
            className="rounded-lg bg-bull/15 px-3 py-1 text-sm font-semibold text-bull hover:bg-bull/25 transition-colors"
          >
            看涨
          </Link>
          <Link
            href={`${href}&side=short`}
            className="rounded-lg bg-bear/15 px-3 py-1 text-sm font-semibold text-bear hover:bg-bear/25 transition-colors"
          >
            看跌
          </Link>
        </div>
        <Link href={href} className="text-text-dim transition-transform hover:translate-x-0.5" aria-label="进入交易">
          →
        </Link>
      </div>
    </div>
  );
}