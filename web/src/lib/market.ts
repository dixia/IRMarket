import artifact from "./abi.json";

function requireEnv(name: string, val: string | undefined): string {
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const MARKET_ADDRESS = requireEnv("NEXT_PUBLIC_MARKET_ADDRESS", process.env.NEXT_PUBLIC_MARKET_ADDRESS);
export const MARKET_ABI = artifact.abi;
export const EXPLORER_BASE = "https://testnet.monadscan.com";
export const EXPLORER_URL = `${EXPLORER_BASE}/address/${MARKET_ADDRESS}`;
export const RPC_URL = requireEnv("NEXT_PUBLIC_RPC_URL", process.env.NEXT_PUBLIC_RPC_URL);
export const CHAIN_ID = Number(requireEnv("NEXT_PUBLIC_CHAIN_ID", process.env.NEXT_PUBLIC_CHAIN_ID));