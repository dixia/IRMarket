// IRMarketVaultFactory ABI (hand-crafted, as-built; keep in sync with
// artifacts/contracts/IRMarketVaultFactory.sol/IRMarketVaultFactory.json).
export const FACTORY_ABI = [
  {
    type: "function",
    name: "oracle",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "MAX_FEE_BPS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "createVault",
    stateMutability: "nonpayable",
    inputs: [
      { name: "baseToken", type: "address" },
      { name: "quoteToken", type: "address" },
      { name: "feeBps", type: "uint256" },
    ],
    outputs: [{ name: "vault", type: "address" }],
  },
  {
    type: "function",
    name: "vaultFor",
    stateMutability: "view",
    inputs: [
      { name: "baseToken", type: "address" },
      { name: "quoteToken", type: "address" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "vaults",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "vaultCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "isVault",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "VaultCreated",
    inputs: [
      { name: "vault", type: "address", indexed: true },
      { name: "baseToken", type: "address", indexed: true },
      { name: "quoteToken", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: false },
      { name: "feeBps", type: "uint256", indexed: false },
    ],
  },
] as const;
