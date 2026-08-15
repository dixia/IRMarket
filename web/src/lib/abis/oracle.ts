import type { Abi } from "viem";
import monoracleWindowedJson from "./MonoracleWindowed.json";

export const MONORACLE_ABI = monoracleWindowedJson as unknown as Abi;