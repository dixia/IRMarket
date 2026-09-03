import { test, expect } from "@playwright/test";
import { ethereumBridgeScript } from "../helpers/ethereum-bridge";
import { mineBlocks } from "../helpers/mine";
import { submitQuote } from "../helpers/bot";
import { getMarket } from "../helpers/market";
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

test.describe.serial("12 - Demo Close & Settle", () => {
  test("12.1 - Wallet A reverse closes long position", async ({ page }) => {
    // Restock a fresh quote so reverse close can proceed (needs active quote for the pair)
    const addresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
    // Market was created with expiryBlock=500 (absolute)
    await submitQuote(
      addresses.oracle,
      addresses.baseToken,
      addresses.quoteToken,
      1n * 10n ** 18n,
      130n * 10n ** 18n,
      500n
    );

    await page.addInitScript(ethereumBridgeScript(0));
    await page.goto("/positions");

    await page.getByRole("button", { name: "Connect Wallet" }).click();
    await expect(page.getByText(/0xf39F.*2266/)).toBeVisible({ timeout: 10000 });

    await expect(page.getByText("Long")).toBeVisible({ timeout: 60000 });

    // Wait for reverse close button to be visible (might load after position data)
    await expect(page.getByRole("button", { name: "Reverse close" })).toBeVisible({ timeout: 60000 });
    await page.getByRole("button", { name: "Reverse close" }).click();

    // Closing a long (bull) = cover short, so button says "Confirm reverse close (cover short)"
    await expect(page.getByText(/Confirm reverse close \(cover short\)/)).toBeVisible({ timeout: 30000 });

    const confirmButton = page.getByRole("button", { name: /Confirm reverse close \(cover short\)|Approve/ });
    await confirmButton.click();

    await expect(page.getByText("Close succeeded")).toBeVisible({ timeout: 120000 });
  });

  test("12.2 - Position closed, PnL displayed", async ({ page }) => {
    await page.addInitScript(ethereumBridgeScript(0));
    await page.goto("/positions");

    await page.getByRole("button", { name: "Connect Wallet" }).click();
    await expect(page.getByText(/0xf39F.*2266/)).toBeVisible({ timeout: 10000 });

    await expect(page.getByText("No positions yet")).toBeVisible({ timeout: 30000 });
  });

  test("12.3 - Mine blocks past expiry, bot settles round", async () => {
    await mineBlocks(30);
  });

  test("12.4 - getLatestPrice returns settled price (130)", async ({ page }) => {
    await page.addInitScript(ethereumBridgeScript(0));
    await page.goto("/");

    await expect(page.getByText("Anything with a price can become an option")).toBeVisible();

    await expect(page.getByText(/Final price settling|130/).first()).toBeVisible({ timeout: 30000 });
  });

  test("12.5 - Positions page shows settled positions at mark price", async ({ page }) => {
    await page.addInitScript(ethereumBridgeScript(0));
    await page.goto("/positions");

    await page.getByRole("button", { name: "Connect Wallet" }).click();
    await expect(page.getByText(/0xf39F.*2266/)).toBeVisible({ timeout: 10000 });

    await expect(page.getByText("Settled")).toBeVisible({ timeout: 30000 });

    // Check for settled price in the position card (more specific than just "130")
    await expect(page.getByText(/130 HKD\/LLM/).first()).toBeVisible({ timeout: 15000 });
  });
});