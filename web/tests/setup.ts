import { type ChildProcess, spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { createPublicClient, http } from "viem";
import { anvil } from "viem/chains";

const ROOT_DIR = path.resolve(import.meta.dirname!, "..", "..");
const SHARED_DIR = path.resolve(ROOT_DIR, "..", "shared", "IRMarket");

let anvilProcess: ChildProcess | null = null;

const publicClient = createPublicClient({
  chain: anvil,
  transport: http("http://localhost:8545"),
});

function killExistingAnvil() {
  try {
    // Kill any existing anvil process on port 8545
    execSync("lsof -ti:8545 | xargs kill -9 2>/dev/null || true", { stdio: "ignore" });
    // Also kill any child processes from previous runs
    execSync("pkill -f 'anvil.*8545' 2>/dev/null || true", { stdio: "ignore" });
  } catch {
    // ignore
  }
}

async function waitForAnvil(maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch("http://localhost:8545", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        }),
      });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Anvil node did not start within 30 seconds");
}

export default async function globalSetup() {
  killExistingAnvil();
  
  console.log("[Setup] Starting Anvil node...");
  anvilProcess = spawn("anvil", ["--host", "0.0.0.0", "--port", "8545"], {
    stdio: "pipe",
  });

  anvilProcess.stdout?.on("data", (d: Buffer) => process.stdout.write(`[Anvil] ${d}`));
  anvilProcess.stderr?.on("data", (d: Buffer) => process.stderr.write(`[Anvil] ${d}`));

  await waitForAnvil();
  console.log("[Setup] Anvil node is ready.");

  console.log("[Setup] Deploying contracts...");
  const { deployContracts } = await import("./helpers/deploy.js");
  const deployed = await deployContracts();

  const EXPIRY_BLOCKS = 500;

  console.log("[Setup] Creating market with short expiry...");
  const { createMarketShortExpiry } = await import("./helpers/market.js");
  const marketId = await createMarketShortExpiry(
    deployed.market,
    deployed.baseToken,
    deployed.quoteToken,
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    EXPIRY_BLOCKS,
    100
  );
  console.log(`[Setup] Created marketId=${marketId} (expiry in ${EXPIRY_BLOCKS} blocks)`);

  console.log("[Setup] Seeding initial quote...");
  const { submitQuote: seedQuote } = await import("./helpers/bot.js");
  const currentBlock = await publicClient.getBlockNumber();
  const quoteId = await seedQuote(
    deployed.oracle,
    deployed.baseToken,
    deployed.quoteToken,
    1n * 10n ** 18n,
    130n * 10n ** 18n,
    currentBlock + BigInt(EXPIRY_BLOCKS)
  );
  console.log(`[Setup] Seeded quoteId=${quoteId}`);

  // Write .env.local
  const webDir = path.resolve(import.meta.dirname!, "..");
  const envPath = path.join(webDir, ".env.local");

  const envContent = [
    `NEXT_PUBLIC_RPC_URL=http://localhost:8545`,
    `NEXT_PUBLIC_CHAIN_ID=31337`,
    `NEXT_PUBLIC_ORACLE_ADDRESS=${deployed.oracle}`,
    `NEXT_PUBLIC_MARKET_ADDRESS=${deployed.market}`,
    `NEXT_PUBLIC_BASE_TOKEN=${deployed.baseToken}`,
    `NEXT_PUBLIC_QUOTE_TOKEN=${deployed.quoteToken}`,
    `NEXT_PUBLIC_EXPIRY_SECONDS=300`,
    "",
  ].join("\n");

  fs.writeFileSync(envPath, envContent);

  // Also write a JSON file for test imports (not env-dependent)
  fs.writeFileSync(
    path.join(webDir, "tests", "helpers", "addresses.json"),
    JSON.stringify({ ...deployed, marketId: marketId.toString() }, null, 2)
  );

  console.log(`[Setup] Wrote .env.local and addresses.json`);
  console.log(`  ORACLE:  ${deployed.oracle}`);
  console.log(`  MARKET:  ${deployed.market}`);
  console.log(`  BASE:    ${deployed.baseToken}`);
  console.log(`  QUOTE:   ${deployed.quoteToken}`);
  console.log(`  MARKETID: ${marketId}`);

  (globalThis as any).__anvilProcess = anvilProcess;
}