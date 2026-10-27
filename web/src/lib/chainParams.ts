// Per-chain parameters for the web app. Mirrors `script/networks.js` (the deploy-side table);
// keep the two in sync. `docs/chain-params.md` documents the same values.
//
// The UI degrades gracefully on an unknown chain (falls back to Monad's cadence) instead of
// throwing — the deploy scripts are the place that fails loudly.

export interface ChainParams {
  slug: string;
  blockSeconds: number;
  explorer: string;
  symbol: string;
}

const CHAINS: Record<number, ChainParams> = {
  10143: { slug: "monad-testnet", blockSeconds: 0.3, explorer: "https://testnet.monadscan.com", symbol: "MON" },
  43113: { slug: "avalanche-fuji", blockSeconds: 2, explorer: "https://testnet.snowtrace.io", symbol: "AVAX" },
  31337: { slug: "anvil-local", blockSeconds: 0.3, explorer: "", symbol: "ETH" },
};

const FALLBACK_BLOCK_SECONDS = 0.3;

export function chainParams(chainId: number): ChainParams {
  const known = CHAINS[chainId];
  if (known) return known;
  return {
    slug: `chain-${chainId}`,
    blockSeconds: FALLBACK_BLOCK_SECONDS,
    explorer: "",
    symbol: "ETH",
  };
}

/** Wall-clock seconds -> blocks on this chain (at least 1). */
export function blocksForSeconds(chainId: number, seconds: number): number {
  return Math.max(1, Math.floor(seconds / chainParams(chainId).blockSeconds));
}

/** Blocks -> wall-clock seconds on this chain. */
export function secondsForBlocks(chainId: number, blocks: number): number {
  return blocks * chainParams(chainId).blockSeconds;
}
