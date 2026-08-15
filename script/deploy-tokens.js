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

function getAbi(name) {
  const p = path.join(rootDir, "artifacts", "contracts", name + ".sol", name + ".json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function main() {
  console.log("=== Deploy Test ERC20 Tokens to Monad Testnet ===\n");

  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const addr = await wallet.getAddress();

  console.log(`Deployer: ${addr}`);
  const balance = await provider.getBalance(addr);
  console.log(`Balance:  ${ethers.formatEther(balance)} MON`);

  const mockAbi = getAbi("MockERC20");
  const factory = new ethers.ContractFactory(mockAbi.abi, mockAbi.bytecode, wallet);

  const baseToken = await factory.deploy("Test Base", "BASE", 18);
  await baseToken.waitForDeployment();
  console.log(`BASE:     ${baseToken.target}`);

  const quoteToken = await factory.deploy("Test Quote", "QUOTE", 18);
  await quoteToken.waitForDeployment();
  console.log(`QUOTE:    ${quoteToken.target}`);

  const mintBase = ethers.parseEther("100000");
  const mintQuote = ethers.parseEther("10000000");
  await (await baseToken.mint(addr, mintBase)).wait();
  await (await quoteToken.mint(addr, mintQuote)).wait();

  console.log(`\nMinted ${ethers.formatEther(mintBase)} BASE to ${addr}`);
  console.log(`Minted ${ethers.formatEther(mintQuote)} QUOTE to ${addr}`);

  console.log(`\n=== Token Deployments ===`);
  console.log(`BASE:  ${baseToken.target}`);
  console.log(`QUOTE: ${quoteToken.target}`);
}

main().catch(e => { console.error("Failed:", e.shortMessage || e.message); process.exit(1); });