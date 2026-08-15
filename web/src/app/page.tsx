"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { MarketCard } from "@/components/market/MarketCard";
import { FaucetModal } from "@/components/faucet/FaucetModal";
import { useMarkets } from "@/hooks/useMarkets";
import { useBalances } from "@/hooks/useBalances";
import { useReferencePrice } from "@/hooks/useReferencePrice";
import { formatAmount } from "@/lib/format";
import { isFullyConfigured } from "@/lib/config";

export default function HomePage() {
  const { address } = useAccount();
  const markets = useMarkets();
  const balances = useBalances(address);
  const [faucetOpen, setFaucetOpen] = useState(false);

  const market = markets.length > 0 ? markets[0] : undefined;
  const price = useReferencePrice(
    market && isFullyConfigured ? { base: market.baseToken, quote: market.quoteToken } : null,
  );

  return (
    <div className="space-y-8">
      {/* hero */}
      <section className="rounded-2xl border border-card-border bg-card p-6 md:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
              任何有价格的东西，都能变成期权
            </h1>
            <p className="mt-2 max-w-xl text-sm text-text-dim">
              A 股、Labubu、球星卡… 基于 Monoracle 否决-套利结算：每笔结算价都有双边抵押与链上套利者背书，无需喂价机、无需验证节点。
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3 text-sm">
          <button
            className="rounded-lg bg-primary px-4 py-2 font-semibold text-black hover:bg-primary-dim transition-colors"
            onClick={() => setFaucetOpen(true)}
          >
            领取测试币
          </button>
          {address && (
            <span className="text-text-dim">
              钱包余额 · HKD <span className="text-primary">{formatAmount(balances.hkd, 18, 2)}</span>
              {"  ·  "}
              LLM <span className="text-primary">{formatAmount(balances.llm, 18, 2)}</span>
            </span>
          )}
        </div>
      </section>

      {/* markets */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">市场</h2>
          <span className="text-xs text-text-dim">多空对称 · 3 分钟到期 · 事务性报价</span>
        </div>

        {markets.length === 0 ? (
          <p className="text-sm text-text-dim">暂无市场。</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {markets.map((m) => (
              <MarketCard
                key={m.marketId.toString()}
                market={m}
                price={price.status === "ok" ? price.price : undefined}
              />
            ))}
          </div>
        )}
      </section>

      {price.status === "settling" && (
        <p className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm text-primary">
          终价结算中（等待 settle）—— bot 正在结算最终报价。
        </p>
      )}

      {(!isFullyConfigured && (
        <p className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm text-primary">
          合约地址尚未配置（缺 NEXT_PUBLIC_ORACLE_ADDRESS / BASE_TOKEN / QUOTE_TOKEN）。配置后即可显示实时报价与交易入口。
        </p>
      )) ||
        null}

      <FaucetModal open={faucetOpen} onClose={() => setFaucetOpen(false)} />
    </div>
  );
}