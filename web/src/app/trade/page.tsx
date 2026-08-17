"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { MarketCard } from "@/components/market/MarketCard";
import { TradePanel } from "@/components/trade/TradePanel";
import { useMarkets } from "@/hooks/useMarkets";
import { useReferencePrice } from "@/hooks/useReferencePrice";
import { BlockCountdown } from "@/components/market/BlockCountdown";
import { formatPrice } from "@/lib/format";
import { isFullyConfigured } from "@/lib/config";

export default function TradePage() {
  return (
    <Suspense fallback={<p className="text-sm text-text-dim">Loading market…</p>}>
      <TradeContent />
    </Suspense>
  );
}

function TradeContent() {
  const params = useSearchParams();
  const m = Number(params.get("m") ?? "1");
  const side = params.get("side");
  const markets = useMarkets();

  const market = useMemo(
    () => markets.find((item) => Number(item.marketId) === m) ?? markets[0],
    [markets, m],
  );

  const price = useReferencePrice(
    market && isFullyConfigured ? { base: market.baseToken, quote: market.quoteToken } : null,
  );

  if (!market) {
    return <p className="text-sm text-text-dim">Market not found.</p>;
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
            <div className="text-xs text-text-dim">Expiry</div>
            <BlockCountdown expiryBlock={market.expiryBlock} />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat
            label="Current price"
            value={
              price.status === "ok"
                ? `${formatPrice(price.price)} HKD`
                : price.status === "settling"
                  ? "Settling"
                  : "—"
            }
            accent
          />
          <Stat label="Market status" value="Ongoing" />
          <Stat label="Quote mode" value="Bot quotes" />
          <Stat label="Fee" value={`${Number(market.feeBps) / 100}% (open only)`} />
        </div>
      </section>

      {price.status === "settling" && (
        <p className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm text-primary">
          Final price settling — the last quote hasn&apos;t been settled yet; the price shown is from the
          previous round. Please wait.
        </p>
      )}

      {/* market card snapshot */}
      <MarketCard market={market} price={price.status === "ok" ? price.price : undefined} />

      {/* trade panel */}
      <TradePanel
        baseToken={isFullyConfigured ? market.baseToken : undefined}
        quoteToken={isFullyConfigured ? market.quoteToken : undefined}
        marketId={market.marketId}
        feeBps={market.feeBps}
        initialSide={side === "short" ? "bear" : side === "long" ? "bull" : undefined}
      />

      {/* how it works */}
      <section className="rounded-xl border border-card-border bg-card p-4">
        <h2 className="font-semibold">How does it settle?</h2>
        <ul className="mt-3 grid gap-2 text-sm text-text-dim md:grid-cols-3">
          <li>1. Quote: the bot posts a price backed by bilateral collateral; anyone can verify it during the quote window.</li>
          <li>2. Trade: bulls hold the asset, bears hold cash. Max loss = the full quote you paid; no liquidations.</li>
          <li>3. Settle: if a quote is off-market, on-chain arbitrageurs exercise the veto and slash collateral — the settlement price is market-backed.</li>
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