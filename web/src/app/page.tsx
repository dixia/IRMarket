"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { MarketCard } from "@/components/market/MarketCard";
import { FaucetModal } from "@/components/faucet/FaucetModal";
import { useMarketGroups, type MarketGroup } from "@/hooks/useMarketGroups";
import { useBalances } from "@/hooks/useBalances";
import { useHydrated } from "@/hooks/useHydrated";
import { useQuotes } from "@/hooks/useQuotes";
import { formatAmount } from "@/lib/format";
import { isFullyConfigured } from "@/lib/config";
import type { Quote } from "@/lib/types";

/** Quotes of one pair, newest last (stable order from the shared batch). */
function forPair(quotes: Quote[], group: MarketGroup): Quote[] {
  return quotes.filter(
    (q) => q.baseToken.toLowerCase() === group.baseToken.toLowerCase() && q.quoteToken.toLowerCase() === group.quoteToken.toLowerCase(),
  );
}

export default function HomePage() {
  const mounted = useHydrated();
  const { address } = useAccount();
  const groups = useMarketGroups();
  const { quotes, activeQuotes } = useQuotes(null);

  // One shared quotes batch (all pairs) — the cheapest way to mark every group on-chain.
  const prices = new Map<string, bigint>();
  for (const g of groups) {
    const key = `${g.baseToken.toLowerCase()}/${g.quoteToken.toLowerCase()}`;
    const activeForPair = forPair(activeQuotes, g);
    const all = forPair(quotes, g);
    const display =
      activeForPair.length > 0
        ? activeForPair[activeForPair.length - 1].price
        : all.length > 0
          ? all[all.length - 1].price
          : undefined;
    if (display !== undefined) prices.set(key, display);
  }

  const first = groups[0];
  const tokens = first ? { base: first.baseToken, quote: first.quoteToken } : null;
  const balances = useBalances(mounted ? address : undefined, tokens);

  const [faucetOpen, setFaucetOpen] = useState(false);

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
            className="rounded-lg bg-primary px-4 py-2 font-semibold text-white hover:bg-primary-dim transition-colors"
            onClick={() => setFaucetOpen(true)}
          >
            Claim test tokens
          </button>
          {mounted && address && first && (
            <span className="text-text-dim">
              Wallet balance · {first.quoteSymbol} <span className="text-primary">{formatAmount(balances.quote, first.quoteDecimals, 2)}</span>
              {"  ·  "}
              {first.baseSymbol} <span className="text-primary">{formatAmount(balances.base, first.baseDecimals, 2)}</span>
            </span>
          )}
        </div>
      </section>

      {/* markets — one card per asset pair, current round only (past rounds are history, not duplicated cards) */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Market</h2>
          <span className="text-xs text-text-dim">Symmetric long/short · 3-minute expiry · transactional quotes</span>
        </div>

        {groups.length === 0 ? (
          <p className="text-sm text-text-dim">No markets yet.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {groups.map((g) => {
              const key = `${g.baseToken.toLowerCase()}/${g.quoteToken.toLowerCase()}`;
              return (
                <GroupCard key={key} group={g} price={prices.get(key)} />
              );
            })}
          </div>
        )}
      </section>

      {(!isFullyConfigured && (
        <p className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm text-primary">
            Contract addresses not configured — live quotes and trading will appear once configured.
          </p>
      )) ||
        null}

      <FaucetModal open={faucetOpen} onClose={() => setFaucetOpen(false)} />
    </div>
  );
}

function GroupCard({ group, price }: { group: MarketGroup; price: bigint | undefined }) {
  if (!group.market) return null;
  return (
    <MarketCard
      market={group.market}
      price={price}
      roundExpiry={group.active?.expiryBlock}
      expired={!group.active}
      liveRounds={group.rounds.filter((r) => r.live).length}
    />
  );
}
