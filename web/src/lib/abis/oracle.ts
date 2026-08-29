import type { Abi } from "viem";
import monoracleJson from "./Monoracle.json";

export const MONORACLE_ABI = monoracleJson.abi as unknown as Abi;