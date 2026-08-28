import { type ChildProcess, spawn } from "child_process";
import fs from "fs";
import path from "path";

const ROOT_DIR = path.resolve(import.meta.dirname!, "..", "..");
const SHARED_DIR = path.resolve(ROOT_DIR, "..", "shared", "IRMarket");

let anvilProcess: ChildProcess | null = null;

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
  console.log("[Setup] Starting Anvil node via Foundry/WSL...");
  anvilProcess = spawn("wsl", ["/home/h4n/.foundry/bin/anvil", "--host", "0.0.0.0", "--port", "8545"], {
    stdio: "pipe",
    shell: true,
  });

  anvilProcess.stdout?.on("data", (d: Buffer) => process.stdout.write(`[Anvil] ${d}`));
  anvilProcess.stderr?.on("data", (d: Buffer) => process.stderr.write(`[Anvil] ${d}`));

  await waitForAnvil();
  console.log("[Setup] Anvil node is ready.");

  console.log("[Setup] Deploying contracts...");
  const { deployContracts, createMarket, seedQuote } = await import("./helpers/deploy.js");
  const deployed = await deployContracts();

  console.log("[Setup] Creating market...");
  const marketId = await createMarket(deployed);
  console.log(`[Setup] Created marketId=${marketId}`);

  console.log("[Setup] Seeding initial quote...");
  const quoteId = await seedQuote({
    baseToken: deployed.baseToken,
    quoteToken: deployed.quoteToken,
    oracle: deployed.oracle,
    price: 130n * 10n ** 18n,
    baseAmount: 1n * 10n ** 18n,
    quoteAmount: 130n * 10n ** 18n,
    expiryBlocks: 1000,
  });
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
    JSON.stringify({ ...deployed, marketId }, null, 2)
  );

  console.log(`[Setup] Wrote .env.local and addresses.json`);
  console.log(`  ORACLE:  ${deployed.oracle}`);
  console.log(`  MARKET:  ${deployed.market}`);
  console.log(`  BASE:    ${deployed.baseToken}`);
  console.log(`  QUOTE:   ${deployed.quoteToken}`);
  console.log(`  MARKETID: ${marketId}`);

  (globalThis as any).__anvilProcess = anvilProcess;
}
