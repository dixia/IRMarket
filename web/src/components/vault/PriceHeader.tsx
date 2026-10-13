"use client";

import { useVaultMeta, useVaultPrice } from "@/hooks/useVault";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { formatPrice } from "@/lib/format";

/** Canonical settlement price (Monoracle price-only read). Trading is disabled when it is missing. */
export function PriceHeader() {
  const meta = useVaultMeta();
  const price = useVaultPrice();
  const metaMap = useTokenMeta([meta.priceBase ?? "0x", meta.settlementToken ?? "0x"]);
  const baseMeta = meta.priceBase
    ? (metaMap.get(meta.priceBase.toLowerCase()) ?? { symbol: "BASE", decimals: 18 })
    : { symbol: "BASE", decimals: 18 };
  const quoteMeta = meta.settlementToken
    ? (metaMap.get(meta.settlementToken.toLowerCase()) ?? { symbol: "QUOTE", decimals: 18 })
    : { symbol: "QUOTE", decimals: 18 };

  return (
    <div className="rounded-xl border border-card-border bg-card p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs text-text-dim">Canonical settlement price</div>
          {price.isLoading ? (
            <div className="mt-1 text-2xl font-bold text-text-dim">…</div>
          ) : price.exists ? (
            <div className="mt-1 text-2xl font-bold text-primary">
              {formatPrice(price.price)} {quoteMeta.symbol}/{baseMeta.symbol}
            </div>
          ) : (
            <div className="mt-1 text-2xl font-bold text-bear">Price unavailable</div>
          )}
        </div>
        <div className="max-w-xs text-right text-xs text-text-dim">
          settlement = Monoracle canonical price
        </div>
      </div>
      {!price.isLoading && !price.exists && (
        <p className="mt-2 text-xs text-bear">
          Trading and settlement previews are disabled until a price exists.
        </p>
      )}
    </div>
  );
}
