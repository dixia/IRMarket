"use client";

import { useMemo, useState } from "react";
import { parseUnits } from "viem";
import { useAccount, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { FACTORY_ABI } from "@/lib/abis/factory";
import { ERC20_ABI } from "@/lib/abis/market";
import { VAULT_ABI } from "@/lib/abis/vault";
import { FACTORY_ADDRESS, hasFactory } from "@/lib/config";
import { useMarkets } from "@/hooks/useMarkets";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useVaultDirectory, type DirectoryVault } from "@/hooks/useVaultDirectory";
import { formatPrice } from "@/lib/format";

const DEFAULT_FEE_BPS = 100n; // 1%, the deployed default

/**
 * Vault directory: one row per factory vault, plus a "create vault" action for a
 * pair that has none yet.
 *
 * The product is one vault per pair (LP deposits carry that pair's risk only), so
 * the factory — not an env address — is the source of truth. Anyone can create a
 * missing vault and anyone can deposit into any vault; the row-level deposit is
 * deliberately independent of the featured-vault panels below it.
 */
export function VaultDirectory() {
  const { vaults, isLoading } = useVaultDirectory();
  const { address: account } = useAccount();

  const tokens = useMemo(
    () => [...new Set(vaults.flatMap((v) => [v.baseToken, v.quoteToken]))],
    [vaults],
  );
  const metaMap = useTokenMeta(tokens);

  return (
    <section className="space-y-3 rounded-xl border border-primary/20 bg-surface/60 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">LP vaults</h2>
        <span className="text-xs text-text-dim">one vault per pair · anyone can create or deposit</span>
      </div>

      {!hasFactory && (
        <p className="text-sm text-text-dim">
          Vault factory not configured (<code>NEXT_PUBLIC_FACTORY_ADDRESS</code>).
        </p>
      )}

      {hasFactory && isLoading && <p className="text-sm text-text-dim">Loading vaults…</p>}

      {hasFactory && !isLoading && vaults.length === 0 && (
        <p className="text-sm text-text-dim">No vaults yet — create the first one below.</p>
      )}

      <div className="space-y-2">
        {vaults.map((v) => {
          const base = metaMap.get(v.baseToken.toLowerCase());
          const quote = metaMap.get(v.quoteToken.toLowerCase());
          return (
            <VaultRow
              key={v.address}
              vault={v}
              pairLabel={`${base?.symbol ?? "?"}/${quote?.symbol ?? "?"}`}
              quoteSymbol={quote?.symbol ?? "?"}
              quoteDecimals={quote?.decimals ?? 18}
              account={account}
            />
          );
        })}
      </div>

      {hasFactory && <CreateVaultSection existing={vaults} />}
    </section>
  );
}

function VaultRow({
  vault,
  pairLabel,
  quoteSymbol,
  quoteDecimals,
  account,
}: {
  vault: DirectoryVault;
  pairLabel: string;
  quoteSymbol: string;
  quoteDecimals: number;
  account?: `0x${string}`;
}) {
  const [amount, setAmount] = useState("");
  const { writeContractAsync, isPending } = useWriteContract();
  const value = (() => {
    try {
      return amount ? parseUnits(amount, quoteDecimals) : 0n;
    } catch {
      return 0n;
    }
  })();

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: vault.quoteToken,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: account ? [account, vault.address] : undefined,
    query: { enabled: !!account },
  });
  const needsApproval = value > 0n && ((allowance as bigint | undefined) ?? 0n) < value;

  async function approve() {
    await writeContractAsync({
      address: vault.quoteToken,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [vault.address, value],
    });
    await refetchAllowance();
  }

  async function deposit() {
    await writeContractAsync({
      address: vault.address,
      abi: VAULT_ABI,
      functionName: "deposit",
      args: [value],
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm">
      <span className="w-32 font-medium">{pairLabel}</span>
      <span className="text-text-dim">
        equity {formatPrice(vault.equity, 2)} {quoteSymbol}
      </span>
      <span className="text-text-dim">fee {(Number(vault.feeBps) / 100).toFixed(2)}%</span>
      <span className="ml-auto flex items-center gap-2">
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          placeholder={`amount (${quoteSymbol})`}
          className="w-32 rounded border border-white/15 bg-transparent px-2 py-1 text-right"
        />
        {needsApproval ? (
          <button
            onClick={approve}
            disabled={!account || isPending}
            className="rounded bg-primary/20 px-3 py-1 text-primary disabled:opacity-40"
          >
            Approve
          </button>
        ) : (
          <button
            onClick={deposit}
            disabled={!account || isPending || value === 0n}
            className="rounded bg-primary/20 px-3 py-1 text-primary disabled:opacity-40"
          >
            Deposit
          </button>
        )}
      </span>
    </div>
  );
}

function CreateVaultSection({ existing }: { existing: DirectoryVault[] }) {
  const markets = useMarkets();
  const { writeContractAsync, isPending } = useWriteContract();

  // One vaultFor per market pair (curated list is small; one multicall).
  const { data: lookups } = useReadContracts({
    contracts: markets.map((m) => ({
      address: FACTORY_ADDRESS,
      abi: FACTORY_ABI,
      functionName: "vaultFor" as const,
      args: [m.baseToken as `0x${string}`, m.quoteToken as `0x${string}`] as const,
    })),
    query: { enabled: markets.length > 0 && hasFactory },
  });

  const missing = markets.filter((_, i) => {
    const found = lookups?.[i]?.result as `0x${string}` | undefined;
    return !found || found === "0x";
  });
  const tokens = [...new Set(missing.flatMap((m) => [m.baseToken, m.quoteToken]))] as `0x${string}`[];
  const metaMap = useTokenMeta(tokens);

  if (missing.length === 0) return null;

  return (
    <div className="space-y-2 border-t border-white/10 pt-3">
      <p className="text-xs text-text-dim">Pairs without a vault — create one (you become the creator; the vault has no admin):</p>
      {missing.map((m) => {
        const base = metaMap.get(m.baseToken.toLowerCase())?.symbol ?? "?";
        const quote = metaMap.get(m.quoteToken.toLowerCase())?.symbol ?? "?";
        return (
          <button
            key={`${m.baseToken}-${m.quoteToken}`}
            onClick={() =>
              writeContractAsync({
                address: FACTORY_ADDRESS,
                abi: FACTORY_ABI,
                functionName: "createVault",
                args: [m.baseToken as `0x${string}`, m.quoteToken as `0x${string}`, DEFAULT_FEE_BPS],
              })
            }
            disabled={isPending}
            className="mr-2 rounded border border-primary/30 px-3 py-1 text-xs text-primary disabled:opacity-40"
          >
            + vault for {base}/{quote}
          </button>
        );
      })}
      {existing.length === 0 && <span className="text-xs text-text-dim">(none yet)</span>}
    </div>
  );
}
