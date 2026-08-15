import type { Abi } from "viem";

// IRMarket wrapper ABI — fee-wrapping entries openLong/openShort (sc-tech-spec §3.4/§11.1).
// The registry + wrapper contract is still scaffolding; this ABI is the target interface
// the UI renders against. Fee path (openLong/openShort) is used only when the wrapper
// address is configured; otherwise the app trades direct on MonoracleWindowed (fee 0).
export const IRMARKET_ABI = [
  {
    type: "function",
    name: "openLong",
    inputs: [
      { name: "marketId", type: "uint256" },
      { name: "quoteId", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "openShort",
    inputs: [
      { name: "marketId", type: "uint256" },
      { name: "quoteId", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "createMarket",
    inputs: [
      { name: "baseToken", type: "address" },
      { name: "quoteToken", type: "address" },
      { name: "marketMaker", type: "address" },
      { name: "expiryBlock", type: "uint256" },
      { name: "feeBps", type: "uint256" },
    ],
    outputs: [{ name: "marketId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "markets",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "baseToken", type: "address" },
      { name: "quoteToken", type: "address" },
      { name: "marketMaker", type: "address" },
      { name: "feeBps", type: "uint256" },
      { name: "expiryBlock", type: "uint256" },
      { name: "createdAtBlock", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nextMarketId",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "MarketCreated",
    inputs: [
      { name: "marketId", type: "uint256", indexed: true },
      { name: "baseToken", type: "address", indexed: true },
      { name: "quoteToken", type: "address", indexed: true },
      { name: "marketMaker", type: "address", indexed: false },
      { name: "expiryBlock", type: "uint256", indexed: false },
      { name: "feeBps", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "VetoWrapped",
    inputs: [
      { name: "quoteId", type: "uint256", indexed: true },
      { name: "marketId", type: "uint256", indexed: true },
      { name: "trader", type: "address", indexed: true },
      { name: "side", type: "uint8", indexed: true },
      { name: "swapIn", type: "uint256", indexed: false },
      { name: "swapOut", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
    ],
  },
] as const satisfies Abi;

export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "mint",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "decimals",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
  },
] as const satisfies Abi;