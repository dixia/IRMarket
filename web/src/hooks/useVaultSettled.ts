"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { decodeEventLog, type AbiEvent, type Address } from "viem";
import { VAULT_ABI } from "@/lib/abis/vault";
import { VAULT_ADDRESS, VAULT_ADDRESS_RAW, hasVault } from "@/lib/config";
import { useCurrentBlock } from "./useCurrentBlock";

// Monad testnet RPCs cap eth_getLogs at a ~100-block range (see usePositions.ts), so event
// history is fetched in chunked windows. PositionSettled stores the realized payout that the
// struct itself does not persist (lp-pool-frontend-handoff §2/§4.4).
const LOG_CHUNK_BLOCKS = 100n;
const LOOKBACK_BLOCKS = 5000n;

const POSITION_SETTLED_EVENT = VAULT_ABI.find(
  (e): e is Extract<(typeof VAULT_ABI)[number], { type: "event" }> =>
    e.type === "event" && e.name === "PositionSettled",
) as AbiEvent;

interface RawLog {
  data: `0x${string}`;
  topics: `0x${string}`[];
}

async function getLogsChunked(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  params: { address: Address; event: AbiEvent; fromBlock: bigint; toBlock: bigint },
): Promise<RawLog[]> {
  const ranges: Array<{ from: bigint; to: bigint }> = [];
  let from = params.fromBlock;
  while (from <= params.toBlock) {
    const to = from + LOG_CHUNK_BLOCKS - 1n > params.toBlock ? params.toBlock : from + LOG_CHUNK_BLOCKS - 1n;
    ranges.push({ from, to });
    from = to + 1n;
  }

  const results = await Promise.all(
    ranges.map(({ from: f, to: t }) =>
      publicClient
        .getLogs({
          address: params.address,
          event: params.event,
          fromBlock: f,
          toBlock: t,
        })
        .then((logs) => logs.map((l) => ({ data: l.data, topics: l.topics as `0x${string}`[] })))
        .catch(() => [] as RawLog[]),
    ),
  );
  return results.flat();
}

export interface VaultSettledPayout {
  settlePrice: bigint;
  payout: bigint;
}

/** Realized payout per settled position, decoded from `PositionSettled` logs (keyed by positionId). */
export function useVaultSettledPayouts(account?: `0x${string}`): {
  payouts: Map<string, VaultSettledPayout>;
  isLoading: boolean;
} {
  const publicClient = usePublicClient();
  const blockNumber = useCurrentBlock();

  const query = useQuery({
    queryKey: ["vaultSettled", account?.toLowerCase(), VAULT_ADDRESS_RAW],
    queryFn: async (): Promise<Map<string, VaultSettledPayout>> => {
      const payouts = new Map<string, VaultSettledPayout>();
      if (!publicClient || !hasVault) return payouts;

      const latest = blockNumber ?? (await publicClient.getBlockNumber());
      const fromBlock = latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n;

      const raw = await getLogsChunked(publicClient, {
        address: VAULT_ADDRESS as Address,
        event: POSITION_SETTLED_EVENT,
        fromBlock,
        toBlock: latest,
      });

      for (const log of raw) {
        try {
          const decoded = decodeEventLog({
            abi: VAULT_ABI,
            data: log.data,
            topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
          });
          if (decoded.eventName !== "PositionSettled") continue;
          const args = decoded.args as unknown as {
            positionId: bigint;
            settlePrice: bigint;
            payout: bigint;
          };
          payouts.set(args.positionId.toString(), {
            settlePrice: args.settlePrice,
            payout: args.payout,
          });
        } catch {
          continue;
        }
      }
      return payouts;
    },
    enabled: hasVault && !!VAULT_ADDRESS && !!publicClient && !!account,
    refetchInterval: blockNumber !== undefined ? 15000 : 5000,
    staleTime: 5000,
  });

  return { payouts: query.data ?? new Map<string, VaultSettledPayout>(), isLoading: query.isLoading };
}
