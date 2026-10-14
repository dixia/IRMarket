import { defineConfig } from "@playwright/test";
import path from "path";

const WEB_DIR = path.resolve(import.meta.dirname!);

// Video config that assumes the stack is already deployed (playwright.setup.config.mts)
// and the dev server is already running with the correct .env.local.
export default defineConfig({
  testDir: path.join(WEB_DIR, "tests", "video"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300000,
  expect: { timeout: 30000 },

  use: {
    baseURL: "http://localhost:3000",
    headless: true,
    video: { mode: "on", size: { width: 1280, height: 800 } },
    launchOptions: {
      channel: "msedge",
      slowMo: 300,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    },
  },

  webServer: {
    command: "npx next dev --port 3000",
    cwd: WEB_DIR,
    port: 3000,
    reuseExistingServer: true,
    timeout: 120000,
  },
});
