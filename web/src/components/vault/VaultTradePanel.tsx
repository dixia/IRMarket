"use client";

import { useMemo, useState } from "react";
import { useVaultMeta, useVaultPrice } from "@/hooks/useVault";
import { useVaultAllowance, useVaultTrade } from "@/hooks/useVaultTrade";
import { useBalances } from "@/hooks/useBalances";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import {
  computeVaultFee,
  vaultMaxPayout,
  vaultNotional,
  vaultUnits,
  VaultSide,
  type VaultSideValue,
} from "@/lib/vault";
import { formatAmount, formatPrice, parseAmount } from "@/lib/format";
import { CHAIN_ID } from "@/lib/config";
import { blocksForSeconds } from "@/lib/chainParams";
import { TxStatusCard, mapTransactionError, type TxState } from "@/components/common/TxStatusCard";

const TENOR_PRESETS: Array<{ label: string; value: string }> = [60, 180, 600].map((seconds) => {
  const blocks = blocksForSeconds(CHAIN_ID, seconds);
  const mins = seconds / 60;
  return {
    label: `${mins >= 1 ? `${mins} min` : `${seconds}s`} ≈ ${blocks}`,
    value: String(blocks),
  };
});

type TradeAction = "approve" | "open";

export function VaultTradePanel({ account }: { account?: `0x${string}` }) {
  const meta = useVaultMeta();
  const price = useVaultPrice();
  const trade = useVaultTrade();
  const { allowance } = useVaultAllowance(account, meta.settlementToken);
  const balances = useBalances(
    account,
    meta.priceBase && meta.settlementToken ? { base: meta.priceBase, quote: meta.settlementToken } : null,
  );
  const metaMap = useTokenMeta([meta.priceBase ?? "0x", meta.settlementToken ?? "0x"]);
  const baseMeta = meta.priceBase
    ? (metaMap.get(meta.priceBase.toLowerCase()) ?? { symbol: "BASE", decimals: 18 })
    : { symbol: "BASE", decimals: 18 };
  const quoteMeta = meta.settlementToken
    ? (metaMap.get(meta.settlementToken.toLowerCase()) ?? { symbol: "HKD", decimals: 18 })
    : { symbol: "HKD", decimals: 18 };
  const decimals = quoteMeta.decimals;

  const [side, setSide] = useState<VaultSideValue>(VaultSide.LONG);
  const [amountInput, setAmountInput] = useState("");
  const [tenorInput, setTenorInput] = useState("");
  const [lastAction, setLastAction] = useState<TradeAction | null>(null);
  const [handledHash, setHandledHash] = useState<`0x${string}` | undefined>(undefined);

  const D = parseAmount(amountInput, decimals);
  const tenor = parseAmount(tenorInput, 0);

  const preview = (() => {
    if (D === undefined || D <= 0n || meta.feeBps === undefined) return null;
    const fee = computeVaultFee(D, meta.feeBps);
    const notional = vaultNotional(D, meta.feeBps);
    const maxPayout = vaultMaxPayout(notional);
    const units = price.exists && price.price !== undefined ? vaultUnits(notional, price.price) : undefined;
    return { fee, notional, maxPayout, units };
  })();

  const needApproval = D !== undefined && D > 0n && (allowance === undefined || allowance < D);
  const pending = trade.phase === "pending";

  if (trade.phase === "success" && trade.hash && trade.hash !== handledHash) {
    setHandledHash(trade.hash);
    if (lastAction === "open") setAmountInput("");
  }

  const txState: TxState = useMemo(() => {
    if (trade.phase === "pending") {
      return {
        status: "loading",
        label: lastAction === "approve" ? "Awaiting approval signature…" : "Awaiting transaction confirmation…",
      };
    }
    if (trade.phase === "success" && trade.hash) {
      return {
        status: "success",
        hash: trade.hash,
        title: lastAction === "open" ? "Position opened" : "Approval confirmed",
      };
    }
    if (trade.phase === "error" && trade.error) {
      return { status: "error", message: mapTransactionError(trade.error) };
    }
    return { status: "idle" };
  }, [trade.phase, trade.hash, trade.error, lastAction]);

  const validTenor = tenor !== undefined && tenor > 0n;
  const validAmount = D !== undefined && D > 0n;
  const disabled = !account || !price.exists || !validAmount || !validTenor || pending || !meta.settlementToken;

  const buttonLabel = !account
    ? "Connect wallet"
    : !price.exists
      ? "Waiting for a price"
      : !validAmount
        ? "Enter an amount"
        : !validTenor
          ? "Enter a tenor"
          : needApproval
            ? "Approve"
            : side === VaultSide.LONG
              ? "Open LONG"
              : "Open SHORT";

  const onSubmit = () => {
    if (!meta.settlementToken || D === undefined || tenor === undefined) return;
    if (needApproval) {
      setLastAction("approve");
      trade.approveQuote(meta.settlementToken);
    } else {
      setLastAction("open");
      trade.openPosition(side, D, tenor);
    }
  };

  return (
    <div className="rounded-xl border border-card-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Trade</h2>
        <span className="text-xs text-text-dim">Capped linear payoff · max loss = premium · no liquidations</span>
      </div>

      {!account && (
        <p className="mt-3 rounded-lg border border-card-border bg-bg-dark p-3 text-sm text-text-dim">
          Connect a wallet to open a position.
        </p>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
            side === VaultSide.LONG ? "bg-l-cyan text-bull" : "bg-card-border/40 text-text-dim hover:bg-card-border/60"
          }`}
          onClick={() => setSide(VaultSide.LONG)}
        >
          LONG
        </button>
        <button
          className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
            side === VaultSide.SHORT ? "bg-l-orange text-bear" : "bg-card-border/40 text-text-dim hover:bg-card-border/60"
          }`}
          onClick={() => setSide(VaultSide.SHORT)}
        >
          SHORT
        </button>
      </div>

      <label className="kicker mt-3 block text-text-dim">Amount ({quoteMeta.symbol})</label>
      <input
        className="mt-1 w-full rounded-lg border border-card-border bg-bg-dark px-3 py-2 text-sm font-mono focus:border-primary outline-none"
        value={amountInput}
        inputMode="decimal"
        placeholder="0.0"
        onChange={(e) => setAmountInput(e.target.value)}
      />

      <label className="kicker mt-3 block text-text-dim">Tenor (blocks)</label>
      <div className="mt-1 flex gap-2">
        <input
          className="w-full rounded-lg border border-card-border bg-bg-dark px-3 py-2 text-sm font-mono focus:border-primary outline-none"
          value={tenorInput}
          inputMode="numeric"
          placeholder="600"
          onChange={(e) => setTenorInput(e.target.value)}
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {TENOR_PRESETS.map((preset) => (
          <button
            key={preset.value}
            className="rounded-lg bg-card-border/40 px-2.5 py-1 text-xs text-text-dim transition-colors hover:bg-card-border/60"
            onClick={() => setTenorInput(preset.value)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="mt-3 rounded-lg bg-card-border/20 p-3 text-sm space-y-1">
        <Row label="Entry price" value={price.exists ? `${formatPrice(price.price)} ${quoteMeta.symbol}/${baseMeta.symbol}` : "—"} />
        <Row label="Fee" value={`${formatAmount(preview?.fee, decimals, 4)} ${quoteMeta.symbol}`} />
        <Row label="Notional" value={`${formatAmount(preview?.notional, decimals, 4)} ${quoteMeta.symbol}`} />
        <Row label="Max payout" value={`${formatAmount(preview?.maxPayout, decimals, 4)} ${quoteMeta.symbol}`} />
        <Row label="Units" value={preview?.units !== undefined ? `${formatAmount(preview.units, baseMeta.decimals, 4)} ${baseMeta.symbol}` : "—"} />
        <Row label="Max loss" value={`${formatAmount(D, decimals, 4)} ${quoteMeta.symbol}`} accent="bear" />
        <Row label="Max profit" value={`${formatAmount(preview?.notional, decimals, 4)} ${quoteMeta.symbol}`} accent="bull" />
      </div>

      <div className="mt-2 flex justify-between text-xs text-text-dim">
        <span>Wallet balance: {formatAmount(balances.quote, decimals, 4)} {quoteMeta.symbol}</span>
        {needApproval && D !== undefined && <span className="text-primary">Approval required</span>}
      </div>

      <button
        className="mt-3 w-full rounded-lg bg-primary py-3 text-sm font-bold text-white transition-colors hover:bg-primary-dim disabled:cursor-not-allowed disabled:opacity-50"
        disabled={disabled}
        onClick={onSubmit}
      >
        {buttonLabel}
      </button>

      <div className="mt-3">
        <TxStatusCard state={txState} />
      </div>
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
