"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { decodeEventLog, getAddress, type Address } from "viem";
import type { AbiEvent } from "viem";
import { MONORACLE_ABI } from "@/lib/abis/oracle";
import { decodeQuote } from "@/lib/decode";
import { IRMARKET_ABI } from "@/lib/abis/market";
import { getLogsChunked } from "@/lib/logs";
import { fetchPositionEvents, type IndexedPositionEvent } from "@/lib/indexer";
import { useCurrentBlock } from "./useCurrentBlock";
import { INDEXER_URL, MARKET_ADDRESS, ORACLE_ADDRESS, QUOTE_TOKEN, hasWrapper, isFullyConfigured } from "@/lib/config";
import type { Position, Side } from "@/lib/types";

const SIDE_LABEL: Record<number, Side> = { 0: "bull", 1: "bear" };

// Look back ~5000 blocks (~25 min @300ms) for the user's position events. The bot rolls
// ~600-block rounds, so this covers several rounds without an expensive full scan.
const LOOKBACK_BLOCKS = 5000n;

const VETO_WRAPPED_EVENT = IRMARKET_ABI.find(
  (e): e is Extract<(typeof IRMARKET_ABI)[number], { type: "event" }> => e.type === "event" && e.name === "VetoWrapped",
) as AbiEvent;

async function readQuote(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  quoteId: bigint,
): Promise<{ price: bigint; baseAmount: bigint; quoteAmount: bigint; expiryBlock: bigint; settledSlot: bigint; provider: `0x${string}`; baseToken: `0x${string}`; quoteToken: `0x${string}` } | null> {
  const raw = await publicClient
    .readContract({
      address: ORACLE_ADDRESS as `0x${string}`,
      abi: MONORACLE_ABI,
      functionName: "quotes",
      args: [quoteId],
    })
    .catch(() => null);
  if (!raw) return null;
  // Name-based decode: field indexes are derived from the doctor-gated ABI at
  // runtime (never bend the declared order — see web/src/lib/decode.ts).
  const q = decodeQuote(raw as readonly unknown[]);
  if (q.provider === getAddress("0x0000000000000000000000000000000000000000")) return null;
  return {
    provider: q.provider,
    baseToken: q.baseToken,
    quoteToken: q.quoteToken,
    baseAmount: q.baseAmount,
    quoteAmount: q.quoteAmount,
    price: q.price,
    expiryBlock: BigInt(q.expiryBlock),
    settledSlot: BigInt(q.settledSlot),
  };
}

type Quote = NonNullable<Awaited<ReturnType<typeof readQuote>>>;

function toPosition(ev: IndexedPositionEvent, q: Quote): Position {
  const s = ev.side;
  if (ev.kind === "wrapped") {
    return {
      id: `wrapped-${ev.quoteId.toString()}`,
      side: s,
      marketId: ev.marketId,
      baseToken: q.baseToken,
      quoteToken: q.quoteToken,
      quoteId: ev.quoteId,
      openPrice: q.price,
      heldBase: s === "bull" ? ev.swapOut : 0n,
      heldQuote: s === "bear" ? ev.swapOut : 0n,
      paidBase: s === "bear" ? ev.swapIn : 0n,
      paidQuote: s === "bull" ? ev.swapIn + ev.fee : 0n,
      fee: ev.fee,
      expiryBlock: q.expiryBlock,
      openedAtBlock: Number(ev.blockNumber),
    };
  }
  return {
    id: `vetoed-${ev.quoteId.toString()}`,
    side: s,
    marketId: null,
    baseToken: q.baseToken,
    quoteToken: q.quoteToken,
    quoteId: ev.quoteId,
    openPrice: q.price,
    heldBase: s === "bull" ? q.baseAmount : 0n,
    heldQuote: s === "bear" ? q.quoteAmount : 0n,
    paidBase: s === "bear" ? q.baseAmount : 0n,
    paidQuote: s === "bull" ? q.quoteAmount : 0n,
    fee: 0n,
    expiryBlock: q.expiryBlock,
    openedAtBlock: Number(ev.blockNumber),
  };
}

/** The same events from chunked eth_getLogs over the last LOOKBACK_BLOCKS. */
async function eventsFromLogs(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  address: `0x${string}`,
  latest: bigint,
): Promise<IndexedPositionEvent[]> {
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

  const events: IndexedPositionEvent[] = [];
  for (const log of wrappedRaw) {
    try {
      const decoded = decodeEventLog({
        abi: IRMARKET_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      if (decoded.eventName !== "VetoWrapped") continue;
      const argsD = decoded.args as unknown as Record<string, unknown>;
      events.push({
        kind: "wrapped",
        quoteId: argsD.quoteId as bigint,
        marketId: argsD.marketId as bigint,
        side: SIDE_LABEL[Number((argsD.side as number) ?? 0)] ?? "bull",
        swapIn: argsD.swapIn as bigint,
        swapOut: argsD.swapOut as bigint,
        fee: (argsD.fee as bigint) ?? 0n,
        blockNumber: log.blockNumber,
      });
    } catch {
      continue;
    }
  }

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
    events.push({
      kind: "vetoed",
      quoteId: args.quoteId,
      marketId: null,
      side: decoded.eventName === "QuoteVetoedUnderpriced" ? "bull" : "bear",
      swapIn: 0n,
      swapOut: 0n,
      fee: 0n,
      blockNumber: log.blockNumber,
    });
  }
  return events;
}

/**
 * Positions derived from on-chain events (R15 — no IRMarket ledger):
 *  - Wrapper opens: `VetoWrapped(trader = user)` — exact swap in/out + fee.
 *  - Direct vetoes (reverse closes / power users): `QuoteVetoed*` where verifier = user,
 *    amounts reconstructed from `quotes(quoteId)`.
 *
 * With NEXT_PUBLIC_INDEXER_URL set, the events come from a nuthatch nest over the full
 * history; if it is unreachable, partial or indexing other contracts, the chunked
 * eth_getLogs scan below runs instead (Monad testnet caps eth_getLogs at ~100 blocks).
 */
export function usePositions(address: `0x${string}` | undefined) {
  const publicClient = usePublicClient();
  const blockNumber = useCurrentBlock();

  const query = useQuery({
    queryKey: ["positions", address?.toLowerCase(), isFullyConfigured],
    queryFn: async (): Promise<Position[]> => {
      if (!publicClient || !address || !isFullyConfigured) return [];

      const indexed = INDEXER_URL
        ? await fetchPositionEvents(INDEXER_URL, address, hasWrapper ? MARKET_ADDRESS : null, ORACLE_ADDRESS)
        : null;
      const events =
        indexed ?? (await eventsFromLogs(publicClient, address, blockNumber ?? (await publicClient.getBlockNumber())));

      const wrapped: Position[] = [];
      const vetoed: Position[] = [];
      for (const ev of events) {
        const q = await readQuote(publicClient, ev.quoteId);
        if (!q) continue;
        (ev.kind === "wrapped" ? wrapped : vetoed).push(toPosition(ev, q));
      }
      return [...wrapped, ...vetoed];
    },
    enabled: isFullyConfigured && !!address && !!publicClient,
    refetchInterval: blockNumber !== undefined ? 15000 : 5000,
    staleTime: 5000,
  });

  return { positions: query.data ?? [], refetch: query.refetch, status: query.status };
}

/** True when the given token is the HKD quote token (used for short-asset valuation). */
export function isQuoteToken(token: `0x${string}`): boolean {
  if (!isFullyConfigured) return false;
  return token.toLowerCase() === QUOTE_TOKEN.toLowerCase();
}
