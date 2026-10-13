import type { Address } from "viem";

export const VAULT_MAX_FEE_BPS = 10_000n;
export const VAULT_MAX_PROFIT_BPS = 10_000n;

export const VaultSide = { LONG: 0, SHORT: 1 } as const;
export type VaultSideValue = (typeof VaultSide)[keyof typeof VaultSide];
export const VaultStatus = { OPEN: 0, SETTLED: 1 } as const;
export type VaultStatusValue = (typeof VaultStatus)[keyof typeof VaultStatus];

export interface VaultPosition {
  id: bigint;
  owner: Address;
  side: VaultSideValue;
  deposit: bigint;
  fee: bigint;
  notional: bigint;
  entryPrice: bigint;
  maxPayout: bigint;
  expiryBlock: bigint;
  status: VaultStatusValue;
}

/** fee = deposit × feeBps / 10_000 (rounds down). */
export function computeVaultFee(deposit: bigint, feeBps: bigint): bigint {
  return (deposit * feeBps) / VAULT_MAX_FEE_BPS;
}

/** N = deposit − fee (at-risk notional). */
export function vaultNotional(deposit: bigint, feeBps: bigint): bigint {
  return deposit - computeVaultFee(deposit, feeBps);
}

/** Worst-case obligation: N × (10_000 + 10_000) / 10_000 = 2N. */
export function vaultMaxPayout(notional: bigint): bigint {
  return (notional * (VAULT_MAX_FEE_BPS + VAULT_MAX_PROFIT_BPS)) / VAULT_MAX_FEE_BPS;
}

/** Informational base-native units U = N × 1e18 / entryPrice. */
export function vaultUnits(notional: bigint, entryPrice: bigint): bigint {
  if (entryPrice === 0n) return 0n;
  return (notional * 10n ** 18n) / entryPrice;
}

/** Replicates IRMarketVault._payout exactly (settle ≥ entry and settle < entry branches). */
export function vaultPayoutAt(
  position: { side: VaultSideValue; notional: bigint; entryPrice: bigint },
  settlePrice: bigint,
): bigint {
  const notional = position.notional;
  let pnl: bigint;

  if (settlePrice >= position.entryPrice) {
    const up = ((settlePrice - position.entryPrice) * notional) / position.entryPrice;
    pnl = position.side === VaultSide.LONG ? up : -up;
  } else {
    const down = ((position.entryPrice - settlePrice) * notional) / position.entryPrice;
    pnl = position.side === VaultSide.LONG ? -down : down;
  }

  const cap = (notional * VAULT_MAX_PROFIT_BPS) / VAULT_MAX_FEE_BPS;
  if (pnl > cap) pnl = cap;
  if (pnl < -notional) pnl = -notional;

  return notional + pnl;
}

/** Trader PnL at a given settle price: payout − premium paid (`deposit`). */
export function vaultPnlAt(
  position: { side: VaultSideValue; notional: bigint; entryPrice: bigint; deposit: bigint },
  settlePrice: bigint,
): bigint {
  return vaultPayoutAt(position, settlePrice) - position.deposit;
}

/** equity per share (WAD); undefined when totalShares == 0. */
export function vaultSharePrice(equity: bigint, totalShares: bigint): bigint | undefined {
  if (totalShares === 0n) return undefined;
  return (equity * 10n ** 18n) / totalShares;
}

/** shares = amount × totalShares / equity; totalShares == 0 → amount. */
export function vaultSharesForDeposit(amount: bigint, totalShares: bigint, equity: bigint): bigint {
  if (totalShares === 0n) return amount;
  return (amount * totalShares) / equity;
}

/** amount = shares × equity / totalShares; 0 when totalShares == 0. */
export function vaultAmountForShares(shares: bigint, totalShares: bigint, equity: bigint): bigint {
  if (totalShares === 0n) return 0n;
  return (shares * equity) / totalShares;
}
