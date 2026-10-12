import { defineConfig } from "@playwright/test";
import fs from "fs";
import path from "path";

const WEB_DIR = path.resolve(import.meta.dirname!);

// Windows: system Edge (`channel: "msedge"`). WSL/Linux: prefer a system chromium when
// present; otherwise let Playwright use its bundled browser (`npx playwright install
// chromium`). A hardcoded executablePath would fail on machines without a system install.
const SYSTEM_CHROMIUM = "/usr/bin/chromium";

const launchOptions =
  process.platform === "win32"
    ? { channel: "msedge" as const }
    : fs.existsSync(SYSTEM_CHROMIUM)
      ? { executablePath: SYSTEM_CHROMIUM }
      : {};

export default defineConfig({
  testDir: path.join(WEB_DIR, "tests", "e2e"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120000,
  expect: { timeout: 30000 },

  globalSetup: path.join(WEB_DIR, "tests", "setup.ts"),

  use: {
    baseURL: "http://localhost:3000",
    headless: true,
    launchOptions: {
      ...launchOptions,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    },
  },

  webServer: {
    command: "npx next dev --port 3000",
    cwd: WEB_DIR,
    port: 3000,
    reuseExistingServer: false,
    timeout: 120000,
  },
});