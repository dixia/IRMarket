import {
  createPublicClient,
  createWalletClient,
  http,
  decodeEventLog,
  type Address,
  type Hex,
  maxUint256,
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
const BOT_ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;

const TRADER2_PK =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const TRADER2_ACCOUNT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;

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

const trader2WalletClient = createWalletClient({
  chain: anvil,
  transport: http(RPC),
  account: privateKeyToAccount(TRADER2_PK),
});

const oracleABI = loadArtifact("MonoracleMock").abi;
const irMarketABI = loadArtifact("IRMarket").abi;

const submitQuoteFn = oracleABI.find((f: any) => f.name === "submitQuote") as any;
const settleValidQuoteFn = oracleABI.find((f: any) => f.name === "settleValidQuote") as any;
const withdrawProviderFundsFn = oracleABI.find((f: any) => f.name === "withdrawProviderFunds") as any;
const vetoUnderpricedFn = oracleABI.find((f: any) => f.name === "vetoUnderpriced") as any;
const vetoOverpricedFn = oracleABI.find((f: any) => f.name === "vetoOverpriced") as any;
const getLatestPriceFn = oracleABI.find((f: any) => f.name === "getLatestPrice") as any;
const nextQuoteIdFn = oracleABI.find((f: any) => f.name === "nextQuoteId") as any;
const quotesFn = oracleABI.find((f: any) => f.name === "quotes") as any;

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

const E18 = 10n ** 18n;

const ACTIVE = 0;
const VETOED_UNDERPRICED = 1;
const VETOED_OVERPRICED = 2;
const SETTLED_VALID = 3;
const SETTLED_WITHDRAWN = 4;

async function waitForReceipt(client: any, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`Tx failed: ${hash}`);
  }
  return receipt;
}

export interface QuoteData {
  provider: Address;
  baseToken: Address;
  quoteToken: Address;
  baseAmount: bigint;
  quoteAmount: bigint;
  price: bigint;
  startSlot: number;
  expiryBlock: bigint;
  settledSlot: number;
  status: number;
}

export async function submitQuote(
  oracle: Address,
  baseToken: Address,
  quoteToken: Address,
  baseAmount: bigint,
  quoteAmount: bigint,
  expiryBlock: bigint,
  walletClient = botWalletClient
): Promise<bigint> {
  const txHash = await walletClient.writeContract({
    address: oracle,
    abi: [submitQuoteFn],
    functionName: "submitQuote",
    args: [baseToken, quoteToken, baseAmount, quoteAmount, expiryBlock],
  });

  const receipt = await waitForReceipt(walletClient, txHash);

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

  const nextId = await publicClient.readContract({
    address: oracle,
    abi: oracleABI,
    functionName: "nextQuoteId",
  }) as bigint;
  return nextId - 1n;
}

export async function settleQuote(
  oracle: Address,
  quoteId: bigint,
  walletClient = botWalletClient
): Promise<void> {
  const txHash = await walletClient.writeContract({
    address: oracle,
    abi: [settleValidQuoteFn],
    functionName: "settleValidQuote",
    args: [quoteId],
  });
  await waitForReceipt(walletClient, txHash);
}

export async function withdrawFunds(
  oracle: Address,
  quoteId: bigint,
  walletClient = botWalletClient
): Promise<void> {
  const txHash = await walletClient.writeContract({
    address: oracle,
    abi: [withdrawProviderFundsFn],
    functionName: "withdrawProviderFunds",
    args: [quoteId],
  });
  await waitForReceipt(walletClient, txHash);
}

export async function restockQuote(
  oracle: Address,
  baseToken: Address,
  quoteToken: Address,
  baseAmount: bigint,
  quoteAmount: bigint,
  expiryBlock: bigint,
  walletClient = botWalletClient
): Promise<bigint> {
  return submitQuote(oracle, baseToken, quoteToken, baseAmount, quoteAmount, expiryBlock, walletClient);
}

export async function getActiveQuote(
  oracle: Address,
  baseToken: Address,
  quoteToken: Address,
  roundExpiryBlock: bigint
): Promise<QuoteData | null> {
  const nextId = await publicClient.readContract({
    address: oracle,
    abi: oracleABI,
    functionName: "nextQuoteId",
  }) as bigint;

  for (let qid = nextId - 1n; qid > 0n; qid--) {
    const q = await publicClient.readContract({
      address: oracle,
      abi: oracleABI,
      functionName: "quotes",
      args: [qid],
    }) as QuoteData;

    if (
      q.provider.toLowerCase() === BOT_ACCOUNT.toLowerCase() &&
      q.baseToken.toLowerCase() === baseToken.toLowerCase() &&
      q.quoteToken.toLowerCase() === quoteToken.toLowerCase() &&
      q.expiryBlock === roundExpiryBlock &&
      q.status === ACTIVE
    ) {
      return q;
    }
  }
  return null;
}

export async function getQuote(oracle: Address, quoteId: bigint): Promise<QuoteData> {
  return publicClient.readContract({
    address: oracle,
    abi: oracleABI,
    functionName: "quotes",
    args: [quoteId],
  }) as Promise<QuoteData>;
}

export async function getLatestPrice(
  oracle: Address,
  baseToken: Address,
  quoteToken: Address
): Promise<{ price: bigint; settledSlot: number; exists: boolean }> {
  return publicClient.readContract({
    address: oracle,
    abi: [getLatestPriceFn],
    functionName: "getLatestPrice",
    args: [baseToken, quoteToken],
  }) as Promise<{ price: bigint; settledSlot: number; exists: boolean }>;
}

export async function ensureBotApprovals(
  oracle: Address,
  baseToken: Address,
  quoteToken: Address
): Promise<void> {
  for (const token of [baseToken, quoteToken]) {
    const allowance = await publicClient.readContract({
      address: token,
      abi: approveABI,
      functionName: "allowance",
      args: [BOT_ACCOUNT, oracle],
    }) as bigint;

    if (allowance < maxUint256 / 2n) {
      const txHash = await botWalletClient.writeContract({
        address: token,
        abi: approveABI,
        functionName: "approve",
        args: [oracle, maxUint256],
      });
      await waitForReceipt(botWalletClient, txHash);
    }
  }
}

export async function mintToTrader2(
  baseToken: Address,
  quoteToken: Address
): Promise<void> {
  const mintAmount = 2000n * E18;
  for (const token of [baseToken, quoteToken]) {
    const txHash = await botWalletClient.writeContract({
      address: token,
      abi: mintABI,
      functionName: "mint",
      args: [TRADER2_ACCOUNT, mintAmount],
    });
    await waitForReceipt(botWalletClient, txHash);
  }
}

export async function approveForTrader2(
  oracle: Address,
  market: Address,
  baseToken: Address,
  quoteToken: Address
): Promise<void> {
  for (const [token, spender] of [
    [baseToken, oracle],
    [quoteToken, oracle],
    [baseToken, market],
    [quoteToken, market],
  ] as const) {
    const txHash = await trader2WalletClient.writeContract({
      address: token,
      abi: approveABI,
      functionName: "approve",
      args: [spender, maxUint256],
    });
    await waitForReceipt(trader2WalletClient, txHash);
  }
}

export async function vetoUnderpricedDirect(
  oracle: Address,
  quoteId: bigint,
  walletClient = trader2WalletClient
): Promise<void> {
  const txHash = await walletClient.writeContract({
    address: oracle,
    abi: [vetoUnderpricedFn],
    functionName: "vetoUnderpriced",
    args: [quoteId],
  });
  await waitForReceipt(walletClient, txHash);
}

export async function vetoOverpricedDirect(
  oracle: Address,
  quoteId: bigint,
  walletClient = botWalletClient
): Promise<void> {
  const txHash = await walletClient.writeContract({
    address: oracle,
    abi: [vetoOverpricedFn],
    functionName: "vetoOverpriced",
    args: [quoteId],
  });
  await waitForReceipt(walletClient, txHash);
}

export { BOT_ACCOUNT, TRADER2_ACCOUNT, BOT_PK, TRADER2_PK, botWalletClient, trader2WalletClient };