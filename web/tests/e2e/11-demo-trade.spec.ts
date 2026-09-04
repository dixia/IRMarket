import { test, expect } from "@playwright/test";
import { ethereumBridgeScript } from "../helpers/ethereum-bridge";
import { submitQuote, mintToTrader2, approveForTrader2 } from "../helpers/bot";
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

test.describe.serial("11 - Demo Trade: Open Long & Short", () => {
  test("11.1 - Wallet A opens long via wrapper", async ({ page }) => {
    await page.addInitScript(ethereumBridgeScript(0));
    await page.goto(`/trade?m=${MARKET_ID}&side=long`);

    await page.getByRole("button", { name: "Connect Wallet" }).click();
    await expect(page.getByText(/0xf39F.*2266/)).toBeVisible({ timeout: 10000 });

    await expect(page.getByRole("button", { name: "Long", exact: true })).toBeVisible();

    const confirmButton = page.getByRole("button", { name: /Confirm long position|Approve/ });
    await expect(confirmButton).toBeVisible({ timeout: 15000 });

    await confirmButton.click();

    await expect(page.getByText("Position opened")).toBeVisible({ timeout: 60000 });

    // Restock a fresh quote after veto so subsequent trades can proceed
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
  });

  test("11.2 - Long position appears on positions page", async ({ page }) => {
    await page.addInitScript(ethereumBridgeScript(0));
    await page.goto("/positions");

    await page.getByRole("button", { name: "Connect Wallet" }).click();
    await expect(page.getByText(/0xf39F.*2266/)).toBeVisible({ timeout: 10000 });

    await expect(page.getByText("Long")).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/130 HKD\/LLM/)).toBeVisible();
    await expect(page.getByText(/#1/)).toBeVisible();

    // Restock a fresh quote after long position so short trade can proceed
    const addresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
    await submitQuote(
      addresses.oracle,
      addresses.baseToken,
      addresses.quoteToken,
      1n * 10n ** 18n,
      130n * 10n ** 18n,
      500n
    );
  });

  test("11.3 - Wallet B opens short via wrapper (different browser context)", async ({ browser }) => {
    const addresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
    await mintToTrader2(addresses.baseToken, addresses.quoteToken);
    await approveForTrader2(
      addresses.oracle,
      addresses.marketAddress || addresses.market,
      addresses.baseToken,
      addresses.quoteToken
    );

    const context = await browser.newContext();
    const page = await context.newPage();

    await page.addInitScript(ethereumBridgeScript(1));
    await page.goto(`/trade?m=${MARKET_ID}&side=short`);

    await page.getByRole("button", { name: "Connect Wallet" }).click();
    await expect(page.getByText(/0x7099.*79C8/)).toBeVisible({ timeout: 10000 });

    await expect(page.getByRole("button", { name: "Short", exact: true })).toBeVisible({ timeout: 30000 });

    await submitQuote(
      addresses.oracle,
      addresses.baseToken,
      addresses.quoteToken,
      1n * 10n ** 18n,
      130n * 10n ** 18n,
      500n
    );

    const tradeButton = page.getByRole("button", { name: /Confirm short position|Approve/ });
    await expect(tradeButton).toBeVisible({ timeout: 30000 });
    await expect(tradeButton).toBeEnabled({ timeout: 60000 });

    const initialLabel = await tradeButton.textContent();

    if (initialLabel?.includes("Approve")) {
      await tradeButton.click();

      let attempts = 0;
      while (attempts < 12) {
        await page.waitForTimeout(2000);
        attempts++;
        const label = await tradeButton.textContent();
        if (label?.includes("Confirm short position")) break;

        const hasError = await page.getByText(/error|failed|revert/i).isVisible({ timeout: 500 }).catch(() => false);
        if (hasError) {
          await page.getByText(/error|failed|revert/i).first().textContent();
        }
      }

      const afterApproveLabel = await tradeButton.textContent();

      if (afterApproveLabel?.includes("Confirm short position")) {
        await tradeButton.click();
      }
    } else if (initialLabel?.includes("Confirm short position")) {
      await tradeButton.click();
    }

    await expect(page.getByText("Position opened")).toBeVisible({ timeout: 180000 });

    await context.close();
  });

  test("11.4 - Short position appears on positions page for Wallet B", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.addInitScript(ethereumBridgeScript(1));
    await page.goto("/positions");

    await page.getByRole("button", { name: "Connect Wallet" }).click();
    await expect(page.getByText(/0x7099.*79C8/)).toBeVisible({ timeout: 10000 });

    // Wait for positions to load: the Open tab count updates once usePositions fetches data.
    await expect(page.getByRole("button", { name: /Open \(1\)/ })).toBeVisible({ timeout: 30000 });

    const shortCard = page.locator('.rounded-xl.border.border-card-border').filter({ hasText: /Short/ });
    await expect(shortCard).toBeVisible();
    await expect(shortCard.getByText("130", { exact: true })).toBeVisible();

    await context.close();
  });
});
