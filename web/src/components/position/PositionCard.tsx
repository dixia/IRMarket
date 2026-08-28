"use client";

import { useCurrentBlock } from "@/hooks/useCurrentBlock";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { formatAmount, formatPnl, formatPrice } from "@/lib/format";
import { BlockCountdown } from "@/components/market/BlockCountdown";
import type { Position } from "@/lib/types";

/**
 * Mark-to-market a position with the current price (1e18). Returns value & pnl in the
 * quote token's own unit.
 * bull: value = heldBase × price ; cost = paidQuote
 * bear: value = heldQuote        ; cost = paidBase × openPrice (quote equivalent)
 */
export function computePositionValuation(p: Position, price: bigint | undefined) {
  if (price === undefined) return { value: undefined as bigint | undefined, cost: undefined as bigint | undefined, pnl: undefined as bigint | undefined };
  if (p.side === "bull") {
    const value = (p.heldBase * price) / 10n ** 18n;
    return { value, cost: p.paidQuote, pnl: value - p.paidQuote };
  }
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

  const metaMap = useTokenMeta([position.baseToken, position.quoteToken]);
  const baseMeta = metaMap.get(position.baseToken.toLowerCase()) ?? { symbol: "???", decimals: 18 };
  const quoteMeta = metaMap.get(position.quoteToken.toLowerCase()) ?? { symbol: "???", decimals: 18 };

  const sideLabel = position.side === "bull"
    ? `Long · Holds ${baseMeta.symbol}`
    : `Short · Holds ${quoteMeta.symbol}`;
  const marketValue = position.side === "bull"
    ? `${formatAmount(position.heldBase, baseMeta.decimals, 4)} ${baseMeta.symbol}`
    : `${formatAmount(position.heldQuote, quoteMeta.decimals, 4)} ${quoteMeta.symbol}`;

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
              {sideLabel}
            </span>
            <span className="rounded-md bg-card-border/40 px-2 py-0.5 text-[11px] text-text-dim">
              #{position.quoteId.toString()}
            </span>
          </div>
          <div className="mt-3 space-y-1 text-sm">
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">Open price</span>
              <span>{formatPrice(position.openPrice)} {quoteMeta.symbol}/{baseMeta.symbol}</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">Current quote</span>
              <span>
                {settling ? "Settling…" : formatPrice(price)}
              </span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">{expired ? "Final value" : "Market value"}</span>
              <span>{marketValue}</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">{expired ? "Final PnL" : "Floating PnL"}</span>
              <span className={pnl !== undefined && pnl >= 0n ? "text-bull" : "text-bear"}>
                {settling ? "Settling…" : formatPnl(pnl)}
              </span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-text-dim">Expiry</span>
              <BlockCountdown expiryBlock={position.expiryBlock} />
            </div>
          </div>
        </div>
        <div className="shrink-0">
          {expired ? (
            <span className="rounded-md bg-primary/15 px-2 py-1 text-xs font-semibold text-primary">
              Settled
            </span>
          ) : (
            canClose && (
              <button
                className="rounded-lg border border-primary px-3 py-1.5 text-sm text-primary hover:bg-primary/10 transition-colors"
                onClick={() => onClose(position)}
              >
                Reverse close
              </button>
            )
          )}
        </div>
      </div>
      {expired && (
        <p className="mt-3 text-xs text-text-dim">
          Final PnL is marked at the final price; the assets are already in your wallet —
          reverse-close to cash out or hold. No settlement or claim needed.
        </p>
      )}
    </div>
  );
}
