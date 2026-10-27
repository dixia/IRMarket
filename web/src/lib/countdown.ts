// Chain-aware expiry countdown. `format.ts` stays dependency-free (it is exercised by the
// node --test suite), so the active chain's block time is injected here instead.
import { CHAIN_ID } from "./config";
import { chainParams } from "./chainParams";
import { formatCountdown as formatCountdownAt } from "./format";

export function formatCountdown(blocksLeft: bigint): string {
  return formatCountdownAt(blocksLeft, chainParams(CHAIN_ID).blockSeconds);
}
