import {
  createPublicClient,
  createWalletClient,
  http,
  decodeEventLog,
  type Address,
  type Hex,
} from "viem";
import { anvil } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { maxUint256 } from "viem";

import fs from "fs";
import path from "path";

const SHARED_DIR = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "shared",
  "IRMarket"
);

function loadArtifact(name: string) {
  const artifactPath = path.join(
    SHARED_DIR,
    "artifacts",
    "contracts",
    `${name}.sol`,
    `${name}.json`
  );
  return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
}

export interface DeployedContracts {
  oracle: Address;
  market: Address;
  baseToken: Address;
  quoteToken: Address;
}

const ACCOUNT_0_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const ACCOUNT_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;

const mintABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const approveABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const oracleABI = loadArtifact("Monoracle").abi;
const irMarketABI = loadArtifact("IRMarket").abi;

const submitQuoteFn = oracleABI.find((f: any) => f.name === "submitQuote") as any;

export async function deployContracts(): Promise<DeployedContracts> {
  const transport = http("http://localhost:8545");

  const publicClient = createPublicClient({
    chain: anvil,
    transport,
  });

  const walletClient = createWalletClient({
    chain: anvil,
    transport,
    account: privateKeyToAccount(ACCOUNT_0_PK),
  });

  const oracleHash = await walletClient.deployContract({
    abi: oracleABI,
    bytecode: loadArtifact("MonoracleWindowed").bytecode as Hex,
  });
  const oracleReceipt = await publicClient.waitForTransactionReceipt({ hash: oracleHash });
  const oracleAddr = oracleReceipt.contractAddress!;

  const marketHash = await walletClient.deployContract({
    abi: irMarketABI,
    bytecode: loadArtifact("IRMarket").bytecode as Hex,
    args: [oracleAddr],
  });
  const marketReceipt = await publicClient.waitForTransactionReceipt({ hash: marketHash });
  const marketAddr = marketReceipt.contractAddress!;

  const baseHash = await walletClient.deployContract({
    abi: loadArtifact("MockERC20").abi,
    bytecode: loadArtifact("MockERC20").bytecode as Hex,
    args: ["Liuliumei", "LLM", 18],
  });
  const baseReceipt = await publicClient.waitForTransactionReceipt({ hash: baseHash });
  const baseTokenAddr = baseReceipt.contractAddress!;

  const quoteHash = await walletClient.deployContract({
    abi: loadArtifact("MockERC20").abi,
    bytecode: loadArtifact("MockERC20").bytecode as Hex,
    args: ["HKD", "HKD", 18],
  });
  const quoteReceipt = await publicClient.waitForTransactionReceipt({ hash: quoteHash });
  const quoteTokenAddr = quoteReceipt.contractAddress!;

  await walletClient.writeContract({
    address: baseTokenAddr,
    abi: mintABI,
    functionName: "mint",
    args: [ACCOUNT_0, 100000n * 10n ** 18n],
  });

  await walletClient.writeContract({
    address: quoteTokenAddr,
    abi: mintABI,
    functionName: "mint",
    args: [ACCOUNT_0, 10000000n * 10n ** 18n],
  });

  await walletClient.writeContract({
    address: baseTokenAddr,
    abi: approveABI,
    functionName: "approve",
    args: [oracleAddr, maxUint256],
  });
  await walletClient.writeContract({
    address: quoteTokenAddr,
    abi: approveABI,
    functionName: "approve",
    args: [oracleAddr, maxUint256],
  });
  await walletClient.writeContract({
    address: baseTokenAddr,
    abi: approveABI,
    functionName: "approve",
    args: [marketAddr, maxUint256],
  });
  await walletClient.writeContract({
    address: quoteTokenAddr,
    abi: approveABI,
    functionName: "approve",
    args: [marketAddr, maxUint256],
  });

  console.log(`Deployed MonoracleWindowed: ${oracleAddr}`);
  console.log(`Deployed IRMarket:         ${marketAddr}`);
  console.log(`Deployed BASE:             ${baseTokenAddr}`);
  console.log(`Deployed QUOTE:            ${quoteTokenAddr}`);

  return { oracle: oracleAddr, market: marketAddr, baseToken: baseTokenAddr, quoteToken: quoteTokenAddr };
}

export async function createMarket(deployed: DeployedContracts): Promise<string> {
  const transport = http("http://localhost:8545");
  const publicClient = createPublicClient({ chain: anvil, transport });
  const walletClient = createWalletClient({
    chain: anvil,
    transport,
    account: privateKeyToAccount(ACCOUNT_0_PK),
  });

  const currentBlock = await publicClient.getBlockNumber();
  const expiryBlock = currentBlock + 1000n;

  const txHash = await walletClient.writeContract({
    address: deployed.market,
    abi: irMarketABI,
    functionName: "createMarket",
    args: [
      deployed.baseToken,
      deployed.quoteToken,
      ACCOUNT_0,
      expiryBlock,
      100n,
    ],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: irMarketABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      }) as any;
      if (decoded.eventName === "MarketCreated") {
        return (decoded.args as any).marketId.toString();
      }
    } catch {
      // not our event
    }
  }

  return "1";
}

export async function seedQuote(params: {
  baseToken: Address;
  quoteToken: Address;
  oracle: Address;
  price: bigint;
  baseAmount: bigint;
  quoteAmount: bigint;
  expiryBlocks: number;
}): Promise<bigint> {
  const transport = http("http://localhost:8545");
  const publicClient = createPublicClient({ chain: anvil, transport });
  const walletClient = createWalletClient({
    chain: anvil,
    transport,
    account: privateKeyToAccount(ACCOUNT_0_PK),
  });

  const currentBlock = await publicClient.getBlockNumber();
  const expiryBlock = currentBlock + BigInt(params.expiryBlocks);

  const txHash = await walletClient.writeContract({
    address: params.oracle,
    abi: [submitQuoteFn],
    functionName: "submitQuote",
    args: [
      params.baseToken,
      params.quoteToken,
      params.baseAmount,
      params.quoteAmount,
      expiryBlock,
    ],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: oracleABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      }) as any;
      if (decoded.eventName === "QuoteSubmitted") {
        return (decoded.args as any).quoteId;
      }
    } catch {
      // not our event
    }
  }

  return 1n;
}
