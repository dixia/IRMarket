"use client";

import Link from "next/link";
import { BlockCountdown } from "./BlockCountdown";
import { formatPrice } from "@/lib/format";
import { assetName } from "@/lib/assets";
import { TOKEN_META_PENDING, type MarketWithMeta } from "@/lib/types";

/** Skeleton while the on-chain symbol()/decimals() read has not resolved yet. */
function Meta({ value }: { value: string }) {
  return <span className="opacity-60">{value === TOKEN_META_PENDING ? "…" : value}</span>;
}

export function MarketCard({
  market,
  price,
  roundExpiry,
  expired = false,
  liveRounds = 1,
}: {
  market: MarketWithMeta;
  price: bigint | undefined;
  /** Countdown target = the ACTIVE ROUND's QUOTE expiryBlock (one-market-per-pair; docs/web-tech-design.md §4.2):
   *  market.expiryBlock is inert, so the caller must pass the round expiry. */
  roundExpiry?: bigint;
  /** No live quote round is ahead of the current block — the card links to the trade page and pends the next round. */
  expired?: boolean;
  /** How many quote rounds of this asset are live right now; >1 hints more expiries inside the trade page. */
  liveRounds?: number;
}) {
  const href = `/trade?m=${market.marketId.toString()}`;

  return (
    <div className="block rounded-xl border border-card-border bg-card p-4 transition-colors hover:border-primary/40">
      <Link href={href} className="group block">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-semibold">
              <Meta value={market.name} />
            </span>
            <span className="rounded-md bg-card-border/40 px-1.5 py-0.5 text-[11px] text-text-dim">
              <Meta value={market.ticker} />
            </span>
          </div>
          <span className="text-[11px] text-text-dim">
            <Meta value={market.baseSymbol === TOKEN_META_PENDING ? TOKEN_META_PENDING : assetName(market.baseSymbol)} />
          </span>
        </div>

        <div className="mt-3 flex items-end justify-between">
          <div>
            <div className="text-xs text-text-dim">
              Current price (<Meta value={market.quoteSymbol} />)
            </div>
            <div className="text-2xl font-bold text-primary">{formatPrice(price)}</div>
          </div>
          <div className="text-right text-xs text-text-dim">
            <div>Expiry</div>
            {/* Round countdown from the QUOTE expiry (inert market.expiryBlock is never used). */}
            <BlockCountdown expiryBlock={roundExpiry ?? market.expiryBlock} />
            {liveRounds > 1 && (
              <div className="mt-0.5 text-[11px] text-primary/80">
                {liveRounds} live rounds
              </div>
            )}
          </div>
        </div>
      </Link>

      {expired && (
        <div className="mt-2 text-[11px] text-bear/80">Round expired — next round soon</div>
      )}

      <div className="mt-3 flex items-center justify-between">
        <div className="flex gap-2">
          <Link
            href={`${href}&side=long`}
            className="rounded-lg bg-bull/15 px-3 py-1 text-sm font-semibold text-bull hover:bg-bull/25 transition-colors"
          >
            Long
          </Link>
          <Link
            href={`${href}&side=short`}
            className="rounded-lg bg-bear/15 px-3 py-1 text-sm font-semibold text-bear hover:bg-bear/25 transition-colors"
          >
            Short
          </Link>
        </div>
        <Link href={href} className="text-text-dim transition-transform hover:translate-x-0.5" aria-label="Open trading">
          →
        </Link>
      </div>
    </div>
  );
}
