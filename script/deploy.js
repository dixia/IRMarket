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
  console.log("=== Deploy IRMarket to Monad Testnet ===\n");

  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const addr = await wallet.getAddress();

  console.log(`Deployer: ${addr}`);
  const balance = await provider.getBalance(addr);
  console.log(`Balance:  ${ethers.formatEther(balance)} MON`);

  if (balance < ethers.parseEther("0.01")) {
    console.error("ERROR: Insufficient MON balance for deployment.");
    process.exit(1);
  }

  console.log("\nEnsuring contracts are compiled...");
  const { execSync } = await import("child_process");
  execSync("npx hardhat compile", { cwd: rootDir, stdio: "pipe" });

  console.log("Deploying IRMarket...");
  const abi = getAbi("IRMarket");
  const factory = new ethers.ContractFactory(abi.abi, abi.bytecode, wallet);

  const deployTx = await factory.getDeployTransaction();
  const estimatedGas = await wallet.estimateGas(deployTx);
  const gasLimit = estimatedGas * 120n / 100n; // 20% buffer for Monad
  console.log(`Estimated gas: ${estimatedGas}, using limit: ${gasLimit}`);

  const market = await factory.deploy({ gasLimit });
  await market.waitForDeployment();

  console.log(`\nIRMarket deployed at: ${market.target}`);
  console.log(`Tx hash: ${market.deploymentTransaction().hash}`);

  const deployInfo = {
    network: "monad-testnet",
    chainId: CHAIN_ID,
    address: market.target,
    txHash: market.deploymentTransaction().hash,
    deployer: addr,
    timestamp: new Date().toISOString(),
  };
  const deployPath = path.join(rootDir, "deployment.json");
  fs.writeFileSync(deployPath, JSON.stringify(deployInfo, null, 2));
  console.log(`Saved to: ${deployPath}`);

  console.log(`\n=== Done ===`);
  console.log(`Explorer: https://testnet.monadscan.com/address/${market.target}`);
}

main().catch(e => {
  console.error("Deployment failed:", e.shortMessage || e.message);
  if (e.info) console.error("  Info:", JSON.stringify(e.info, null, 2));
  process.exit(1);
});