// Shared chunked eth_getLogs helper. Event history must be fetched in chunked windows:
// Monad testnet providers cap eth_getLogs at 100 blocks (2026-11-06, measured with BOTH
// dense and topic-filtered scans): testnet-rpc.monad.xyz / thirdweb return -32602
// "block range too large" and BlockVision -32613 "log response size exceeded" past 100,
// while avalanche-fuji publicnode allows ~1000 (docs/chain-params.md). So the width is a
// per-deployment env knob (`NEXT_PUBLIC_LOG_CHUNK_BLOCKS`, default = the 100-block floor
// that works everywhere), NOT a constant to guess. The env var is read as a bare literal
// (Turbopack only inlines bare `process.env.NEXT_PUBLIC_*` references — AGENTS.md, web/).
import type { Address, AbiEvent } from "viem";
import { usePublicClient } from "wagmi";

// Verified everywhere-cap: a window this narrow always fits, on every provider tested.
const MIN_SAFE_CHUNK = 100n;

const CONFIGURED_CHUNK = (() => {
  const raw = process.env.NEXT_PUBLIC_LOG_CHUNK_BLOCKS;
  if (!raw) return null;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < Number(MIN_SAFE_CHUNK)) return null;
  return BigInt(n);
})();

/** Configured width (environment), falling back to the universal 100-block floor. */
export const LOG_CHUNK_BLOCKS = CONFIGURED_CHUNK ?? MIN_SAFE_CHUNK;

export type PublicClientT = NonNullable<ReturnType<typeof usePublicClient>>;

export interface RawLog {
  data: `0x${string}`;
  topics: `0x${string}`[];
  blockNumber: bigint;
}

/**
 * Inclusive [from,to] block windows covering [fromBlock,toBlock] in ≤chunk steps.
 * `newestFirst` returns the windows in descending order (latest window first), which lets
 * callers scan for the newest data and stop early.
 */
export function blockWindows(
  fromBlock: bigint,
  toBlock: bigint,
  chunk: bigint = LOG_CHUNK_BLOCKS,
  newestFirst = false,
) {
  const windows: Array<{ from: bigint; to: bigint }> = [];
  for (let from = fromBlock; from <= toBlock; from += chunk) {
    const to = from + chunk - 1n > toBlock ? toBlock : from + chunk - 1n;
    windows.push({ from, to });
  }
  return newestFirst ? windows.reverse() : windows;
}

const PROVIDER_CAP_ERRORS = [
  "block range too large", // -32602 (testnet-rpc.monad.xyz, thirdweb)
  "log response size exceeded", // -32613 (BlockVision)
];

function isProviderCapError(e: unknown): boolean {
  const msg = String((e as { message?: string } | undefined)?.message ?? e).toLowerCase();
  return PROVIDER_CAP_ERRORS.some((p) => msg.includes(p));
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** eth_getLogs over [fromBlock,toBlock] in chunks; per-chunk retries AND a cap-shrink retry. */
export async function getLogsChunked(
  publicClient: PublicClientT,
  params: { address: Address; event?: AbiEvent; args?: Record<string, unknown>; fromBlock: bigint; toBlock: bigint },
): Promise<RawLog[]> {
  const ranges = blockWindows(params.fromBlock, params.toBlock);

  // Fetch in small batches: firing every chunk at once trips provider rate limits (429),
  // and silently dropping a chunk silently hides whatever logs it holds (e.g. the newest
  // MarketCreated — exactly the data the user came for).
  const fail = (msg: string, e: unknown) => {
    if (process.env.NODE_ENV !== "production") console.warn(msg, e);
  };
  const fetchOnce = async (r: { from: bigint; to: bigint }): Promise<RawLog[]> => {
    const logs = await publicClient.getLogs({
      address: params.address,
      event: params.event,
      args: params.args,
      fromBlock: r.from,
      toBlock: r.to,
    });
    return logs.map((l) => ({
      data: l.data,
      topics: l.topics as [`0x${string}`, ...`0x${string}`[]],
      blockNumber: BigInt(l.blockNumber),
    }));
  };

  const one = async (r: { from: bigint; to: bigint }): Promise<RawLog[]> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(400 * attempt);
      try {
        return await fetchOnce(r);
      } catch (e) {
        lastErr = e;
        if (isProviderCapError(e)) break; // the same width can never succeed — shrink instead
      }
    }
    // The cap can move under our feet (provider-side change, a deployment reusing this
    // helper on another chain): shrink to the verified floor and retry once instead of
    // returning an empty window for a range that is merely too wide.
    const width = r.to - r.from + 1n;
    if (lastErr !== undefined && isProviderCapError(lastErr) && width > MIN_SAFE_CHUNK) {
      const subs = blockWindows(r.from, r.to, MIN_SAFE_CHUNK);
      const parts = await Promise.all(subs.map((s) => one(s)));
      return parts.flat();
    }
    fail("getLogsChunked: chunk failed after retries", lastErr);
    return [];
  };

  const GET_LOGS_CONCURRENCY = 6;
  const out: RawLog[] = [];
  for (let i = 0; i < ranges.length; i += GET_LOGS_CONCURRENCY) {
    const batch = ranges.slice(i, i + GET_LOGS_CONCURRENCY);
    const results = await Promise.all(batch.map((r) => one(r)));
    out.push(...results.flat());
  }
  return out;
}
