"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { decodeEventLog, getAddress } from "viem";
import type { AbiEvent } from "viem";
import { MONORACLE_ABI } from "@/lib/abis/oracle";
import { IRMARKET_ABI } from "@/lib/abis/market";
import { useCurrentBlock } from "./useCurrentBlock";
import { MARKET_ADDRESS, ORACLE_ADDRESS, QUOTE_TOKEN, hasWrapper, isFullyConfigured } from "@/lib/config";
import type { Position, Side } from "@/lib/types";

const SIDE_LABEL: Record<number, Side> = { 0: "bull", 1: "bear" };

const VETO_WRAPPED_EVENT = IRMARKET_ABI.find(
  (e): e is Extract<(typeof IRMARKET_ABI)[number], { type: "event" }> => e.type === "event" && e.name === "VetoWrapped",
) as AbiEvent;

async function readQuote(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  quoteId: bigint,
): Promise<{ price: bigint; baseAmount: bigint; quoteAmount: bigint; expiryBlock: bigint; provider: `0x${string}` } | null> {
  const q = await publicClient
    .readContract({
      address: ORACLE_ADDRESS as `0x${string}`,
      abi: MONORACLE_ABI,
      functionName: "quotes",
      args: [quoteId],
    })
    .catch(() => null);
  if (!q) return null;
  const [provider, , , baseAmount, quoteAmount, price, , , expiryBlock] = q as readonly unknown[];
  if (provider === getAddress("0x0000000000000000000000000000000000000000")) return null;
  return {
    provider: provider as `0x${string}`,
    baseAmount: baseAmount as bigint,
    quoteAmount: quoteAmount as bigint,
    price: price as bigint,
    expiryBlock: expiryBlock as bigint,
  };
}

/**
 * Positions derived from on-chain events (R15 — no IRMarket ledger):
 *  - Wrapper opens: `VetoWrapped(trader = user)` — exact swap in/out + fee.
 *  - Direct vetoes (reverse closes / power users): `QuoteVetoed*` where verifier = user,
 *    amounts reconstructed from `quotes(quoteId)`.
 */
export function usePositions(address: `0x${string}` | undefined) {
  const publicClient = usePublicClient();
  const blockNumber = useCurrentBlock();

  const query = useQuery({
    queryKey: ["positions", address?.toLowerCase(), isFullyConfigured],
    queryFn: async (): Promise<Position[]> => {
      if (!publicClient || !address || !isFullyConfigured) return [];

      const oracle = ORACLE_ADDRESS as `0x${string}`;
      const fromBlock = 0n;

      const wrappedRaw = hasWrapper
        ? await publicClient
            .getLogs({
              address: MARKET_ADDRESS as `0x${string}`,
              event: VETO_WRAPPED_EVENT,
              args: { trader: getAddress(address) } as never,
              fromBlock,
              toBlock: "latest",
            })
            .catch(() => []) as Array<{ data: `0x${string}`; topics: `0x${string}`[]; blockNumber: bigint }>
        : [];

      const routedLogs = (await publicClient
        .getLogs({ address: oracle, fromBlock, toBlock: "latest" })
        .catch(() => [])) as Array<{ data: `0x${string}`; topics: `0x${string}`[]; blockNumber: bigint }>;

      const wrapped: Position[] = [];
      for (const log of wrappedRaw) {
        try {
          const decoded = decodeEventLog({
            abi: IRMARKET_ABI,
            data: log.data,
            topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
          });
          if (decoded.eventName !== "VetoWrapped") continue;
          const argsD = decoded.args as unknown as Record<string, unknown>;
          const quoteId = argsD.quoteId as bigint;
          const marketId = argsD.marketId as bigint;
          const side = (argsD.side as number) ?? 0;
          const swapIn = argsD.swapIn as bigint;
          const swapOut = argsD.swapOut as bigint;
          const fee = (argsD.fee as bigint) ?? 0n;
          const q = await readQuote(publicClient, quoteId as bigint);
          if (!q) continue;
          const s = SIDE_LABEL[Number(side)] ?? "bull";
          wrapped.push({
            id: `wrapped-${quoteId.toString()}`,
            side: s,
            marketId: marketId as bigint,
            quoteId: quoteId as bigint,
            openPrice: q.price,
            heldBase: s === "bull" ? swapOut : 0n,
            heldQuote: s === "bear" ? swapOut : 0n,
            paidBase: s === "bear" ? swapIn : 0n,
            paidQuote: s === "bull" ? swapIn + fee : 0n,
            fee,
            expiryBlock: q.expiryBlock,
            openedAtBlock: Number(log.blockNumber),
          });
        } catch {
          continue;
        }
      }

      const vetoed: Position[] = [];
      for (const log of routedLogs) {
        let decoded;
        try {
          decoded = decodeEventLog({
          abi: MONORACLE_ABI,
          data: log.data,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        });
        } catch {
          continue;
        }
        if (decoded.eventName !== "QuoteVetoedUnderpriced" && decoded.eventName !== "QuoteVetoedOverpriced") continue;
        const args = decoded.args as unknown as { quoteId: bigint; verifier: `0x${string}` };
        if (args.verifier.toLowerCase() !== address.toLowerCase()) continue;
        const q = await readQuote(publicClient, args.quoteId);
        if (!q) continue;
        const side = decoded.eventName === "QuoteVetoedUnderpriced" ? "bull" : "bear";
        vetoed.push({
          id: `vetoed-${args.quoteId.toString()}`,
          side,
          marketId: null,
          quoteId: args.quoteId,
          openPrice: q.price,
          heldBase: side === "bull" ? q.baseAmount : 0n,
          heldQuote: side === "bear" ? q.quoteAmount : 0n,
          paidBase: side === "bear" ? q.baseAmount : 0n,
          paidQuote: side === "bull" ? q.quoteAmount : 0n,
          fee: 0n,
          expiryBlock: q.expiryBlock,
          openedAtBlock: Number(log.blockNumber),
        });
      }

      return [...wrapped, ...vetoed];
    },
    enabled: isFullyConfigured && !!address && !!publicClient,
    refetchInterval: blockNumber !== undefined ? 4000 : undefined,
    staleTime: 2000,
  });

  return { positions: query.data ?? [], refetch: query.refetch, status: query.status };
}

/** True when the given token is the HKD quote token (used for short-asset valuation). */
export function isQuoteToken(token: `0x${string}`): boolean {
  if (!isFullyConfigured) return false;
  return token.toLowerCase() === QUOTE_TOKEN.toLowerCase();
}