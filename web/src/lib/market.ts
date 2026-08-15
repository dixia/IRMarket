import type { Abi, Address } from "viem";
import { MONORACLE_ABI } from "./abis/oracle";
import { BASE_TOKEN, EXPLORER_BASE, ORACLE_ADDRESS, QUOTE_TOKEN, isFullyConfigured } from "./config";

export const EXPLORER_URL = ORACLE_ADDRESS
  ? `${EXPLORER_BASE}/address/${ORACLE_ADDRESS}`
  : EXPLORER_BASE;

export const marketOracleParams = isFullyConfigured
  ? { address: ORACLE_ADDRESS as Address, abi: MONORACLE_ABI as Abi }
  : null;

export const PAIR = isFullyConfigured
  ? {
      base: BASE_TOKEN as Address,
      quote: QUOTE_TOKEN as Address,
    }
  : null;