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
import fs from "fs";
import path from "path";

const SHARED_DIR = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  ".."
);

function loadArtifact(name: string) {
  let artifactPath = path.join(
    SHARED_DIR,
    "artifacts",
    "contracts",
    `${name}.sol`,
    `${name}.json`
  );
  if (!fs.existsSync(artifactPath)) {
    artifactPath = path.join(
      SHARED_DIR,
      "artifacts",
      "contracts",
      "test",
      `${name}.sol`,
      `${name}.json`
    );
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
}

const BOT_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

const RPC = "http://localhost:8545";

const publicClient = createPublicClient({
  chain: anvil,
  transport: http(RPC),
});

const botWalletClient = createWalletClient({
  chain: anvil,
  transport: http(RPC),
  account: privateKeyToAccount(BOT_PK),
});

const oracleABI = loadArtifact("MonoracleMock").abi;
const irMarketABI = loadArtifact("IRMarket").abi;

export async function createMarketShortExpiry(
  market: Address,
  baseToken: Address,
  quoteToken: Address,
  marketMaker: Address,
  expiryBlocks: number,
  feeBps: number
): Promise<bigint> {
  const txHash = await botWalletClient.writeContract({
    address: market,
    abi: irMarketABI,
    functionName: "createMarket",
    args: [baseToken, quoteToken, marketMaker, BigInt(expiryBlocks), BigInt(feeBps)],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`createMarket failed: ${txHash}`);
  }

  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: irMarketABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      }) as any;
      if (decoded.eventName === "MarketCreated") {
        return (decoded.args as any).marketId;
      }
    } catch {
      // not our event
    }
  }

  throw new Error("MarketCreated event not found");
}

export async function getMarket(
  market: Address,
  marketId: bigint
): Promise<{
  baseToken: Address;
  quoteToken: Address;
  marketMaker: Address;
  feeBps: bigint;
  expiryBlock: bigint;
  createdAtBlock: bigint;
}> {
  return publicClient.readContract({
    address: market,
    abi: irMarketABI,
    functionName: "markets",
    args: [marketId],
  }) as Promise<{
    baseToken: Address;
    quoteToken: Address;
    marketMaker: Address;
    feeBps: bigint;
    expiryBlock: bigint;
    createdAtBlock: bigint;
  }>;
}