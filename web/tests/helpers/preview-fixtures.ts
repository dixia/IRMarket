/**
 * preview-fixtures.ts — self-sufficient setup for preview.spec.ts.
 *
 * The browser side of the preview run can only trade against quotes that already exist
 * on-chain, and the vault page can only price against a SETTLED canonical quote. Rather
 * than depending on the stage bot's round timing, the burner wallet prepares its own
 * fixtures Node-side (all viem, all real testnet txs):
 *
 *   ensureOracleApprovals()   approve max for base + quote   (gas 60k — the app's limit)
 *   submitQuote(...)          escrow base+quote, ACTIVE      (gas 400k — the bot's limit)
 *   settleValidQuote(qid)     canonical price for the vault  (gas 100k)
 *
 * Addresses/prices come from the STAGE registry (deployment-assets.json in the stage
 * worktree root), which is by construction the same stack the preview env points at.
 */
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi, type Chain, type Hex } from "viem";
import { signTransaction } from "viem/actions";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import fs from "fs";
import path from "path";

const E18 = 10n ** 18n;

/** Mirrors script/networks.js — keeps the fixture loader chain-aware. */
const CHAIN_SLUGS: Record<number, string> = {
  10143: "monad-testnet",
  43113: "avalanche-fuji",
  31337: "anvil-local",
};
function chainSlug(chainId: number): string {
  return CHAIN_SLUGS[chainId] ?? `chain-${chainId}`;
}

/** Upstream (A) oracle shape — the A-shape gate's `submitQuote(...uint32)` signature. */
export const ORACLE_ABI = parseAbi([
  "function submitQuote(address baseToken, address quoteToken, uint256 baseAmount, uint256 quoteAmount, uint32 expiryBlock) returns (uint256)",
  "function settleValidQuote(uint256 quoteId)",
  "function getLatestPrice(address baseToken, address quoteToken) view returns (uint256 price, uint32 settledSlot, bool exists)",
  "function nextQuoteId() view returns (uint256)",
  "function quotes(uint256) view returns ((address provider, address baseToken, address quoteToken, uint256 baseAmount, uint256 quoteAmount, uint256 price, uint32 startSlot, uint32 expiryBlock, uint32 settledSlot, uint8 status))",
]);
export const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

/** Gas limits — mirror of web/src/lib/config.ts + bot GAS table, so the fixtures bill
 *  exactly what production bills. If a fixture reverts here, the real UI would too. */
export const FIXTURE_GAS = {
  approve: 60_000n,
  submitQuote: 400_000n,
  settle: 100_000n,
} as const;

export interface StageStack {
  oracle: Hex;
  market: Hex;
  vault: Hex;
  quoteToken: Hex;
  baseToken: Hex;
  symbol: string;
  fairPrice: bigint;
  marketId: bigint;
  registryPath: string;
}

/**
 * Reads the stage registry. `dir` defaults to the stage worktree root (one level above
 * web/), which is where deploy-market-stack.js writes it. E2E_MARKET_ID / E2E_ASSET can
 * override the asset selection.
 */
export function loadStageStack(webDir: string, opts?: { dir?: string; asset?: string; chainId?: number }): StageStack {
  const root = opts?.dir ?? path.resolve(webDir, "..");
  const chainId = opts?.chainId ?? Number(process.env.E2E_CHAIN_ID ?? 10143);
  const preferred = path.join(root, `deployment-assets.${chainSlug(chainId)}.json`);
  const legacy = path.join(root, "deployment-assets.json");
  const registryPath = fs.existsSync(preferred) ? preferred : legacy;
  if (!fs.existsSync(registryPath)) {
    throw new Error(
      `stage registry not found at ${preferred} (or ${legacy}) — run deploy-market-stack.js first`,
    );
  }
  const reg = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  if (reg.chainId !== undefined && Number(reg.chainId) !== chainId) {
    throw new Error(`registry ${registryPath} is for chain ${reg.chainId}, not ${chainId}`);
  }
  if (!reg.oracle || !reg.market || !reg.quoteToken || !Array.isArray(reg.assets) || reg.assets.length === 0) {
    throw new Error(`stage registry at ${registryPath} is missing oracle/market/quoteToken/assets`);
  }
  const want = (opts?.asset ?? process.env.E2E_ASSET ?? reg.assets[0].symbol ?? "NVDA").toUpperCase();
  const asset = reg.assets.find((a: { symbol?: string }) => String(a.symbol).toUpperCase() === want) ?? reg.assets[0];
  const stack: StageStack = {
    oracle: reg.oracle as Hex,
    market: reg.market as Hex,
    vault: (process.env.E2E_VAULT_ADDRESS ?? reg.assets[0].vault) as Hex,
    quoteToken: reg.quoteToken as Hex,
    baseToken: asset.baseToken as Hex,
    symbol: String(asset.symbol ?? want),
    fairPrice: BigInt(asset.fairPrice ?? 0n),
    marketId: BigInt(process.env.E2E_MARKET_ID ?? asset.marketId ?? 0n),
    registryPath,
  };
  if (!stack.marketId || stack.marketId === 0n) {
    throw new Error(`stage registry asset ${stack.symbol} has no marketId — the stage bot must have rolled one`);
  }
  return stack;
}

export interface BurnerClients {
  account: ReturnType<typeof privateKeyToAccount>;
  wallet: ReturnType<typeof createWalletClient>;
  publicClient: ReturnType<typeof createPublicClient>;
  stack: StageStack;
  /** Burns 1 quote of collateral per submit: 1 base + fairPrice quote. */
  sendTx: (call: { to: Hex; data: Hex; gas: bigint }) => Promise<Hex>;
}

export function makeBurnerClients(opts: { rpc: string; key: `0x${string}`; stack: StageStack; chain?: Chain }): BurnerClients {
  const chain = opts.chain ?? monadTestnet;
  const account = privateKeyToAccount(opts.key);
  const wallet = createWalletClient({ account, chain, transport: http(opts.rpc) });
  const publicClient = createPublicClient({ chain, transport: http(opts.rpc) });

  const sendTx: BurnerClients["sendTx"] = async (call) => {
    const gasPrice = await publicClient.getGasPrice();
    let nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const raw = await signTransaction(wallet, {
          to: call.to,
          data: call.data,
          gas: call.gas,
          gasPrice,
          nonce,
          value: 0n,
          type: "legacy",
        });
        const hash = await publicClient.sendRawTransaction({ serializedTransaction: raw });
        // Wait for inclusion. Without this, consecutive fixture calls reuse a nonce (the
        // count is read before the previous tx mines) and a public-RPC mempool rejects the
        // second with "replacement transaction underpriced".
        await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
        return hash;
      } catch (e) {
        const msg = String(e).toLowerCase();
        if (msg.includes("nonce") || msg.includes("replacement") || msg.includes("already known")) {
          nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
          continue;
        }
        throw e;
      }
    }
    throw new Error("sendTx: nonce retries exhausted");
  };

  return { account, wallet, publicClient, stack: opts.stack, sendTx };
}

async function ensureApproval(c: BurnerClients, token: Hex, spender: Hex): Promise<void> {
  const data = encodeApprove(spender);
  await c.sendTx({ to: token, data, gas: FIXTURE_GAS.approve });
}

function encodeApprove(spender: Hex): Hex {
  return encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender, 2n ** 256n - 1n] });
}

/**
 * Approves the ORACLE for both legs (max). Idempotent-ish: always sends, because the
 * approval costs 60k and the fixtures run once per suite.
 */
export async function ensureOracleApprovals(c: BurnerClients): Promise<void> {
  await ensureApproval(c, c.stack.baseToken, c.stack.oracle);
  await ensureApproval(c, c.stack.quoteToken, c.stack.oracle);
}

/**
 * Submits one ACTIVE quote at `priceMultiple` of the configured fair price.
 * Multiple > 1 → "overpriced" (a SHORT would take it); < 1 → "underpriced". The labels
 * are only semantic: the oracle executes either veto against ANY active quote, so the
 * fixtures deliberately post BOTH so the browser flow is deterministic.
 *
 * @returns the quoteId (== nextQuoteId before the submit, ids start at 1)
 */
export async function submitQuote(c: BurnerClients, opts: { priceMultiple: bigint; expiryBlocks: number }): Promise<bigint> {
  const { baseToken, quoteToken, fairPrice, oracle } = c.stack;
  const baseAmount = 1n * E18;
  const quoteAmount = (baseAmount * fairPrice * opts.priceMultiple) / E18;
  const head = await c.publicClient.getBlockNumber();
  const nextId = (await c.publicClient.readContract({
    address: oracle,
    abi: ORACLE_ABI,
    functionName: "nextQuoteId",
  })) as bigint;
  const expiry = head + BigInt(opts.expiryBlocks);
  if (expiry > head + 12_000n) throw new Error("expiry beyond the oracle's MAX_VERIFICATION_SLOTS");
  const data = encodeFunctionData({
    abi: ORACLE_ABI,
    functionName: "submitQuote",
    args: [baseToken, quoteToken, baseAmount, quoteAmount, Number(expiry)],
  });
  await c.sendTx({ to: oracle, data, gas: FIXTURE_GAS.submitQuote });
  return nextId;
}

/** Submits one ACTIVE quote at an ABSOLUTE price (1e18 fixed), returns the quoteId. */
export async function submitQuoteAtPrice(c: BurnerClients, opts: { price: bigint; expiryBlocks: number }): Promise<bigint> {
  const { baseToken, quoteToken, oracle } = c.stack;
  const baseAmount = 1n * E18;
  const quoteAmount = (baseAmount * opts.price) / E18;
  const head = await c.publicClient.getBlockNumber();
  const nextId = (await c.publicClient.readContract({
    address: oracle,
    abi: ORACLE_ABI,
    functionName: "nextQuoteId",
  })) as bigint;
  const expiry = head + BigInt(opts.expiryBlocks);
  if (expiry > head + 12_000n) throw new Error("expiry beyond the oracle's MAX_VERIFICATION_SLOTS");
  const data = encodeFunctionData({
    abi: ORACLE_ABI,
    functionName: "submitQuote",
    args: [baseToken, quoteToken, baseAmount, quoteAmount, Number(expiry)],
  });
  await c.sendTx({ to: oracle, data, gas: FIXTURE_GAS.submitQuote });
  return nextId;
}

/** Waits until `quoteId` is past expiry, then settles it (leaves it as the canonical mark). */
export async function settleAfterExpiry(c: BurnerClients, quoteId: bigint, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const head = await c.publicClient.getBlockNumber();
    const q = (await c.publicClient.readContract({
      address: c.stack.oracle,
      abi: ORACLE_ABI,
      functionName: "quotes",
      args: [quoteId],
    })) as { expiryBlock: number; status: number };
    if (q.status !== 0) return; // already settled/vetoed by someone else
    if (BigInt(head) > BigInt(q.expiryBlock)) {
      await c.sendTx({ to: c.stack.oracle, data: encodeSettle(quoteId), gas: FIXTURE_GAS.settle });
      return;
    }
    if (Date.now() > deadline) throw new Error("settleAfterExpiry: timed out waiting for quote expiry");
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

/** `getLatestPrice` for the stage pair — the vault prices against this. */
export async function getCanonicalPrice(c: BurnerClients): Promise<{ price: bigint; exists: boolean }> {
  const res = (await c.publicClient.readContract({
    address: c.stack.oracle,
    abi: ORACLE_ABI,
    functionName: "getLatestPrice",
    args: [c.stack.baseToken, c.stack.quoteToken],
  })) as readonly [bigint, number, boolean];
  return { price: res[0], exists: Boolean(res[2]) };
}

/**
 * Makes sure the vault has a canonical price: if `getLatestPrice` exists, no-op; else
 * submit a short-expiry quote and settle it once it expires. Keeps the preview run
 * independent of the stage bot's round timing.
 */
export async function ensureCanonicalPrice(c: BurnerClients, opts?: { expiryBlocks?: number }): Promise<void> {
  const existing = await getCanonicalPrice(c);
  if (existing.exists && existing.price > 0n) return;
  const expiryBlocks = opts?.expiryBlocks ?? 60; // ~20 s on testnet
  const qid = await submitQuote(c, { priceMultiple: 1n, expiryBlocks });
  const deadline = Date.now() + 120_000;
  for (;;) {
    const head = await c.publicClient.getBlockNumber();
    const q = (await c.publicClient.readContract({
      address: c.stack.oracle,
      abi: ORACLE_ABI,
      functionName: "quotes",
      args: [qid],
    })) as { expiryBlock: number; status: number };
    if (q.status !== 0) break; // already settled/vetoed by someone
    if (BigInt(head) > BigInt(q.expiryBlock)) {
      await c.sendTx({ to: c.stack.oracle, data: encodeSettle(qid), gas: FIXTURE_GAS.settle });
      break;
    }
    if (Date.now() > deadline) throw new Error("ensureCanonicalPrice: timed out waiting for quote expiry");
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

function encodeSettle(quoteId: bigint): Hex {
  return encodeFunctionData({ abi: ORACLE_ABI, functionName: "settleValidQuote", args: [quoteId] });
}
