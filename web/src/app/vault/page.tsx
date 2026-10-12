"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { PriceHeader } from "@/components/vault/PriceHeader";
import { LPPanel } from "@/components/vault/LPPanel";
import { VaultTradePanel } from "@/components/vault/VaultTradePanel";
import { VaultPositionsList } from "@/components/vault/VaultPositionsList";
import { useHydrated } from "@/hooks/useHydrated";
import { hasVault } from "@/lib/config";

type VaultTab = "lp" | "trade" | "positions";

export default function VaultPage() {
  const mounted = useHydrated();
  const { address } = useAccount();
  const account = mounted ? address : undefined;
  const [tab, setTab] = useState<VaultTab>("lp");

  if (!hasVault) {
    return (
      <p className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm text-primary">
        Vault not configured.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-bold">LP Vault</h1>
        <p className="mt-1 text-sm text-text-dim">
          The pool is the counterparty · positions settle at Monoracle&apos;s canonical price · no
          liquidations
        </p>
      </section>

      <PriceHeader />

      <div className="flex gap-2">
        <TabButton active={tab === "lp"} onClick={() => setTab("lp")}>
          LP
        </TabButton>
        <TabButton active={tab === "trade"} onClick={() => setTab("trade")}>
          Trade
        </TabButton>
        <TabButton active={tab === "positions"} onClick={() => setTab("positions")}>
          Positions
        </TabButton>
      </div>

      {tab === "lp" && <LPPanel account={account} />}
      {tab === "trade" && <VaultTradePanel account={account} />}
      {tab === "positions" && <VaultPositionsList account={account} />}
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
