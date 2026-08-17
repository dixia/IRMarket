"use client";

import type { ReactNode } from "react";
import { explorerTxUrl } from "@/lib/config";

export type TxState =
  | { status: "idle" }
  | { status: "loading"; label?: string }
  | { status: "success"; hash: `0x${string}`; title?: string; detail?: ReactNode }
  | { status: "error"; message: string };

/** Friendly mapping for IRMarket + MonoracleWindowed errors (sc-tech-spec §3.7 / web-tech-design §9). */
export function mapTransactionError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const map: Array<[RegExp, string]> = [
    // MonoracleWindowed fork errors
    [/VerificationWindowExpired|QuoteWindowExpired/, "Quote window passed — please select the latest quote"],
    [/VerificationWindowActive/, "Quote window is still open; cannot veto yet"],
    [/QuoteDoesNotExist/, "Quote not found — please refresh and retry"],
    [/QuoteNotActive/, "Quote is no longer active (vetoed or settled) — please select the latest quote"],
    [/QuoteAmountTooSmall/, "Quote amount too small"],
    [/ZeroBaseAmount/, "Quote asset amount is 0"],
    [/ExpiryMustBeFuture/, "Expiry must be later than the current block"],
    [/NotQuoteProvider/, "Only the quote provider can perform this action"],
    [/NotWithdrawable/, "Collateral can't be withdrawn yet"],
    // IRMarket wrapper errors
    [/MarketDoesNotExist/, "Market not found — please refresh and retry"],
    [/QuotePairMismatch/, "Quote doesn't match this market's assets — please select the latest quote"],
    [/FeeTooHigh/, "Fee rate is invalid"],
    [/InvalidToken/, "Invalid token address"],
    [/IdenticalTokens/, "Base and quote tokens can't be the same"],
    // OpenZeppelin / revert-data errors
    [/ERC20InsufficientAllowance|InsufficientAllowance|transfer amount exceeds allowance/, "Insufficient allowance — please approve first"],
    [/ERC20InsufficientBalance|InsufficientBalance|insufficient funds|execution reverted due to insufficient balance/, "Insufficient asset balance"],
    [/SafeERC20FailedOperation|transfer from failed|transfer failed/, "Token transfer failed — check your balance and allowance"],
    [/ReentrancyGuardReentrantCall/, "Transaction conflict — please retry"],
    [/user rejected|User rejected|ACTION_REJECTED|MetaMask Message Signature|declined/, "Signature rejected"],
    [/Nonce too low|nonce too low|nonce has already been used/, "Nonce conflict — please retry"],
    [/The transaction has been reverted|reverted|estimateGas|execution reverted/, "Transaction reverted — please check the quote window and allowance"],
  ];
  for (const [re, friendly] of map) {
    if (re.test(msg)) return friendly;
  }
  return msg.length > 160 ? `${msg.slice(0, 160)}…` : msg;
}

export function TxStatusCard({ state }: { state: TxState }) {
  if (state.status === "idle") return null;

  if (state.status === "loading") {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <span>{state.label ?? "Awaiting confirmation…"}</span>
      </div>
    );
  }

  if (state.status === "success") {
    return (
      <div className="rounded-lg border border-bull/40 bg-bull/5 p-3 text-sm">
        <div className="font-semibold text-bull">{state.title ?? "Transaction succeeded"}</div>
        {state.detail ?? <div className="text-text-dim">Assets were settled to your wallet instantly — view them on the positions page.</div>}
        <a className="mt-1 inline-block text-primary underline" href={explorerTxUrl(state.hash)} target="_blank" rel="noreferrer">
          View transaction {state.hash.slice(0, 10)}…
        </a>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-bear/40 bg-bear/5 p-3 text-sm">
      <div className="font-semibold text-bear">Transaction failed</div>
      <div className="text-text-dim">{state.message}</div>
    </div>
  );
}