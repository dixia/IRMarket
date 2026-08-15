import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) { console.error("Set PRIVATE_KEY env var"); process.exit(1); }
const RPC_URL = process.env.RPC_URL || "https://testnet-rpc.monad.xyz";
const CHAIN_ID = Number(process.env.CHAIN_ID || 10143);

// Demo constants (aligned with sc-tech-spec §8.3 / web/.env.local)
const BASE_SYMBOL = process.env.BASE_SYMBOL || "LLM";   // Liuliumei
const BASE_NAME = process.env.BASE_NAME || "Liuliumei";
const QUOTE_SYMBOL = process.env.QUOTE_SYMBOL || "HKD";
const QUOTE_NAME = process.env.QUOTE_NAME || "HKD";
const DECIMALS = 18;
const FEE_BPS = Number(process.env.FEE_BPS || 100);      // 1%
const EXPIRY_SECONDS = Number(process.env.EXPIRY_SECONDS || 3 * 60); // 3-min demo round

function getAbi(name) {
  const p = path.join(rootDir, "artifacts", "contracts", name + ".sol", name + ".json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function main() {
  console.log("=== Deploy IRMarket V0.9 stack to Monad Testnet ===\n");

  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const addr = await wallet.getAddress();

  console.log(`Deployer: ${addr}`);
  const balance = await provider.getBalance(addr);
  console.log(`Balance:  ${ethers.formatEther(balance)} MON`);

  if (balance < ethers.parseEther("0.02")) {
    console.error("ERROR: Insufficient MON balance for deployment.");
    process.exit(1);
  }

  console.log("\nEnsuring contracts are compiled...");
  const { execSync } = await import("child_process");
  execSync("npx hardhat compile", { cwd: rootDir, stdio: "pipe" });

  async function deploy(name, args = []) {
    const abi = getAbi(name);
    const factory = new ethers.ContractFactory(abi.abi, abi.bytecode, wallet);
    const deployTx = await factory.getDeployTransaction(...args);
    const estimatedGas = await wallet.estimateGas(deployTx);
    const gasLimit = estimatedGas * 120n / 100n; // 20% buffer for Monad
    // Use a raw RPC nonce query: ethers' JsonRpcProvider caches the tx count and would
    // reuse a stale nonce for sequential deploys on an auto-mining chain.
    const rawNonce = await provider.send("eth_getTransactionCount", [addr, "latest"]);
    const nonce = BigInt(rawNonce);
    console.log(`  ${name}: estimated gas ${estimatedGas}, limit ${gasLimit}, nonce ${nonce}`);
    const tx = await wallet.sendTransaction({ ...deployTx, gasLimit, nonce });
    const receipt = await tx.wait();
    const target = receipt.contractAddress;
    console.log(`  ${name} -> ${target} (tx ${tx.hash})`);
    return {
      target,
      txHash: tx.hash,
      abi: abi.abi,
    };
  }

  // 1. MonoracleWindowed — the trading venue / price source (per-quote expiry window, D-13)
  console.log("\n[1/4] Deploying MonoracleWindowed (oracle fork)...");
  const oracle = await deploy("MonoracleWindowed");

  // 2. IRMarket(oracle) — thin factory + fee wrapper
  console.log("\n[2/4] Deploying IRMarket(oracle)...");
  const market = await deploy("IRMarket", [oracle.target]);

  // 3. MockERC20 LLM + HKD
  console.log("\n[3/4] Deploying LLM/HKD mock tokens...");
  const base = await deploy("MockERC20", [BASE_NAME, BASE_SYMBOL, DECIMALS]);
  const quote = await deploy("MockERC20", [QUOTE_NAME, QUOTE_SYMBOL, DECIMALS]);

  const mintBase = ethers.parseEther("100000");
  const mintQuote = ethers.parseEther("10000000");
  const baseC = new ethers.Contract(base.target, base.abi, wallet);
  const quoteC = new ethers.Contract(quote.target, quote.abi, wallet);

  // Same cached-nonce workaround: pass explicit raw nonce per call.
  async function sendCall(txPromise, label) {
    const raw = await provider.send("eth_getTransactionCount", [addr, "latest"]);
    const nonce = BigInt(raw);
    const tx = await txPromise({ nonce });
    await tx.wait();
    console.log(`  ${label} (nonce ${nonce})`);
    return tx;
  }

  await sendCall(
    o => baseC.mint(addr, mintBase, o),
    `minted ${ethers.formatEther(mintBase)} ${BASE_SYMBOL} to deployer`
  );
  await sendCall(
    o => quoteC.mint(addr, mintQuote, o),
    `minted ${ethers.formatEther(mintQuote)} ${QUOTE_SYMBOL} to deployer`
  );

  // 4. createMarket (D-07/D-14) — marketMaker = deployer (bot will set its own if needed)
  console.log("\n[4/4] createMarket...");
  const expiryBlock = BigInt(await provider.getBlockNumber()) + BigInt(Math.floor(EXPIRY_SECONDS / 0.3)); // ~300ms blocks
  console.log(`  expiryBlock ${expiryBlock} (~${EXPIRY_SECONDS}s from now)`);
  const marketC = new ethers.Contract(market.target, market.abi, wallet);
  const created = await sendCall(
    o => marketC.createMarket(base.target, quote.target, addr, expiryBlock, BigInt(FEE_BPS), o),
    `createMarket feeBps=${FEE_BPS}`
  );
  const receipt = await created.wait();
  const createdLog = receipt.logs
    .map(l => {
      try { return marketC.interface.parseLog(l); } catch { return null; }
    })
    .find(l => l && l.name === "MarketCreated");
  const marketId = createdLog ? createdLog.args.marketId : 1n;
  console.log(`  MarketCreated marketId=${marketId} feeBps=${FEE_BPS}`);

  const deployInfo = {
    network: "monad-testnet",
    chainId: CHAIN_ID,
    deployer: addr,
    oracle: oracle.target,
    market: market.target,
    baseToken: base.target,
    quoteToken: quote.target,
    marketId: marketId.toString(),
    feeBps: FEE_BPS,
    expiryBlock: expiryBlock.toString(),
    txHashes: {
      oracle: oracle.txHash,
      market: market.txHash,
      baseToken: base.txHash,
      quoteToken: quote.txHash,
      createMarket: created.hash,
    },
    timestamp: new Date().toISOString(),
  };
  const deployPath = path.join(rootDir, "deployment.json");
  fs.writeFileSync(deployPath, JSON.stringify(deployInfo, null, 2));
  console.log(`\nSaved to: ${deployPath}`);

  console.log(`\n=== Done ===`);
  console.log(`Explorer: https://testnet.monadscan.com/address/${market.target}`);
  console.log(`\nAddresses to wire into .env / bot/.env / web/.env.local:`);
  console.log(`  ORACLE_ADDRESS=${oracle.target}`);
  console.log(`  MARKET_ADDRESS=${market.target}`);
  console.log(`  BASE_TOKEN=${base.target}`);
  console.log(`  QUOTE_TOKEN=${quote.target}`);
  console.log(`  DEMO_MARKET_ID=${marketId.toString()}`);
}

main().catch(e => {
  console.error("Deployment failed:", e.shortMessage || e.message);
  if (e.info) console.error("  Info:", JSON.stringify(e.info, null, 2));
  process.exit(1);
});
