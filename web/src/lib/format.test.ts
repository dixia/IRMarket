import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAmount, formatPnl, formatPrice, groupDigits } from "./format.ts";

const E18 = 10n ** 18n;

test("groupDigits inserts thousands separators", () => {
  assert.equal(groupDigits("0"), "0");
  assert.equal(groupDigits("999"), "999");
  assert.equal(groupDigits("1000"), "1,000");
  assert.equal(groupDigits("10013740"), "10,013,740");
});

test("formatAmount: whole amounts below 1e6 are grouped, not compacted", () => {
  assert.equal(formatAmount(113998n * E18, 18, 2), "113,998");
  assert.equal(formatAmount(999n * E18, 18, 2), "999");
  assert.equal(formatAmount(999999n * E18, 18, 2), "999,999");
});

test("formatAmount: whole amounts at/above 1e6 compact (2dp, trimmed)", () => {
  assert.equal(formatAmount(10013740n * E18, 18, 2), "10.01M");
  assert.equal(formatAmount(10000000n * E18, 18, 2), "10M");
  assert.equal(formatAmount(10500000n * E18, 18, 2), "10.5M");
  assert.equal(formatAmount(1200000000n * E18, 18, 2), "1.2B");
});

test("formatAmount: fractional values stay exact (grouped, never compacted)", () => {
  assert.equal(formatAmount(100137405n * 10n ** 17n, 18, 2), "10,013,740.5");
  assert.equal(formatAmount(5n * 10n ** 17n, 18, 4), "0.5");
  assert.equal(formatAmount(1234567890000000000n, 18, 4), "1.2345");
  assert.equal(formatAmount(1234567890000000000n, 18, 2), "1.23");
});

test("formatAmount: respects token decimals (6-dec token)", () => {
  assert.equal(formatAmount(1234567890n, 6, 4), "1,234.5678");
  assert.equal(formatAmount(2000000000n, 6, 4), "2,000");
});

test("formatAmount: decimals=0 and sign/undefined edges", () => {
  assert.equal(formatAmount(1000n, 0), "1,000");
  assert.equal(formatAmount(-10013740n * E18, 18, 2), "-10.01M");
  assert.equal(formatAmount(-1234n * E18, 18, 2), "-1,234");
  assert.equal(formatAmount(undefined, 18, 2), "—");
  assert.equal(formatAmount(0n, 18, 2), "0");
});

test("formatAmount: maxFraction 0 still shows a fractional value (never raw)", () => {
  assert.equal(formatAmount(1500000000000000000n, 18, 0), "1.5");
});

test("formatPnl signs, groups, compacts", () => {
  assert.equal(formatPnl(10013740n * E18), "+10.01M");
  assert.equal(formatPnl(1234n * E18), "+1,234");
  assert.equal(formatPnl(5n * 10n ** 17n), "+0.5");
  assert.equal(formatPnl(-5n * 10n ** 17n), "-0.5");
  assert.equal(formatPnl(0n), "+0");
  assert.equal(formatPnl(undefined), "—");
});

test("formatPrice groups but never compacts a rate", () => {
  assert.equal(formatPrice(130n * E18), "130");
  assert.equal(formatPrice(1234500000000000000000n), "1,234.5");
  assert.equal(formatPrice(10000000n * E18), "10,000,000");
  assert.equal(formatPrice(undefined), "—");
});
