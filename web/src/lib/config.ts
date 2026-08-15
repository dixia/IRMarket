// Central app config: addresses, chain, tokens, demo market.
// Uses env when present; otherwise renders a "not configured" state instead of crashing
// (the scaffold previously threw on missing env — see git history).
//
// NOTE: NEXT_PUBLIC_* must be referenced as LITERALS (process.env.NEXT_PUBLIC_X). Next.js
// only inlines literal references into client bundles; dynamic access like
// `process.env[key]` resolves to "" in the browser even when .env.local is set.

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://testnet-rpc.monad.xyz";
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 10143);
export const EXPLORER_BASE = "https://testnet.monadscan.com";

// MonoracleWindowed — the IRMarket-deployed fork with per-quote expiryBlock (D-13).
// NOT the upstream Monoracle testnet deployment (fixed 2-slot window).
export const ORACLE_ADDRESS_RAW = process.env.NEXT_PUBLIC_ORACLE_ADDRESS || "";
export const ORACLE_ADDRESS = ORACLE_ADDRESS_RAW as `0x${string}`;

// IRMarket fee wrapper (openLong/openShort). Empty → direct veto mode (fee 0 / demo).
export const MARKET_ADDRESS_RAW = process.env.NEXT_PUBLIC_MARKET_ADDRESS || "";
export const MARKET_ADDRESS = MARKET_ADDRESS_RAW as `0x${string}`;

// Demo tokens: LLM (base) / HKD (quote). Empty → not-deployed state.
export const BASE_TOKEN_RAW = process.env.NEXT_PUBLIC_BASE_TOKEN || "";
export const BASE_TOKEN = BASE_TOKEN_RAW as `0x${string}`;
export const QUOTE_TOKEN_RAW = process.env.NEXT_PUBLIC_QUOTE_TOKEN || "";
export const QUOTE_TOKEN = QUOTE_TOKEN_RAW as `0x${string}`;

export const DEMO_MARKET_ID = BigInt(process.env.NEXT_PUBLIC_DEMO_MARKET_ID || "1");
export const EXPIRY_SECONDS = Number(process.env.NEXT_PUBLIC_EXPIRY_SECONDS || 3 * 60);

export const isFullyConfigured =
  ORACLE_ADDRESS_RAW !== "" && BASE_TOKEN_RAW !== "" && QUOTE_TOKEN_RAW !== "";

export const hasWrapper = MARKET_ADDRESS_RAW !== "";

export function explorerTxUrl(hash: string): string {
  return `${EXPLORER_BASE}/tx/${hash}`;
}

export function explorerAddressUrl(address: string): string {
  return `${EXPLORER_BASE}/address/${address}`;
}