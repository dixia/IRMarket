"use client";

import { useAccount, useBalance, useConnect, useDisconnect } from "wagmi";
import { formatAmount, shortenAddress } from "@/lib/format";
import { useBalances } from "@/hooks/useBalances";
import { CHAIN_ID } from "@/lib/config";

const MON_RESERVE_FLOOR = 10n * 10n ** 18n;

export function WalletButton() {
  const { address, chainId } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const balances = useBalances(address);
  const { data: mon } = useBalance({ address });
  const lowMon = mon !== undefined && mon.value < MON_RESERVE_FLOOR;

  if (!address) {
    return (
      <button
        className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-black hover:bg-primary-dim transition-colors"
        onClick={() => {
          const injected = connectors.find((c) => c.id === "injected");
          connect({ connector: injected ?? connectors[0] });
        }}
      >
        连接钱包
      </button>
    );
  }

  const chainTag = chainId === CHAIN_ID ? "Monad Testnet" : `Chain ${chainId}`;

  return (
    <div className="flex items-center gap-2">
      <div className="hidden sm:flex flex-col items-end text-xs leading-tight">
        <span className="text-text-dim">HKD {formatAmount(balances.hkd, 18, 2)}</span>
        <span className="text-text-dim">LLM {formatAmount(balances.llm, 18, 2)}</span>
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