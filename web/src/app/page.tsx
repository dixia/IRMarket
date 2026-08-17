"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { MarketCard } from "@/components/market/MarketCard";
import { FaucetModal } from "@/components/faucet/FaucetModal";
import { useMarkets } from "@/hooks/useMarkets";
import { useBalances } from "@/hooks/useBalances";
import { useHydrated } from "@/hooks/useHydrated";
import { useReferencePrice } from "@/hooks/useReferencePrice";
import { formatAmount } from "@/lib/format";
import { isFullyConfigured } from "@/lib/config";

export default function HomePage() {
  const mounted = useHydrated();
  const { address } = useAccount();
  const markets = useMarkets();
  const balances = useBalances(mounted ? address : undefined);
  const [faucetOpen, setFaucetOpen] = useState(false);

  const market = markets.length > 0 ? markets[0] : undefined;
  const price = useReferencePrice(
    market && isFullyConfigured ? { base: market.baseToken, quote: market.quoteToken } : null,
  );

  return (
    <div className="space-y-8">
      {/* hero */}
      <section className="rounded-2xl border border-card-border bg-card p-6 md:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
              Anything with a price can become an option
            </h1>
            <p className="mt-2 max-w-xl text-sm text-text-dim">
              A-shares, Labubu, sports cards… — Monoracle veto-arbitrage settlement: every settlement price is
              backed by bilateral collateral and on-chain arbitrageurs. No price feeds, no validator nodes.
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3 text-sm">
          <button
            className="rounded-lg bg-primary px-4 py-2 font-semibold text-black hover:bg-primary-dim transition-colors"
            onClick={() => setFaucetOpen(true)}
          >
            Claim test tokens
          </button>
          {mounted && address && (
            <span className="text-text-dim">
              Wallet balance · HKD <span className="text-primary">{formatAmount(balances.hkd, 18, 2)}</span>
              {"  ·  "}
              LLM <span className="text-primary">{formatAmount(balances.llm, 18, 2)}</span>
            </span>
          )}
        </div>
      </section>

      {/* markets */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Market</h2>
          <span className="text-xs text-text-dim">Symmetric long/short · 3-minute expiry · transactional quotes</span>
        </div>

        {markets.length === 0 ? (
          <p className="text-sm text-text-dim">No markets yet.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {markets.map((m) => (
              <MarketCard
                key={m.marketId.toString()}
                market={m}
                price={price.status === "ok" ? price.price : undefined}
              />
            ))}
          </div>
        )}
      </section>

      {price.status === "settling" && (
        <p className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm text-primary">
          Final price settling — the bot is settling the final quote.
        </p>
      )}

      {(!isFullyConfigured && (
        <p className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm text-primary">
            Contract addresses not configured (missing NEXT_PUBLIC_ORACLE_ADDRESS / BASE_TOKEN / QUOTE_TOKEN).
            Live quotes and trading will appear once configured.
          </p>
      )) ||
        null}

      <FaucetModal open={faucetOpen} onClose={() => setFaucetOpen(false)} />
    </div>
  );
}