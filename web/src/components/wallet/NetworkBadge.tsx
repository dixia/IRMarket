"use client";

import { useAccount, useSwitchChain } from "wagmi";
import { useEffect } from "react";
import { CHAIN_ID } from "@/lib/config";

/** Detects wrong network and offers a one-click switch to Monad Testnet (10143). */
export function NetworkBadge() {
  const { isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();

  useEffect(() => {
    // no-op; switch is user-triggered below to avoid silent network changes
  }, []);

  if (!isConnected || chainId === CHAIN_ID) return null;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-bear/40 bg-bear/10 px-3 py-2 text-sm">
      <span className="text-bear">请切换至 Monad 测试网 (Chain ID {CHAIN_ID})</span>
      <button className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-black" onClick={() => switchChain({ chainId: CHAIN_ID })}>
        一键切换
      </button>
    </div>
  );
}