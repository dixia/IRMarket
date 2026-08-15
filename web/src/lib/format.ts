// Formatting helpers for the 1e18 fixed-point prices/amounts used on Monad.

export const PRICE_DECIMALS = 18n;

/** price is quote-per-base in 1e18 fixed-point. */
export function formatPrice(price: bigint | undefined, decimals = 6): string {
  if (price === undefined) return "—";
  return toNumberString(price, decimals);
}

export function toNumberString(value: bigint, decimals = 4): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  if (decimals === 0) return `${whole.toString()}`;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const s = fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
  return neg ? `-${s}` : s;
}

/** Format a token amount with its decimals (default 18). */
export function formatAmount(value: bigint | undefined, decimals = 18, maxFraction = 4): string {
  if (value === undefined) return "—";
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  if (frac === 0n) return `${neg ? "-" : ""}${whole.toString()}`;
  let fracStr = frac.toString().padStart(decimals, "0");
  if (maxFraction < decimals) fracStr = fracStr.slice(0, maxFraction);
  fracStr = fracStr.replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${fracStr ? "." + fracStr : ""}`;
}

/** PNL in HKD terms: value − cost. Returns scaled by 1e18. */
export function pnlBig(value: bigint, cost: bigint): bigint {
  return value - cost;
}

export function formatPnl(pnl: bigint | undefined): string {
  if (pnl === undefined) return "—";
  const s = toNumberString(pnl < 0n ? -pnl : pnl, 4);
  return `${pnl < 0n ? "-" : "+"}${s}`;
}

export function shortenAddress(address: string): string {
  if (!address) return "";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatCountdown(blocksLeft: bigint): string {
  if (blocksLeft <= 0n) return "已到期";
  const mins = Number(blocksLeft) / 600; // ~600 blocks ≈ 3 min
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${Math.floor(mins % 60)}m`;
  if (mins >= 1) return `${Math.floor(mins)}m ${Math.round((mins % 1) * 60)}s`;
  return `${Math.max(1, Math.round(mins * 60))}s`;
}

/** fee = quoteAmount × feeBps / 10000 (D-16). */
export function computeFee(quoteAmount: bigint, feeBps: bigint): bigint {
  if (feeBps <= 0n) return 0n;
  return (quoteAmount * feeBps) / 10000n;
}