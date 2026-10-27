import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { blocksForSeconds, registryFile, resolveRegistryFile } from "./networks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) { console.error("Set PRIVATE_KEY env var"); process.exit(1); }
const RPC_URL = process.env.RPC_URL || "https://testnet-rpc.monad.xyz";
const CHAIN_ID = Number(process.env.CHAIN_ID || 10143);

const FEE_BPS = Number(process.env.FEE_BPS || 100);              // 1%
const EXPIRY_SECONDS = Number(process.env.EXPIRY_SECONDS || 3 * 60);
const MARKET_MAKER = process.env.MARKET_MAKER || "";

const depl = JSON.parse(fs.readFileSync(resolveRegistryFile(rootDir, "deployment", CHAIN_ID), "utf8"));
if (!depl.market) { console.error("deployment registry missing `market` — deploy first"); process.exit(1); }
if (depl.chainId !== undefined && Number(depl.chainId) !== CHAIN_ID) {
  console.error(`deployment registry is for chain ${depl.chainId}, not ${CHAIN_ID} — refusing to write a round into it`);
  process.exit(1);
}
const abi = JSON.parse(fs.readFileSync(
  path.join(rootDir, "artifacts", "contracts", "IRMarket.sol", "IRMarket.json"), "utf8")).abi;

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const addr = await wallet.getAddress();

  const marketC = new ethers.Contract(depl.market, abi, wallet);
  const base = depl.baseToken;
  const quote = depl.quoteToken;
  const mm = MARKET_MAKER || addr;
  const expiryBlock = BigInt(await provider.getBlockNumber()) + BigInt(blocksForSeconds(CHAIN_ID, EXPIRY_SECONDS));

  const raw = await provider.send("eth_getTransactionCount", [addr, "latest"]);
  const nonce = BigInt(raw);
  const tx = await marketC.createMarket(base, quote, mm, expiryBlock, BigInt(FEE_BPS), { nonce });
  await tx.wait();
  const receipt = await provider.getTransactionReceipt(tx.hash);
  const createdLog = receipt.logs
    .map(l => { try { return marketC.interface.parseLog(l); } catch { return null; } })
    .find(l => l && l.name === "MarketCreated");
  const marketId = createdLog ? createdLog.args.marketId : null;

  console.log(`createMarket -> marketId ${marketId ?? "?"}`);
  console.log(`  base=${base} quote=${quote} mm=${mm} feeBps=${FEE_BPS} expiryBlock=${expiryBlock} (~${EXPIRY_SECONDS}s)`);
  console.log(`  tx ${tx.hash}`);

  depl.marketId = marketId ? marketId.toString() : depl.marketId;
  depl.expiryBlock = expiryBlock.toString();
  depl.feeBps = FEE_BPS;
  depl.marketMaker = mm;
  depl.txHashes = depl.txHashes || {};
  depl.txHashes.createMarket = tx.hash;
  depl.timestamp = new Date().toISOString();
  fs.writeFileSync(path.join(rootDir, registryFile("deployment", CHAIN_ID)), JSON.stringify(depl, null, 2));
  console.log(`  ${registryFile("deployment", CHAIN_ID)} updated`);
}

main().catch(e => { console.error("Failed:", e.shortMessage || e.message); process.exit(1); });
