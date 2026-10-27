/**
 * stack-reuse.test.js — pins the deploy's reuse policy (script/stack-reuse.js).
 *
 * The wrapper/vault reuse decision is where a careless re-run can silently keep a
 * superseded on-chain build (the "wrapper gate not on-chain" gap happened exactly
 * because the reuse path was invisible). These tests fail fast on policy drift.
 * Pure functions — no network, no compiler.
 */
import { expect } from "chai";
import { sameChain, shouldReuseWrapper, shouldReuseVault } from "../script/stack-reuse.js";

const ORACLE = "0x807321100748d75a618e508de214123cb77c9f4d";
const OLD_WRAPPER = "0x39a14b5d0c049525c3c42de57e6d4553b0df5c99";
const NEW_WRAPPER = "0x3bc2c78b50909307d0b51efc0fe53ee2956ed551";
const NVDA = "0xda9cf5a68cc2d8efa5940db4094b6377d389de17";
const HKD = "0x36448ef080ba5fa251e1a9bd61782786f9e24f04";
const VAULT = "0x95a74c58bbf1f8f56c02d27aecc0024d98e67dd3";

describe("shouldReuseWrapper", () => {
  it("reuses when registry + on-chain oracle both match the run's oracle", () => {
    const registry = { market: OLD_WRAPPER, oracle: ORACLE };
    expect(shouldReuseWrapper(registry, ORACLE, ORACLE)).to.equal(true);
  });

  it("reuses regardless of address checksum case", () => {
    const registry = { market: OLD_WRAPPER.toUpperCase().replace(/^0X/, "0x"), oracle: ORACLE.toUpperCase().replace(/^0X/, "0x") };
    expect(shouldReuseWrapper(registry, ORACLE, ORACLE)).to.equal(true);
  });

  it("--fresh-wrapper forces a deploy even on a perfect match", () => {
    const registry = { market: OLD_WRAPPER, oracle: ORACLE };
    expect(shouldReuseWrapper(registry, ORACLE, ORACLE, { freshWrapper: true })).to.equal(false);
    expect(shouldReuseWrapper(registry, ORACLE, ORACLE, {})).to.equal(true);
  });

  it("refuses when the registry declares a different oracle", () => {
    const lazyOracle = "0x0bc36e1ac475adef75f102deb1708be6e45aa16f";
    const registry = { market: OLD_WRAPPER, oracle: lazyOracle };
    expect(shouldReuseWrapper(registry, ORACLE, ORACLE)).to.equal(false);
  });

  it("refuses when the on-chain read disagrees with the expected oracle", () => {
    const registry = { market: OLD_WRAPPER, oracle: ORACLE };
    expect(shouldReuseWrapper(registry, "0x" + "0".repeat(40), ORACLE)).to.equal(false);
  });

  it("refuses when the chain read failed (not an IRMarket) or no registry entry", () => {
    const registry = { market: OLD_WRAPPER, oracle: ORACLE };
    expect(shouldReuseWrapper(registry, null, ORACLE)).to.equal(false);
    expect(shouldReuseWrapper(null, ORACLE, ORACLE)).to.equal(false);
    expect(shouldReuseWrapper({ market: "0x123", oracle: ORACLE }, ORACLE, ORACLE)).to.equal(false);
  });
});

describe("sameChain", () => {
  it("accepts a registry written for the run's chain", () => {
    expect(sameChain({ chainId: 10143 }, 10143)).to.equal(true);
    expect(sameChain({ chainId: "43113" }, 43113)).to.equal(true);
  });

  it("rejects a registry from another chain", () => {
    expect(sameChain({ chainId: 10143 }, 43113)).to.equal(false);
    expect(sameChain({ chainId: "10143" }, 43113)).to.equal(false);
  });

  it("rejects a missing/absent registry or chainId (safe default: deploy fresh)", () => {
    expect(sameChain(null, 10143)).to.equal(false);
    expect(sameChain(undefined, 10143)).to.equal(false);
    expect(sameChain({}, 10143)).to.equal(false);
    expect(sameChain({ chainId: undefined }, 10143)).to.equal(false);
  });
});

describe("shouldReuseVault", () => {
  const existing = { vault: VAULT, oracle: ORACLE, priceBase: NVDA, settlementToken: HKD };
  const expected = { oracle: ORACLE, baseToken: NVDA, quoteToken: HKD };

  it("reuses when all three immutable bindings match", () => {
    expect(shouldReuseVault(existing, expected)).to.equal(true);
  });

  it("deploys a new vault when the oracle (or either token) differs", () => {
    expect(shouldReuseVault(existing, { ...expected, oracle: "0x0bc36e1ac475adef75f102deb1708be6e45aa16f" })).to.equal(false);
    expect(shouldReuseVault(existing, { ...expected, baseToken: NEW_WRAPPER })).to.equal(false);
    expect(shouldReuseVault(existing, { ...expected, quoteToken: NEW_WRAPPER })).to.equal(false);
  });

  it("deploys a new vault on a failed/partial chain read", () => {
    for (const key of ["vault", "oracle", "priceBase", "settlementToken"]) {
      const broken = { ...existing, [key]: key === "vault" ? "" : null };
      expect(shouldReuseVault(broken, expected)).to.equal(false);
    }
    expect(shouldReuseVault(null, expected)).to.equal(false);
  });
});
