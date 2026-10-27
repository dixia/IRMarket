// Formatting helpers for the 1e18 fixed-point prices/amounts used by IRMarket.
//
// Display rules:
// - Whole-number amounts ≥ 1e6 are compact (10.01M, 1.2B) — see `formatWhole`.
// - Every other amount is grouped with thousands separators (113,998 / 1,234.5).
// - Fractional values are never compacted or truncated to a bare integer: the
//   fractional part is always shown (capped at `maxFraction`, trailing zeros trimmed).
// - Token amounts scale by the ERC20's on-chain `decimals()` (passed in by callers).

import { parseUnits } from "viem";

export const PRICE_DECIMALS = 18n;

/** Insert thousands separators into a non-negative integer string ("10013740" → "10,013,740"). */
export function groupDigits(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Compact a whole number ≥ 1e6 to 2 decimals + unit suffix, or null when < 1e6. */
function compactWhole(whole: bigint): string | null {
  const abs = whole < 0n ? -whole : whole;
  const units: Array<[string, bigint]> = [
    ["T", 10n ** 12n],
    ["B", 10n ** 9n],
    ["M", 10n ** 6n],
  ];
  for (const [suffix, div] of units) {
    if (abs >= div) {
      const scaled = (abs * 100n) / div; // 2 decimal places, truncated
      const int = scaled / 100n;
      const frac = (scaled % 100n).toString().padStart(2, "0").replace(/0+$/, "");
      return `${int}${frac ? "." + frac : ""}${suffix}`;
    }
  }
  return null;
}

/** Absolute whole-number amount → compact (≥1e6) or grouped digits. */
function formatWhole(whole: bigint): string {
  return compactWhole(whole) ?? groupDigits(whole.toString());
}

/** Absolute scaled value (already divided by `decimals`) → display string, no sign. */
function formatScaled(abs: bigint, decimals: number, maxFraction: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  if (frac === 0n) return formatWhole(whole);
  const cap = Math.max(1, maxFraction); // never drop the whole fraction of a nonzero value
  let fracStr = frac.toString().padStart(decimals, "0");
  if (cap < decimals) fracStr = fracStr.slice(0, cap);
  fracStr = fracStr.replace(/0+$/, "");
  return `${groupDigits(whole.toString())}${fracStr ? "." + fracStr : ""}`;
}

/** price is quote-per-base in 1e18 fixed-point. Rates are grouped but never compacted. */
export function formatPrice(price: bigint | undefined, decimals = 6): string {
  if (price === undefined) return "—";
  // rescale 1e18 fixed-point → 10^decimals before generic formatting
  const scaled = price / 10n ** (18n - BigInt(decimals));
  return toNumberString(scaled, decimals);
}

export function toNumberString(value: bigint, decimals = 4): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  if (decimals === 0) return `${neg ? "-" : ""}${groupDigits(whole.toString())}`;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const s = fracStr ? `${groupDigits(whole.toString())}.${fracStr}` : groupDigits(whole.toString());
  return neg ? `-${s}` : s;
}

/** Format a token amount with its on-chain decimals (default 18). */
export function formatAmount(value: bigint | undefined, decimals = 18, maxFraction = 4): string {
  if (value === undefined) return "—";
  const neg = value < 0n;
  return `${neg ? "-" : ""}${formatScaled(neg ? -value : value, decimals, maxFraction)}`;
}

/** PNL in HKD terms: value − cost. Returns scaled by 1e18. */
export function pnlBig(value: bigint, cost: bigint): bigint {
  return value - cost;
}

export function formatPnl(pnl: bigint | undefined): string {
  if (pnl === undefined) return "—";
  const neg = pnl < 0n;
  // pnl is 1e18-scaled HKD; rescale to 1e4 (4 decimals) for display
  const scaled = (neg ? -pnl : pnl) / 10n ** 14n;
  return `${neg ? "-" : "+"}${formatScaled(scaled, 4, 4)}`;
}

/** Parse a decimal string into a token amount. Returns undefined on empty/invalid input. */
export function parseAmount(input: string, decimals = 18): bigint | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  try {
    return parseUnits(trimmed, decimals);
  } catch {
    return undefined;
  }
}

export function shortenAddress(address: string): string {
  if (!address) return "";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatCountdown(blocksLeft: bigint, blockSeconds = 0.3): string {
  if (blocksLeft <= 0n) return "Expired";
  // Convert blocks to wall-clock minutes. Pass the chain's block time; the default matches
  // Monad's cadence so pure formatting stays dependency-free.
  const mins = (Number(blocksLeft) * blockSeconds) / 60;
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${Math.floor(mins % 60)}m`;
  if (mins >= 1) return `${Math.floor(mins)}m ${Math.round((mins % 1) * 60)}s`;
  return `${Math.max(1, Math.round(mins * 60))}s`;
}

/** fee = quoteAmount × feeBps / 10000 (D-16). */
export function computeFee(quoteAmount: bigint, feeBps: bigint): bigint {
  if (feeBps <= 0n) return 0n;
  return (quoteAmount * feeBps) / 10000n;
}
