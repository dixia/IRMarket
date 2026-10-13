"use client";

import { useMemo, useState } from "react";
import { formatUnits } from "viem";
import { useVaultMeta, useVaultStats } from "@/hooks/useVault";
import { useVaultAllowance, useVaultTrade } from "@/hooks/useVaultTrade";
import { useBalances } from "@/hooks/useBalances";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { formatAmount, parseAmount } from "@/lib/format";
import { vaultAmountForShares } from "@/lib/vault";
import { TxStatusCard, mapTransactionError, type TxState } from "@/components/common/TxStatusCard";

type LPAction = "approve" | "deposit" | "withdraw";

export function LPPanel({ account }: { account?: `0x${string}` }) {
  const meta = useVaultMeta();
  const stats = useVaultStats(account);
  const trade = useVaultTrade();
  const { allowance } = useVaultAllowance(account, meta.settlementToken);
  const balances = useBalances(
    account,
    meta.priceBase && meta.settlementToken ? { base: meta.priceBase, quote: meta.settlementToken } : null,
  );
  const metaMap = useTokenMeta([meta.priceBase ?? "0x", meta.settlementToken ?? "0x"]);
  const quoteMeta = meta.settlementToken
    ? (metaMap.get(meta.settlementToken.toLowerCase()) ?? { symbol: "HKD", decimals: 18 })
    : { symbol: "HKD", decimals: 18 };
  const decimals = quoteMeta.decimals;

  const [depositInput, setDepositInput] = useState("");
  const [withdrawInput, setWithdrawInput] = useState("");
  const [lastAction, setLastAction] = useState<LPAction | null>(null);
  const [handledHash, setHandledHash] = useState<`0x${string}` | undefined>(undefined);

  const depositAmount = parseAmount(depositInput, decimals);
  const withdrawShares = parseAmount(withdrawInput, decimals);

  const needApproval =
    depositAmount !== undefined &&
    depositAmount > 0n &&
    (allowance === undefined || allowance < depositAmount);

  const pending = trade.phase === "pending";

  if (trade.phase === "success" && trade.hash && trade.hash !== handledHash) {
    setHandledHash(trade.hash);
    if (lastAction === "deposit") setDepositInput("");
    else if (lastAction === "withdraw") setWithdrawInput("");
  }

  const received =
    withdrawShares !== undefined &&
    withdrawShares > 0n &&
    stats.totalShares !== undefined &&
    stats.totalShares > 0n &&
    stats.equity !== undefined
      ? vaultAmountForShares(withdrawShares, stats.totalShares, stats.equity)
      : undefined;

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
        title:
          lastAction === "withdraw"
            ? "Withdrawal confirmed"
            : lastAction === "deposit"
              ? "Deposit confirmed"
              : "Approval confirmed",
      };
    }
    if (trade.phase === "error" && trade.error) {
      return { status: "error", message: mapTransactionError(trade.error) };
    }
    return { status: "idle" };
  }, [trade.phase, trade.hash, trade.error, lastAction]);

  const canDeposit = !!account && depositAmount !== undefined && depositAmount > 0n && !pending && !!meta.settlementToken;
  const canWithdraw =
    !!account && withdrawShares !== undefined && withdrawShares > 0n && !pending && (stats.shares ?? 0n) > 0n;

  const depositLabel = !account
    ? "Connect wallet"
    : depositAmount === undefined || depositAmount <= 0n
      ? "Deposit"
      : needApproval
        ? "Approve"
        : "Deposit";

  const onDeposit = () => {
    if (!meta.settlementToken || depositAmount === undefined) return;
    if (needApproval) {
      setLastAction("approve");
      trade.approveQuote(meta.settlementToken);
    } else {
      setLastAction("deposit");
      trade.deposit(depositAmount);
    }
  };

  const onWithdraw = () => {
    if (withdrawShares === undefined) return;
    setLastAction("withdraw");
    trade.withdraw(withdrawShares);
  };

  const sharePrice = stats.sharePrice !== undefined ? formatAmount(stats.sharePrice, 18, 4) : "—";

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-card-border bg-card p-4">
        <h2 className="font-semibold">Pool</h2>
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3">
          <Stat label="Equity" value={`${formatAmount(stats.equity, decimals)} ${quoteMeta.symbol}`} accent />
          <Stat label="Share price" value={sharePrice} />
          <Stat label="Total shares" value={formatAmount(stats.totalShares, decimals)} />
          <Stat label="Pool balance" value={`${formatAmount(stats.balance, decimals)} ${quoteMeta.symbol}`} />
          <Stat label="Pending payouts" value={`${formatAmount(stats.pendingPayout, decimals)} ${quoteMeta.symbol}`} />
          <Stat label="Your shares" value={formatAmount(stats.shares, decimals)} />
        </div>
      </div>

      {stats.pendingPayout !== undefined && stats.pendingPayout > 0n && (
        <p className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm text-primary">
          Share price is temporarily depressed while open positions reserve payouts — depositing
          now buys at a discount.
        </p>
      )}

      {!account && (
        <p className="rounded-lg border border-card-border bg-card p-4 text-sm text-text-dim">
          Connect a wallet to deposit, withdraw, or open positions.
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-card-border bg-card p-4">
          <h3 className="font-semibold">Deposit</h3>
          <label className="mt-3 block text-xs text-text-dim">Amount ({quoteMeta.symbol})</label>
          <input
            className="mt-1 w-full rounded-lg border border-card-border bg-bg-dark px-3 py-2 text-sm font-mono focus:border-primary outline-none"
            value={depositInput}
            inputMode="decimal"
            placeholder="0.0"
            onChange={(e) => setDepositInput(e.target.value)}
          />
          <div className="mt-2 flex justify-between text-xs text-text-dim">
            <span>Wallet balance: {formatAmount(balances.quote, decimals, 4)} {quoteMeta.symbol}</span>
            {needApproval && depositAmount !== undefined && (
              <span className="text-primary">Approval required</span>
            )}
          </div>
          <button
            className="mt-3 w-full rounded-lg bg-primary py-3 text-sm font-bold text-black transition-colors hover:bg-primary-dim disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canDeposit}
            onClick={onDeposit}
          >
            {depositLabel}
          </button>
        </div>

        <div className="rounded-xl border border-card-border bg-card p-4">
          <h3 className="font-semibold">Withdraw</h3>
          <div className="mt-3 flex items-center justify-between">
            <label className="block text-xs text-text-dim">Shares</label>
            <button
              className="text-xs text-primary hover:underline"
              onClick={() => setWithdrawInput(formatUnits(stats.shares ?? 0n, decimals))}
            >
              Max
            </button>
          </div>
          <input
            className="mt-1 w-full rounded-lg border border-card-border bg-bg-dark px-3 py-2 text-sm font-mono focus:border-primary outline-none"
            value={withdrawInput}
            inputMode="decimal"
            placeholder="0.0"
            onChange={(e) => setWithdrawInput(e.target.value)}
          />
          <div className="mt-2 flex justify-between text-xs text-text-dim">
            <span>
              You receive: {received !== undefined ? `${formatAmount(received, decimals, 4)} ${quoteMeta.symbol}` : "—"}
            </span>
            <span>Your shares: {formatAmount(stats.shares, decimals, 4)}</span>
          </div>
          <button
            className="mt-3 w-full rounded-lg border border-card-border py-3 text-sm font-bold text-text transition-colors hover:bg-card-border/40 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canWithdraw}
            onClick={onWithdraw}
          >
            {!account ? "Connect wallet" : "Withdraw"}
          </button>
        </div>
      </div>

      <TxStatusCard state={txState} />
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-card-border bg-bg-dark p-3">
      <div className="text-xs text-text-dim">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold ${accent ? "text-primary" : ""}`}>{value}</div>
    </div>
  );
}
