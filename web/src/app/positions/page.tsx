"use client";

import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { useMarkets } from "@/hooks/useMarkets";
import { usePositions } from "@/hooks/usePositions";
import { useQuotes } from "@/hooks/useQuotes";
import { useHydrated } from "@/hooks/useHydrated";
import { useReferencePrice } from "@/hooks/useReferencePrice";
import { PositionCard, computePositionValuation } from "@/components/position/PositionCard";
import { ClosePanel } from "@/components/position/ClosePanel";
import { useCurrentBlock } from "@/hooks/useCurrentBlock";
import { isFullyConfigured } from "@/lib/config";
import type { Position } from "@/lib/types";

export default function PositionsPage() {
  const mounted = useHydrated();
  const { address } = useAccount();
  const account = mounted ? address : undefined;
  const markets = useMarkets();
  const market = markets.length > 0 ? markets[0] : undefined;

  const pair = useMemo(
    () => (market && isFullyConfigured ? { base: market.baseToken, quote: market.quoteToken } : null),
    [market],
  );

  const { positions, refetch } = usePositions(account);
  const priceState = useReferencePrice(pair);
  const blockNumber = useCurrentBlock();
  const { activeQuotes } = useQuotes(pair);

  const [tab, setTab] = useState<"open" | "settled">("open");
  const [closing, setClosing] = useState<Position | null>(null);

  const mark = priceState.status === "ok" ? priceState.price : undefined;
  const settling = priceState.status === "settling";

  const isExpired = (p: Position) => blockNumber !== undefined && p.expiryBlock < blockNumber;

  const openPositions = positions.filter((p) => !isExpired(p));
  const settledPositions = positions.filter((p) => isExpired(p));

  const visible = tab === "open" ? openPositions : settledPositions;

  const canClose = (p: Position) =>
    !isExpired(p) && activeQuotes.some((q) => q.expiryBlock >= (blockNumber ?? 0n));

  const totalPnl = openPositions.reduce((sum, p) => {
    const v = computePositionValuation(p, mark);
    return sum + (v.pnl ?? 0n);
  }, 0n);

  if (!isFullyConfigured) {
    return (
      <p className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm text-primary">
        The contract deployment addresses aren&apos;t configured. Once configured you&apos;ll be able to
        see your on-chain positions.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">My positions</h1>
          <p className="mt-1 text-sm text-text-dim">
            Event-derived · instantly settled · reverse-close anytime · no liquidations · max loss = full quote
          </p>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-right">
            <div className="text-xs text-text-dim">Open PnL</div>
            <div className={`text-lg font-bold ${totalPnl >= 0n ? "text-bull" : "text-bear"}`}>
              {totalPnl >= 0n ? "+" : ""}
              {(Number(totalPnl) / 10 ** 18).toFixed(2)} HKD
            </div>
          </div>
          <button
            className="rounded-lg border border-card-border px-3 py-2 text-sm text-text-dim hover:text-text transition-colors"
            onClick={() => refetch()}
          >
            Refresh
          </button>
        </div>
      </section>

      {!account ? (
        <p className="rounded-lg border border-card-border bg-card p-4 text-sm text-text-dim">
          Connect a wallet to view your positions.
        </p>
      ) : positions.length === 0 ? (
        <div className="rounded-xl border border-card-border bg-card p-8 text-center">
          <p className="text-sm text-text-dim">No positions yet. — Head to the market page and open a long or short to try it out.</p>
        </div>
      ) : (
        <>
          {/* tabs: open / settled */}
          <div className="flex gap-2">
            <TabButton active={tab === "open"} onClick={() => setTab("open")}>
              Open ({openPositions.length})
            </TabButton>
            <TabButton active={tab === "settled"} onClick={() => setTab("settled")}>
              Settled ({settledPositions.length})
            </TabButton>
          </div>

          {closing && (
            <ClosePanel
              position={closing}
              baseToken={market?.baseToken}
              quoteToken={market?.quoteToken}
              onClosed={() => setClosing(null)}
            />
          )}

          {settling && tab === "open" && (
            <p className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm text-primary">
              Final price settling — the bot is settling the final quote; the final price will show shortly.
            </p>
          )}

          {visible.length === 0 ? (
            <p className="text-sm text-text-dim">
              {tab === "open" ? "No open positions." : "No settled positions."}
            </p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {visible.map((p) => (
                <PositionCard
                  key={p.id}
                  position={p}
                  price={mark}
                  settling={settling}
                  canClose={canClose(p)}
                  onClose={(pos) => setClosing(pos)}
                />
              ))}
            </div>
          )}
        </>
      )}

      <p className="text-xs text-text-dim">
        Note: positions are derived live from on-chain events — nothing to claim (no central ledger).
        Reverse-closing = buy the opposite side with the current bot quote, a direct veto with no fee;
        closing a short requires topping up the difference to the open fee.
      </p>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
        active ? "bg-primary text-black" : "bg-card text-text-dim hover:text-text"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}