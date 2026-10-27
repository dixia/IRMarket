"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { decodeEventLog, type AbiEvent } from "viem";
import { VAULT_ABI } from "@/lib/abis/vault";
import { getLogsChunked } from "@/lib/logs";
import { VAULT_ADDRESS, VAULT_ADDRESS_RAW, CHAIN_ID, hasVault } from "@/lib/config";
import { blocksForSeconds } from "@/lib/chainParams";
import { useCurrentBlock } from "./useCurrentBlock";

// PositionSettled stores the realized payout that the struct itself does not persist
// (lp-pool-frontend-design §2/§4.5); the chunked read window mirrors usePositions.
const LOOKBACK_BLOCKS = BigInt(blocksForSeconds(CHAIN_ID, 25 * 60));

const POSITION_SETTLED_EVENT = VAULT_ABI.find(
  (e): e is Extract<(typeof VAULT_ABI)[number], { type: "event" }> =>
    e.type === "event" && e.name === "PositionSettled",
) as AbiEvent;

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
        address: VAULT_ADDRESS as `0x${string}`,
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
