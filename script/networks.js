/**
 * networks.js — the single per-chain parameter table for the deploy scripts.
 *
 * Every chain-derived value that used to be a hardcoded literal (registry filename, block
 * time, explorer URL, native-token label) resolves through here. Monad testnet is the
 * default, so the Monad path stays behaviourally identical; adding a chain is additive.
 *
 * Per-chain block time is required for anything that converts a wall-clock duration into a
 * block count. `blockSeconds === null` (unknown chain) or `0` (anvil, no fixed cadence) means
 * "not derivable": callers must pass an explicit BLOCK_SECONDS or fail loudly — never divide.
 */

import fs from "fs";
import path from "path";

export const CHAINS = {
  10143: { slug: "monad-testnet", blockSeconds: 0.3, explorer: "https://testnet.monadscan.com", symbol: "MON" },
  43113: { slug: "avalanche-fuji", blockSeconds: 2, explorer: "https://testnet.snowtrace.io", symbol: "AVAX" },
  31337: { slug: "anvil-local", blockSeconds: 0, explorer: "", symbol: "ETH" },
};

export function chainInfo(chainId) {
  const id = Number(chainId);
  const known = CHAINS[id];
  if (known) return { chainId: id, ...known };
  const slug = Number.isFinite(id) ? `chain-${id}` : "unknown";
  return { chainId: id, slug, blockSeconds: null, explorer: "", symbol: "ETH" };
}

/** Seconds per block, or a clear error when the chain is unknown and no override is set. */
export function blockSeconds(chainId, explicit = process.env.BLOCK_SECONDS) {
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== "") {
    const n = Number(explicit);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`BLOCK_SECONDS must be a positive number of seconds, got "${explicit}"`);
    }
    return n;
  }
  const { slug, blockSeconds: bs } = chainInfo(chainId);
  if (!bs || bs <= 0) {
    throw new Error(
      `No block time is known for chain ${chainId} (${slug}). Set BLOCK_SECONDS (seconds per block) explicitly.`,
    );
  }
  return bs;
}

/** Convert a wall-clock duration to a block count on this chain. */
export function blocksForSeconds(chainId, seconds, explicit) {
  return Math.floor(Number(seconds) / blockSeconds(chainId, explicit));
}

const REGISTRY_STEMS = {
  deployment: "deployment",
  assets: "deployment-assets",
  vault: "deployment-vault",
};

function stemFor(kind) {
  const stem = REGISTRY_STEMS[kind];
  if (!stem) throw new Error(`Unknown registry kind: ${kind}`);
  return stem;
}

/** Chain-scoped registry filename, e.g. deployment-assets.avalanche-fuji.json. */
export function registryFile(kind, chainId) {
  return `${stemFor(kind)}.${chainInfo(chainId).slug}.json`;
}

/** Pre-multichain filename, kept readable during the migration. */
export function legacyRegistryFile(kind) {
  return `${stemFor(kind)}.json`;
}

/**
 * Prefer the chain-scoped file; fall back to the legacy unsuffixed name (with a warning) so
 * existing checkouts keep working through the rename. Returns the preferred path even when
 * neither exists, so writers create the scoped file.
 */
export function resolveRegistryFile(rootDir, kind, chainId, { allowLegacy = true } = {}) {
  const preferred = path.join(rootDir, registryFile(kind, chainId));
  if (fs.existsSync(preferred)) return preferred;
  if (!allowLegacy) return preferred;
  const legacy = path.join(rootDir, legacyRegistryFile(kind));
  if (fs.existsSync(legacy)) {
    console.warn(
      `  ! using legacy registry ${legacyRegistryFile(kind)} for chain ${chainId} — rename it to ${registryFile(kind, chainId)}`,
    );
    return legacy;
  }
  return preferred;
}
