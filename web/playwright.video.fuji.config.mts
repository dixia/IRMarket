/**
 * playwright.video.fuji.config.mts — record the user-flow walkthrough against the LIVE
 * Avalanche Fuji deployment (no anvil, no local contract deploy).
 *
 * globalSetup (tests/fuji-video-setup.ts) writes web/.env.local from
 * deployment-assets.avalanche-fuji.json and starts `next dev`. The spec then wires an
 * injected burner wallet and records the walkthrough.
 *
 * Required env (never committed):
 *   E2E_TESTNET_RPC   Fuji RPC the page reads through
 *   E2E_BURNER_KEY    burner private key (Node side only; never injected into the page)
 *
 * Optional env:
 *   E2E_CHAIN_ID=43113, E2E_ASSET=NVDA, E2E_PORT=3000,
 *   E2E_REGISTRY_FILE, E2E_VAULT_ADDRESS, E2E_TENOR_BLOCKS=300
 *
 * Run:
 *   cd web
 *   $env:E2E_TESTNET_RPC="https://api.avax-test.network/ext/bc/C/rpc"
 *   $env:E2E_BURNER_KEY="0x..."
 *   npx playwright test --config playwright.video.fuji.config.mts
 */
import { defineConfig } from "@playwright/test";
import path from "path";

const WEB_DIR = path.resolve(import.meta.dirname!);
const PORT = Number(process.env.E2E_PORT ?? 3000);

if (!process.env.E2E_TESTNET_RPC) {
  console.error("E2E_TESTNET_RPC is required (the Fuji RPC the page reads through)");
  process.exit(1);
}
if (!process.env.E2E_BURNER_KEY) {
  console.error("E2E_BURNER_KEY is required (burner private key; never committed)");
  process.exit(1);
}

export default defineConfig({
  testDir: path.join(WEB_DIR, "tests", "video"),
  testMatch: /fuji-user-flow\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Live chain: every action waits for a receipt and quote windows are measured in blocks.
  timeout: 600_000,
  expect: { timeout: 60_000 },

  globalSetup: path.join(WEB_DIR, "tests", "fuji-video-setup.ts"),

  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    video: { mode: "on", size: { width: 1280, height: 800 } },
    launchOptions: {
      channel: "msedge",
      slowMo: 300,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    },
    trace: "retain-on-failure",
  },
});
