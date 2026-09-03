import { defineConfig } from "@playwright/test";
import path from "path";

const WEB_DIR = path.resolve(import.meta.dirname!);

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
      executablePath: "/usr/bin/chromium",
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