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
    [/VerificationWindowExpired|QuoteWindowExpired/, "报价已过窗口，请选择最新报价"],
    [/VerificationWindowActive/, "报价窗口尚未结束，无法否决"],
    [/QuoteDoesNotExist/, "报价不存在，请刷新后重试"],
    [/QuoteNotActive/, "报价已失效（已被否决或结算），请选择最新报价"],
    [/QuoteAmountTooSmall/, "报价金额过小"],
    [/ZeroBaseAmount/, "报价资产金额为 0"],
    [/ExpiryMustBeFuture/, "到期时间必须晚于当前区块"],
    [/NotQuoteProvider/, "仅报价者可执行该操作"],
    [/NotWithdrawable/, "抵押暂不可提取"],
    // IRMarket wrapper errors
    [/MarketDoesNotExist/, "市场不存在，请刷新后重试"],
    [/QuotePairMismatch/, "报价与本市场资产不匹配，请选择最新报价"],
    [/FeeTooHigh/, "手续费费率异常"],
    [/InvalidToken/, "代币地址无效"],
    [/IdenticalTokens/, "基础与报价代币不能相同"],
    // OpenZeppelin / revert-data errors
    [/ERC20InsufficientAllowance|InsufficientAllowance|transfer amount exceeds allowance/, "余额授权不足，请先授权"],
    [/ERC20InsufficientBalance|InsufficientBalance|insufficient funds|execution reverted due to insufficient balance/, "资产余额不足"],
    [/SafeERC20FailedOperation|transfer from failed|transfer failed/, "代币转账失败，请检查余额与授权"],
    [/ReentrancyGuardReentrantCall/, "交易冲突，请重试"],
    [/user rejected|User rejected|ACTION_REJECTED|MetaMask Message Signature|declined/, "已取消签名"],
    [/Nonce too low|nonce too low|nonce has already been used/, "Nonce 冲突，请重试"],
    [/The transaction has been reverted|reverted|estimateGas|execution reverted/, "交易被拒绝，请检查报价窗口与授权"],
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
        <span>{state.label ?? "等待确认…"}</span>
      </div>
    );
  }

  if (state.status === "success") {
    return (
      <div className="rounded-lg border border-bull/40 bg-bull/5 p-3 text-sm">
        <div className="font-semibold text-bull">{state.title ?? "交易成功"}</div>
        {state.detail ?? <div className="text-text-dim">资产已实时到账，可在持仓页查看。</div>}
        <a className="mt-1 inline-block text-primary underline" href={explorerTxUrl(state.hash)} target="_blank" rel="noreferrer">
          查看交易 {state.hash.slice(0, 10)}…
        </a>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-bear/40 bg-bear/5 p-3 text-sm">
      <div className="font-semibold text-bear">交易失败</div>
      <div className="text-text-dim">{state.message}</div>
    </div>
  );
}