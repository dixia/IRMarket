import { test, expect } from "@playwright/test";
import { ethereumBridgeScript } from "../helpers/ethereum-bridge";
import { submitQuote } from "../helpers/bot";
import fs from "fs";
import path from "path";

const webDir = path.resolve(import.meta.dirname!, "..", "..");
const addressesPath = path.join(webDir, "tests", "helpers", "addresses.json");

function loadAddresses() {
  if (!fs.existsSync(addressesPath)) {
    throw new Error("addresses.json not found. Run setup first.");
  }
  return JSON.parse(fs.readFileSync(addressesPath, "utf8"));
}

const addresses = loadAddresses();
const MARKET_ID = addresses.marketId;
const BASE_TOKEN = addresses.baseToken;
const QUOTE_TOKEN = addresses.quoteToken;

test.describe.serial("10 - Demo Prep & Sanity", () => {
  test("10.1 - Home page shows market card with price ≈ 130 HKD", async ({ page }) => {
    await page.addInitScript(ethereumBridgeScript(0));
    await page.goto("/");

    await expect(page.getByText("Anything with a price can become an option")).toBeVisible();

    await expect(page.getByText(/LLM\/HKD/).first()).toBeVisible({ timeout: 15000 });

    const priceText = page.locator("text=/130/").first();
    await expect(priceText).toBeVisible({ timeout: 15000 });

    await expect(page.getByRole("link", { name: "Long" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Short" }).first()).toBeVisible();

    await expect(page.getByRole("button", { name: "Claim test tokens" }).first()).toBeVisible();
  });

  test("10.2 - Faucet mints LLM + HKD to wallet", async ({ page }) => {
    await page.addInitScript(ethereumBridgeScript(0));
    await page.goto("/");

    await page.getByRole("button", { name: "Connect Wallet" }).click();
    await expect(page.getByText(/0xf39F.*2266/)).toBeVisible({ timeout: 10000 });

    // Open faucet modal from header
    await page.getByRole("button", { name: "Claim test tokens" }).first().click();

    // Fill recipient address (modal defaults to connected address but may be empty initially)
    await page.locator('input[placeholder="0x…"]').fill("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");

    // Click claim button inside the modal (last one = modal button)
    await page.locator('button:has-text("Claim test tokens")').last().click();

    // Wait for modal to close and success
    await expect(page.getByText("Done ✓")).toBeVisible({ timeout: 30000 });

    await expect(page.getByText(/\d+ HKD/)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/\d+ LLM/)).toBeVisible({ timeout: 5000 });
  });

  test("10.3 - Trade page shows market stats (fee, countdown)", async ({ page }) => {
    await page.addInitScript(ethereumBridgeScript(0));
    await page.goto(`/trade?m=${MARKET_ID}&side=long`);

    await page.getByRole("button", { name: "Connect Wallet" }).click();
    await expect(page.getByText(/0xf39F.*2266/)).toBeVisible({ timeout: 10000 });

    await expect(page.getByText("Fee").first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("1%").first()).toBeVisible();

    await expect(page.getByText(/Current price/).first()).toBeVisible();
    await expect(page.getByText(/130/).first()).toBeVisible();

    await expect(page.getByRole("heading", { name: "Trade panel" })).toBeVisible();
  });
});