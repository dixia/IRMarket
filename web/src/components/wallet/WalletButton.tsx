"use client";

import { useAccount, useBalance, useConnect, useDisconnect } from "wagmi";
import { formatAmount, shortenAddress } from "@/lib/format";
import { useBalances } from "@/hooks/useBalances";
import { useHydrated } from "@/hooks/useHydrated";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useMemo } from "react";
import { CHAIN_ID, MON_RESERVE_FLOOR, BASE_TOKEN_RAW, QUOTE_TOKEN_RAW } from "@/lib/config";

export function WalletButton() {
  // Hydration-safe: renders the disconnected button until after hydration, so SSR HTML
  // matches the client's first render even when wagmi rehydrates the connected account.
  const mounted = useHydrated();
  const { address, chainId } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const balances = useBalances(mounted ? address : undefined);
  const { data: mon } = useBalance({ address: mounted ? address : undefined });
  const lowMon = mon !== undefined && mon.value < MON_RESERVE_FLOOR;

  const tokenAddresses = useMemo(
    () => [BASE_TOKEN_RAW, QUOTE_TOKEN_RAW].filter((a): a is `0x${string}` => !!a && a !== "0x"),
    [],
  );
  const metaMap = useTokenMeta(tokenAddresses);
  const baseDecimals = BASE_TOKEN_RAW ? (metaMap.get(BASE_TOKEN_RAW.toLowerCase())?.decimals ?? 18) : 18;
  const quoteDecimals = QUOTE_TOKEN_RAW ? (metaMap.get(QUOTE_TOKEN_RAW.toLowerCase())?.decimals ?? 18) : 18;
  const baseSymbol = BASE_TOKEN_RAW ? (metaMap.get(BASE_TOKEN_RAW.toLowerCase())?.symbol ?? "LLM") : "LLM";
  const quoteSymbol = QUOTE_TOKEN_RAW ? (metaMap.get(QUOTE_TOKEN_RAW.toLowerCase())?.symbol ?? "HKD") : "HKD";

  if (!mounted || !address) {
    return (
      <button
        className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-black hover:bg-primary-dim transition-colors"
        onClick={() => {
          const injected = connectors.find((c) => c.id === "injected");
          connect({ connector: injected ?? connectors[0] });
        }}
      >
        Connect wallet
      </button>
    );
  }
  const chainTag = chainId === CHAIN_ID ? "Monad Testnet" : `Chain ${chainId}`;

  return (
    <div className="flex items-center gap-2">
      <div className="hidden sm:flex flex-col items-end text-xs leading-tight">
        <span className="text-text-dim">{quoteSymbol} {formatAmount(balances.quote, quoteDecimals, 2)}</span>
        <span className="text-text-dim">{baseSymbol} {formatAmount(balances.base, baseDecimals, 2)}</span>
        <span className={lowMon ? "text-bear" : "text-text-dim"}>
          MON {formatAmount(mon?.value, 18, 2)}
        </span>
      </div>
      <span className="rounded-full bg-card border border-card-border px-2 py-1 text-[11px] text-text-dim">
        {chainTag}
      </span>
      <button
        className="rounded-lg border border-card-border px-3 py-2 text-sm hover:bg-card transition-colors"
        onClick={() => disconnect()}
        title={address}
      >
        {shortenAddress(address)}
      </button>
    </div>
  );
}
