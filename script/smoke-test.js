import "dotenv/config";
import { ethers } from "ethers";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

async function main() {
  console.log("=== IRMarket Smoke Test ===\n");

  const deployInfo = JSON.parse(
    (await import("fs")).readFileSync(path.join(rootDir, "deployment.json"), "utf8")
  );
  const marketAddress = deployInfo.address;
  console.log(`IRMarket: ${marketAddress}`);

  const provider = new ethers.JsonRpcProvider(
    process.env.RPC_URL || "https://testnet-rpc.monad.xyz",
    Number(process.env.CHAIN_ID || 10143)
  );

  const abi = JSON.parse(
    (await import("fs")).readFileSync(
      path.join(rootDir, "artifacts", "contracts", "IRMarket.sol", "IRMarket.json"),
      "utf8"
    )
  );
  const market = new ethers.Contract(marketAddress, abi.abi, provider);
  console.log(`version(): ${await market.version()}`);

  console.log("\n=== Done ===");
}

main().catch(e => { console.error("Smoke test failed:", e.shortMessage || e.message); process.exit(1); });