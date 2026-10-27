"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { MarketCard } from "@/components/market/MarketCard";
import { TradePanel } from "@/components/trade/TradePanel";
import { useMarkets } from "@/hooks/useMarkets";
import { useCurrentBlock } from "@/hooks/useCurrentBlock";
import { useReferencePrice } from "@/hooks/useReferencePrice";
import { BlockCountdown } from "@/components/market/BlockCountdown";
import { formatPrice } from "@/lib/format";
import { formatCountdown } from "@/lib/countdown";
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
  const router = useRouter();
  const m = Number(params.get("m") ?? "");
  const side = params.get("side");
  const markets = useMarkets();

  const market = useMemo(
    () => (m && !Number.isNaN(m) ? markets.find((item) => Number(item.marketId) === m) : undefined) ?? markets[0],
    [markets, m],
  );

  const onMarketChange = (nextMarketId: string) => {
    const current = new URLSearchParams(params.toString());
    current.set("m", nextMarketId);
    router.push(`?${current.toString()}`);
  };

  const price = useReferencePrice(
    market && isFullyConfigured ? { base: market.baseToken, quote: market.quoteToken } : null,
  );

  // Symbol/decimals come preloaded on each market (single shared token-meta read in useMarkets).
  const baseMeta = market
    ? { symbol: market.baseSymbol, decimals: market.baseDecimals }
    : { symbol: "LLM", decimals: 18 };
  const quoteMeta = market
    ? { symbol: market.quoteSymbol, decimals: market.quoteDecimals }
    : { symbol: "HKD", decimals: 18 };

  const blockNumber = useCurrentBlock();

  // Rounds of the selected market's pair: live soonest-expiring first, past newest first.
  const pairRounds = useMemo(() => {
    if (!market) return null;
    const base = market.baseToken.toLowerCase();
    const quote = market.quoteToken.toLowerCase();
    const pair = markets.filter(
      (r) => r.baseToken.toLowerCase() === base && r.quoteToken.toLowerCase() === quote,
    );
    if (blockNumber === undefined) {
      return { live: [...pair].sort((a, b) => Number(a.marketId) - Number(b.marketId)), past: [] };
    }
    const live = pair.filter((r) => r.expiryBlock > blockNumber)
      .sort((a, b) => (a.expiryBlock < b.expiryBlock ? -1 : 1));
    const past = pair.filter((r) => r.expiryBlock <= blockNumber)
      .sort((a, b) => (a.expiryBlock > b.expiryBlock ? -1 : 1));
    return { live, past };
  }, [market, markets, blockNumber]);

  const roundLabel = (expiryBlock: bigint): string => {
    if (blockNumber === undefined) return "";
    const left = expiryBlock - blockNumber;
    if (left <= 0n) return " · expired";
    return ` · ~${formatCountdown(left)}`;
  };

  if (!market) {
    return <p className="text-sm text-text-dim">Market not found.</p>;
  }

  return (
    <div className="space-y-6">
      {/* header */}
      <section>
        <div className="flex items-center justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold">{market.name}</h1>
            <span className="rounded-md bg-card-border/40 px-2 py-0.5 text-xs text-text-dim">
              {market.ticker}
            </span>
            {pairRounds !== null && pairRounds.live.length + pairRounds.past.length > 1 && (
              <select
                className="rounded-lg border border-card-border bg-card px-2 py-1 text-xs"
                value={market.marketId.toString()}
                onChange={(e) => onMarketChange(e.target.value)}
                aria-label="Select round (expiry)"
              >
                <optgroup label="Live rounds">
                  {pairRounds.live.map((r) => (
                    <option key={r.marketId.toString()} value={r.marketId.toString()}>
                      #{r.marketId.toString()} · live{roundLabel(r.expiryBlock)}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Past rounds">
                  {pairRounds.past.map((r) => (
                    <option key={r.marketId.toString()} value={r.marketId.toString()}>
                      #{r.marketId.toString()} · expired
                    </option>
                  ))}
                </optgroup>
              </select>
            )}
          </div>
          <div className="text-right">
            <div className="kicker text-text-dim">Expiry</div>
            <BlockCountdown expiryBlock={market.expiryBlock} />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat
            label="Current price"
            value={
              price.status === "ok"
                ? `${formatPrice(price.price)} ${quoteMeta.symbol}/${baseMeta.symbol}`
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
          Final price settling — the price shown is from the previous round.
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
      <div className="kicker text-text-dim">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold ${accent ? "text-primary" : ""}`}>{value}</div>
    </div>
  );
}