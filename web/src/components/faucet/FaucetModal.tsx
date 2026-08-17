"use client";

import { useCallback, useState } from "react";
import { useAccount } from "wagmi";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { ERC20_ABI } from "@/lib/abis/market";
import { BASE_TOKEN, QUOTE_TOKEN, isFullyConfigured } from "@/lib/config";
import { formatAmount } from "@/lib/format";

const FAUCET_AMOUNT = 2000n * 10n ** 18n;

/**
 * Demo faucet: mints LLM + HKD directly to the connected account via public MockERC20.mint.
 * (bots/quote flow out of scope per web-tech-design.md; faucet = mint call.)
 */
export function FaucetModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { address } = useAccount();
  const [target, setTarget] = useState(address ?? "");

  const mintBase = useWriteContract();
  const mintQuote = useWriteContract();

  const baseReceipt = useWaitForTransactionReceipt({ hash: mintBase.data });
  const quoteReceipt = useWaitForTransactionReceipt({ hash: mintQuote.data });

  const done =
    (mintBase.data !== undefined && baseReceipt.status === "success") ||
    (mintQuote.data !== undefined && quoteReceipt.status === "success");

  const busy = mintBase.isPending || mintQuote.isPending;

  const mint = useCallback(() => {
    if (!isFullyConfigured || !target) return;
    const to = target as `0x${string}`;
    mintBase.writeContract({ address: BASE_TOKEN as `0x${string}`, abi: ERC20_ABI, functionName: "mint", args: [to, FAUCET_AMOUNT] });
    mintQuote.writeContract({ address: QUOTE_TOKEN as `0x${string}`, abi: ERC20_ABI, functionName: "mint", args: [to, FAUCET_AMOUNT] });
  }, [target, mintBase, mintQuote]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-card-border bg-card p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Test token faucet</h2>
          <button className="text-text-dim hover:text-text" onClick={onClose}>
            ✕
          </button>
        </div>

        {!isFullyConfigured ? (
          <p className="mt-3 text-sm text-bear">Token contracts aren&apos;t configured; can&apos;t mint.</p>
        ) : (
          <>
            <p className="mt-2 text-sm text-text-dim">
              Claim <span className="text-primary">{formatAmount(FAUCET_AMOUNT, 18, 0)} LLM</span> and{" "}
              <span className="text-primary">{formatAmount(FAUCET_AMOUNT, 18, 0)} HKD</span> for free (test tokens to try out trading).
            </p>

            <label className="mt-4 block text-xs text-text-dim">Recipient address</label>
            <input
              className="mt-1 w-full rounded-lg border border-card-border bg-bg-dark px-3 py-2 text-sm font-mono focus:border-primary outline-none"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="0x…"
            />

            <button
              className="mt-4 w-full rounded-lg bg-primary py-2.5 text-sm font-bold text-black hover:bg-primary-dim disabled:opacity-50 transition-colors"
              disabled={busy || !target}
              onClick={mint}
            >
              {busy ? "Minting…" : done ? "Done ✓" : "Claim test tokens"}
            </button>

            {((mintBase.data && baseReceipt.status === "error") || (mintQuote.data && quoteReceipt.status === "error")) && (
              <p className="mt-2 text-xs text-bear">Minting failed — please retry.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}