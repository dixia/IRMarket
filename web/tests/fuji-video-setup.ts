/**
 * fuji-video-setup.ts — globalSetup for the Fuji video run.
 *
 * Unlike tests/setup.ts this does NOT start anvil or deploy contracts: the stack is already
 * live on Avalanche Fuji. It only writes web/.env.local from the chain-scoped registry and
 * then starts `next dev`, so the client bundle inlines the Fuji addresses.
 *
 * Required env: E2E_TESTNET_RPC, E2E_BURNER_KEY (see playwright.video.fuji.config.mts)
 * Optional env: E2E_CHAIN_ID (43113), E2E_ASSET (NVDA), E2E_REGISTRY_FILE, E2E_PORT,
 *               E2E_VAULT_ADDRESS, E2E_EXPLORER_BASE
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const WEB_DIR = path.resolve(import.meta.dirname!, "..");
const ROOT_DIR = path.resolve(WEB_DIR, "..");

const CHAIN_SLUGS: Record<number, string> = {
  10143: "monad-testnet",
  43113: "avalanche-fuji",
  31337: "anvil-local",
};

async function waitForServer(url: string, maxRetries = 120): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("next dev did not start within 120s");
}

export default async function fujiVideoSetup(): Promise<void> {
  const chainId = Number(process.env.E2E_CHAIN_ID ?? 43113);
  const slug = CHAIN_SLUGS[chainId] ?? `chain-${chainId}`;
  const rpc = process.env.E2E_TESTNET_RPC;
  if (!rpc) throw new Error("E2E_TESTNET_RPC is required");

  const registryPath = process.env.E2E_REGISTRY_FILE
    ? path.resolve(ROOT_DIR, process.env.E2E_REGISTRY_FILE)
    : path.join(ROOT_DIR, `deployment-assets.${slug}.json`);
  if (!fs.existsSync(registryPath)) {
    throw new Error(`Fuji registry not found at ${registryPath} — deploy the stack first`);
  }
  const reg = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  if (reg.chainId !== undefined && Number(reg.chainId) !== chainId) {
    throw new Error(`registry ${registryPath} is for chain ${reg.chainId}, not ${chainId}`);
  }

  const want = (process.env.E2E_ASSET ?? reg.assets?.[0]?.symbol ?? "NVDA").toUpperCase();
  const asset =
    (reg.assets ?? []).find((a: { symbol?: string }) => String(a.symbol).toUpperCase() === want) ??
    reg.assets?.[0];
  if (!asset?.baseToken) throw new Error(`registry ${registryPath} has no asset ${want}`);

  const vault = process.env.E2E_VAULT_ADDRESS ?? asset.vault ?? reg.assets?.[0]?.vault;
  const explorer =
    process.env.E2E_EXPLORER_BASE ??
    (chainId === 43113 ? "https://testnet.snowtrace.io" : "https://testnet.monadscan.com");

  const envContent = [
    `NEXT_PUBLIC_RPC_URL=${rpc}`,
    `NEXT_PUBLIC_CHAIN_ID=${chainId}`,
    `NEXT_PUBLIC_ORACLE_ADDRESS=${reg.oracle}`,
    `NEXT_PUBLIC_MARKET_ADDRESS=${reg.market}`,
    `NEXT_PUBLIC_BASE_TOKEN=${asset.baseToken}`,
    `NEXT_PUBLIC_QUOTE_TOKEN=${reg.quoteToken}`,
    `NEXT_PUBLIC_VAULT_ADDRESS=${vault}`,
    `NEXT_PUBLIC_EXPIRY_SECONDS=1800`,
    `NEXT_PUBLIC_EXPLORER_BASE=${explorer}`,
    `NEXT_PUBLIC_SELECTED_BASE_TOKENS=${asset.baseToken}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(WEB_DIR, ".env.local"), envContent);
  console.log(`[FujiVideoSetup] wrote .env.local for ${slug} (oracle ${reg.oracle})`);

  const port = Number(process.env.E2E_PORT ?? 3000);
  console.log(`[FujiVideoSetup] starting next dev on :${port}...`);
  const next = spawn("npx", ["next", "dev", "--port", String(port)], {
    cwd: WEB_DIR,
    shell: true,
    stdio: "pipe",
  });
  next.stdout?.on("data", (d: Buffer) => process.stdout.write(`[Next] ${d}`));
  next.stderr?.on("data", (d: Buffer) => process.stderr.write(`[Next] ${d}`));

  await waitForServer(`http://localhost:${port}`);
  console.log("[FujiVideoSetup] next dev ready.");
  (globalThis as { __nextProcess?: unknown }).__nextProcess = next;
}
