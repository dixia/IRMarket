/**
 * stack-reuse.js — pure reuse-decision policy for deploy-market-stack.js.
 *
 * The deploy reuses on-chain artefacts whenever their immutable bindings match the
 * run's inputs; `--fresh-wrapper` (FRESH_WRAPPER=1) forces a brand-new wrapper instead.
 * The decisions live here, free of ethers/fs/IO, so test/stack-reuse.test.js can pin
 * the policy without a chain: a silent wrong reuse (e.g. re-running a deploy and
 * unknowingly keeping a superseded wrapper build) is exactly the failure class the
 * cutover checklist guards against.
 */

const addressRe = /^0x[0-9a-fA-F]{40}$/;
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * A registry may only be consumed on the chain it was written for. A missing `chainId` is a
 * rejection (NaN !== id), never an implicit pass — the safe default is "deploy fresh".
 *
 * @param {{ chainId?: number | string } | null} registry
 * @param {number | string} chainId  the run's target chain
 * @returns {boolean}
 */
export function sameChain(registry, chainId) {
  return !!registry && Number(registry.chainId) === Number(chainId);
}

/**
 * IRMarket wrapper: immutable `oracle` binding. Reuse ONLY when a registry entry
 * exists, declares THIS oracle, AND the on-chain read confirms it. `freshWrapper`
 * short-circuits to false — a same-oracle rebuild (e.g. picking up new wrapper code)
 * always deploys.
 *
 * @param {{ market?: string, oracle?: string } | null} registry  deployment-assets.json (may be absent)
 * @param {string | null} chainOracle   oracle() read from registry.market (null = read failed / not an IRMarket)
 * @param {string} expectedOracle       the oracle address this run consumes
 * @param {{ freshWrapper?: boolean }} opts
 * @returns {boolean}
 */
export function shouldReuseWrapper(registry, chainOracle, expectedOracle, { freshWrapper = false } = {}) {
  if (freshWrapper) return false;
  if (!registry || !addressRe.test(registry.market || "")) return false;
  if (!same(registry.oracle, expectedOracle)) return false;
  if (!same(chainOracle, expectedOracle)) return false;
  return true;
}

/**
 * IRMarketVault: immutable `oracle / priceBase / settlementToken` bindings, one vault
 * per pair (MVP ships assets[0] only). Reuse ONLY when an address exists and all three
 * on-chain reads match; a failed read is treated as "not an IRMarketVault" → deploy.
 *
 * @param {{ vault?: string, oracle?: string | null, priceBase?: string | null, settlementToken?: string | null } | null} existing
 * @param {{ oracle: string, baseToken: string, quoteToken: string }} expected
 * @returns {boolean}
 */
export function shouldReuseVault(existing, expected) {
  if (!existing || !addressRe.test(existing.vault || "")) return false;
  return same(existing.oracle, expected.oracle)
    && same(existing.priceBase, expected.baseToken)
    && same(existing.settlementToken, expected.quoteToken);
}
