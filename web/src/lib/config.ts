// Central app config: addresses, chain, tokens, demo market.
// Uses env when present; otherwise renders a "not configured" state instead of crashing
// (the scaffold previously threw on missing env — see git history).
//
// NOTE: NEXT_PUBLIC_* must be referenced as LITERALS (process.env.NEXT_PUBLIC_X). Next.js
// only inlines literal references into client bundles; dynamic access like
// `process.env[key]` resolves to "" in the browser even when .env.local is set.
// Values are `.trim()`ed: env vars set via `vercel env add` (or a piped shell) can carry a
// trailing CR/LF, which silently corrupts address parsing and breaks every contract read.

export const RPC_URL = (process.env.NEXT_PUBLIC_RPC_URL || "https://testnet-rpc.monad.xyz").trim();
export const CHAIN_ID = Number((process.env.NEXT_PUBLIC_CHAIN_ID || "10143").trim());
export const EXPLORER_BASE = "https://testnet.monadscan.com";

// Monoracle — the deployed oracle (per-quote expiryBlock).
export const ORACLE_ADDRESS_RAW = (process.env.NEXT_PUBLIC_ORACLE_ADDRESS || "").trim();
export const ORACLE_ADDRESS = ORACLE_ADDRESS_RAW as `0x${string}`;

// IRMarket fee wrapper (openLong/openShort). Empty → direct veto mode (fee 0 / demo).
export const MARKET_ADDRESS_RAW = (process.env.NEXT_PUBLIC_MARKET_ADDRESS || "").trim();
export const MARKET_ADDRESS = MARKET_ADDRESS_RAW as `0x${string}`;

// Demo tokens: LLM (base) / HKD (quote). Empty → not-deployed state.
export const BASE_TOKEN_RAW = (process.env.NEXT_PUBLIC_BASE_TOKEN || "").trim();
export const BASE_TOKEN = BASE_TOKEN_RAW as `0x${string}`;
export const QUOTE_TOKEN_RAW = (process.env.NEXT_PUBLIC_QUOTE_TOKEN || "").trim();
export const QUOTE_TOKEN = QUOTE_TOKEN_RAW as `0x${string}`;

// Round cadence (informational copy only — rounds are QUOTE expiryBlocks; the bot's
// ROUND_BLOCKS=3000 defines 15 min). One market per pair; market expiryBlock is inert
// (docs/web-tech-design.md §4.2).
export const EXPIRY_SECONDS = Number((process.env.NEXT_PUBLIC_EXPIRY_SECONDS || String(15 * 60)).trim());

export const isFullyConfigured =
  ORACLE_ADDRESS_RAW !== "" && BASE_TOKEN_RAW !== "" && QUOTE_TOKEN_RAW !== "";

// Curation (frontend-only registry): comma-separated list of base tokens the product shows.
// Empty/absent => show every market on the wrapper (backwards compatible). Literal reference
// only — Turbopack does not inline dynamic env access (see header note above).
export const SELECTED_BASE_TOKENS = (process.env.NEXT_PUBLIC_SELECTED_BASE_TOKENS || "")
  .trim()
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((a) => /^0x[0-9a-f]{40}$/.test(a));

export const hasWrapper = MARKET_ADDRESS_RAW !== "";

// LP-pool vault (IRMarketVault). Empty → vault UI shows a "not configured" state.
export const VAULT_ADDRESS_RAW = (process.env.NEXT_PUBLIC_VAULT_ADDRESS || "").trim();
export const VAULT_ADDRESS = VAULT_ADDRESS_RAW as `0x${string}`;
export const hasVault = VAULT_ADDRESS_RAW !== "";

// Fixed gas limits. Monad charges gas_limit × price_per_gas (NOT gasUsed — on Monad
// eth_getTransactionReceipt.gasUsed just mirrors the limit you sent), so these numbers
// are the user's real cost and an inflated one silently overcharges every trade.
// Measured with `npx hardhat run script/gas-report.js` (local) and live
// eth_estimateGas on Monad testnet:
//   approve (ERC20, cold 0 -> max)      33,586 live / 47,242 local
//   openLong / openShort (1% wrapper)  138,547-152,148 local  (~170,000 on the real
//                                       oracle: it runs ~11% hotter than the mock,
//                                       cross-checked against live submitQuote)
//   vetoUnderpriced / vetoOverpriced     77,122 local  (~86,000 on the real oracle)
// Limits below carry >=70% head-room over the live estimate: a too-tight limit reverts
// the user's trade (and they still pay the limit on Monad), while a too-loose one only
// costs a fraction of a cent. Do NOT let a wallet estimateGas on a reverting call
// inflate these (web-tech-design §7.1).
export const GAS_APPROVE = 60_000n;
export const GAS_VETO = 160_000n;
export const GAS_WRAPPER = 260_000n;
export const FAUCET_AMOUNT = 2000n * 10n ** 18n;
export const MON_RESERVE_FLOOR = 10n * 10n ** 18n;

export function explorerTxUrl(hash: string): string {
  return `${EXPLORER_BASE}/tx/${hash}`;
}

export function explorerAddressUrl(address: string): string {
  return `${EXPLORER_BASE}/address/${address}`;
}