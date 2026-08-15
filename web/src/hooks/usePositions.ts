"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { decodeEventLog, getAddress, type Address } from "viem";
import type { AbiEvent } from "viem";
import { MONORACLE_ABI } from "@/lib/abis/oracle";
import { IRMARKET_ABI } from "@/lib/abis/market";
import { useCurrentBlock } from "./useCurrentBlock";
import { MARKET_ADDRESS, ORACLE_ADDRESS, QUOTE_TOKEN, hasWrapper, isFullyConfigured } from "@/lib/config";
import type { Position, Side } from "@/lib/types";

const SIDE_LABEL: Record<number, Side> = { 0: "bull", 1: "bear" };

// Monad testnet RPCs cap eth_getLogs at a ~100-block range, so event history must be
// fetched in chunked windows (verified: "eth_getLogs is limited to a 100 range").
const LOG_CHUNK_BLOCKS = 100n;
// Look back ~5000 blocks (~25 min @300ms) for the user's position events. The bot rolls
// ~600-block rounds, so this covers several rounds without an expensive full scan.
const LOOKBACK_BLOCKS = 5000n;

const VETO_WRAPPED_EVENT = IRMARKET_ABI.find(
  (e): e is Extract<(typeof IRMARKET_ABI)[number], { type: "event" }> => e.type === "event" && e.name === "VetoWrapped",
) as AbiEvent;

interface RawLog {
  data: `0x${string}`;
  topics: `0x${string}`[];
  blockNumber: bigint;
}

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

/** eth_getLogs helper that paginates in ≤100-block chunks to satisfy RPC range limits. */
async function getLogsChunked(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  params: { address: Address; event?: AbiEvent; args?: Record<string, unknown>; fromBlock: bigint; toBlock: bigint },
): Promise<RawLog[]> {
  const ranges: Array<{ from: bigint; to: bigint }> = [];
  let from = params.fromBlock;
  while (from <= params.toBlock) {
    const to = from + LOG_CHUNK_BLOCKS - 1n > params.toBlock ? params.toBlock : from + LOG_CHUNK_BLOCKS - 1n;
    ranges.push({ from, to });
    from = to + 1n;
  }

  // Fetch chunks in small concurrency batches so a throttling RPC doesn't reject them all.
  const results = await Promise.all(
    ranges.map(({ from: f, to: t }) =>
      publicClient
        .getLogs({
          address: params.address,
          event: params.event,
          args: params.args,
          fromBlock: f,
          toBlock: t,
        })
        .then((logs) => logs.map((l) => ({ data: l.data, topics: l.topics as `0x${string}`[], blockNumber: BigInt(l.blockNumber) })))
        .catch(() => [] as RawLog[]),
    ),
  );
  return results.flat();
}

/**
 * Positions derived from on-chain events (R15 — no IRMarket ledger):
 *  - Wrapper opens: `VetoWrapped(trader = user)` — exact swap in/out + fee.
 *  - Direct vetoes (reverse closes / power users): `QuoteVetoed*` where verifier = user,
 *    amounts reconstructed from `quotes(quoteId)`.
 *
 * Monad testnet RPCs limit eth_getLogs to a ~100-block range, so the fetch is chunked.
 */
export function usePositions(address: `0x${string}` | undefined) {
  const publicClient = usePublicClient();
  const blockNumber = useCurrentBlock();

  const query = useQuery({
    queryKey: ["positions", address?.toLowerCase(), isFullyConfigured],
    queryFn: async (): Promise<Position[]> => {
      if (!publicClient || !address || !isFullyConfigured) return [];

      const latest = blockNumber ?? (await publicClient.getBlockNumber());
      const fromBlock = latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n;

      const oracle = ORACLE_ADDRESS as `0x${string}`;

      const wrappedRaw = hasWrapper
        ? await getLogsChunked(publicClient, {
            address: MARKET_ADDRESS as Address,
            event: VETO_WRAPPED_EVENT,
            args: { trader: getAddress(address) },
            fromBlock,
            toBlock: latest,
          })
        : [];

      const routedLogs = await getLogsChunked(publicClient, {
        address: oracle as Address,
        fromBlock,
        toBlock: latest,
      });

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
    refetchInterval: blockNumber !== undefined ? 15000 : undefined,
    staleTime: 5000,
  });

  return { positions: query.data ?? [], refetch: query.refetch, status: query.status };
}

/** True when the given token is the HKD quote token (used for short-asset valuation). */
export function isQuoteToken(token: `0x${string}`): boolean {
  if (!isFullyConfigured) return false;
  return token.toLowerCase() === QUOTE_TOKEN.toLowerCase();
}