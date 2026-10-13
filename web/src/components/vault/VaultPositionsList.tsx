"use client";

import { useMemo, useState } from "react";
import { useCurrentBlock } from "@/hooks/useCurrentBlock";
import { useVaultMeta, useVaultPrice } from "@/hooks/useVault";
import { useVaultPositions } from "@/hooks/useVaultPositions";
import { useVaultSettledPayouts } from "@/hooks/useVaultSettled";
import { useVaultTrade } from "@/hooks/useVaultTrade";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { VaultSide, VaultStatus, vaultPayoutAt } from "@/lib/vault";
import { formatAmount, formatCountdown, formatPnl, formatPrice } from "@/lib/format";
import { TxStatusCard, mapTransactionError, type TxState } from "@/components/common/TxStatusCard";

export function VaultPositionsList({ account }: { account?: `0x${string}` }) {
  const meta = useVaultMeta();
  const { positions, isLoading } = useVaultPositions(account);
  const blockNumber = useCurrentBlock();
  const price = useVaultPrice();
  const { payouts } = useVaultSettledPayouts(account);
  const trade = useVaultTrade();
  const metaMap = useTokenMeta([meta.priceBase ?? "0x", meta.settlementToken ?? "0x"]);
  const baseMeta = meta.priceBase
    ? (metaMap.get(meta.priceBase.toLowerCase()) ?? { symbol: "BASE", decimals: 18 })
    : { symbol: "BASE", decimals: 18 };
  const quoteMeta = meta.settlementToken
    ? (metaMap.get(meta.settlementToken.toLowerCase()) ?? { symbol: "HKD", decimals: 18 })
    : { symbol: "HKD", decimals: 18 };

  const [settleTarget, setSettleTarget] = useState<bigint | null>(null);
  const pending = trade.phase === "pending";

  const txState: TxState = useMemo(() => {
    if (trade.phase === "pending") {
      return { status: "loading", label: "Awaiting settle confirmation…" };
    }
    if (trade.phase === "success" && trade.hash) {
      return { status: "success", hash: trade.hash, title: "Position settled" };
    }
    if (trade.phase === "error" && trade.error) {
      return { status: "error", message: mapTransactionError(trade.error) };
    }
    return { status: "idle" };
  }, [trade.phase, trade.hash, trade.error]);

  if (!account) {
    return (
      <p className="rounded-lg border border-card-border bg-card p-4 text-sm text-text-dim">
        Connect a wallet to view your vault positions.
      </p>
    );
  }

  if (isLoading) {
    return <p className="text-sm text-text-dim">Loading positions…</p>;
  }

  if (positions.length === 0) {
    return (
      <div className="rounded-xl border border-card-border bg-card p-8 text-center">
        <p className="text-sm text-text-dim">No vault positions yet — open a LONG or SHORT from the Trade tab.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        {positions.map((position) => {
          const settled = position.status === VaultStatus.SETTLED;
          const canSettle =
            !settled && blockNumber !== undefined && blockNumber >= position.expiryBlock;
          const livePayout =
            !settled && price.exists && price.price !== undefined
              ? vaultPayoutAt(position, price.price)
              : undefined;
          const settleResult = payouts.get(position.id.toString());

          return (
            <div key={position.id.toString()} className="rounded-xl border border-card-border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                      position.side === VaultSide.LONG ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear"
                    }`}
                  >
                    {position.side === VaultSide.LONG ? "LONG" : "SHORT"}
                  </span>
                  <span className="rounded-md bg-card-border/40 px-2 py-0.5 text-[11px] text-text-dim">
                    #{position.id.toString()}
                  </span>
                  <span className="rounded-md bg-card-border/40 px-2 py-0.5 text-[11px] text-text-dim">
                    {settled ? "SETTLED" : "OPEN"}
                  </span>
                </div>
                {!settled && (
                  <button
                    className="rounded-lg border border-primary px-3 py-1.5 text-sm text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={!canSettle || pending}
                    onClick={() => {
                      setSettleTarget(position.id);
                      trade.settlePosition(position.id);
                    }}
                  >
                    {settleTarget === position.id && pending ? "Settling…" : "Settle"}
                  </button>
                )}
              </div>

              <div className="mt-3 space-y-1 text-sm">
                <Row label="Deposit" value={`${formatAmount(position.deposit, quoteMeta.decimals, 4)} ${quoteMeta.symbol}`} />
                <Row label="Notional" value={`${formatAmount(position.notional, quoteMeta.decimals, 4)} ${quoteMeta.symbol}`} />
                <Row
                  label="Entry price"
                  value={`${formatPrice(position.entryPrice)} ${quoteMeta.symbol}/${baseMeta.symbol}`}
                />
                <Row
                  label="Expiry"
                  value={blockNumber !== undefined ? formatCountdown(position.expiryBlock - blockNumber) : "…"}
                />
                {settled ? (
                  settleResult ? (
                    <>
                      <Row
                        label="Realized payout"
                        value={`${formatAmount(settleResult.payout, quoteMeta.decimals, 4)} ${quoteMeta.symbol}`}
                      />
                      <Row
                        label="Realized PnL"
                        value={formatPnl(settleResult.payout - position.deposit)}
                        accent={settleResult.payout - position.deposit >= 0n ? "bull" : "bear"}
                      />
                    </>
                  ) : (
                    <Row label="Settled" value="—" />
                  )
                ) : (
                  <Row
                    label="Estimated payout at current price"
                    value={
                      livePayout !== undefined
                        ? `${formatAmount(livePayout, quoteMeta.decimals, 4)} ${quoteMeta.symbol}`
                        : "—"
                    }
                  />
                )}
              </div>

              {!settled && (
                <p className="mt-3 text-xs text-text-dim">
                  Live payout is estimated at the current price. Settling sends the payout to the
                  position owner.
                </p>
              )}
              {settled && !settleResult && (
                <p className="mt-3 text-xs text-text-dim">Settled — payout details unavailable.</p>
              )}
            </div>
          );
        })}
      </div>

      <TxStatusCard state={txState} />
    </div>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: "bull" | "bear" }) {
  return (
    <div className="flex justify-between gap-6">
      <span className="text-text-dim">{label}</span>
      <span className={accent === "bull" ? "text-bull" : accent === "bear" ? "text-bear" : ""}>{value}</span>
    </div>
  );
}
