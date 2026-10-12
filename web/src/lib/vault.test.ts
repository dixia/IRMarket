import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VaultSide,
  VAULT_MAX_FEE_BPS,
  VAULT_MAX_PROFIT_BPS,
  computeVaultFee,
  vaultAmountForShares,
  vaultMaxPayout,
  vaultNotional,
  vaultPayoutAt,
  vaultSharePrice,
  vaultSharesForDeposit,
  vaultUnits,
} from "./vault.ts";

const E18 = 10n ** 18n;

test("constants", () => {
  assert.equal(VAULT_MAX_FEE_BPS, 10_000n);
  assert.equal(VAULT_MAX_PROFIT_BPS, 10_000n);
});

test("fee / notional / maxPayout (D=100e18, feeBps=100)", () => {
  const D = 100n * E18;
  assert.equal(computeVaultFee(D, 100n), 1n * E18);
  assert.equal(vaultNotional(D, 100n), 99n * E18);
  assert.equal(vaultMaxPayout(99n * E18), 198n * E18);
});

test("units", () => {
  assert.equal(vaultUnits(99n * E18, 100n * E18), (99n * E18 * E18) / (100n * E18));
  assert.equal(vaultUnits(99n * E18, 0n), 0n);
});

test("payout LONG", () => {
  const base = { side: VaultSide.LONG, notional: 99n * E18, entryPrice: 100n * E18 };
  assert.equal(vaultPayoutAt(base, 150n * E18), 1485n * 10n ** 17n);
  assert.equal(vaultPayoutAt(base, 200n * E18), 198n * E18);
  assert.equal(vaultPayoutAt(base, 100n * E18), 99n * E18);
});

test("payout SHORT", () => {
  const base = { side: VaultSide.SHORT, notional: 99n * E18, entryPrice: 100n * E18 };
  assert.equal(vaultPayoutAt(base, 200n * E18), 0n);
  assert.equal(vaultPayoutAt(base, 50n * E18), 1485n * 10n ** 17n);
});

test("share price / shares / amount", () => {
  assert.equal(vaultSharePrice(902n * E18, 1000n * E18), 902n * 10n ** 15n);
  assert.equal(vaultSharesForDeposit(902n * E18, 1000n * E18, 902n * E18), 1000n * E18);
  assert.equal(vaultAmountForShares(1000n * E18, 1000n * E18, 902n * E18), 902n * E18);
});

test("zero-supply branches", () => {
  assert.equal(vaultSharesForDeposit(123n * E18, 0n, 0n), 123n * E18);
  assert.equal(vaultSharePrice(0n, 0n), undefined);
  assert.equal(vaultAmountForShares(123n * E18, 0n, 42n), 0n);
});
