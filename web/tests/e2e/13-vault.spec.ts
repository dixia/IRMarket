import { test, expect } from "@playwright/test";
import { ethereumBridgeScript } from "../helpers/ethereum-bridge";

// The vault page renders "Connect wallet" labels on the LP panel's action buttons when
// disconnected, so scope wallet-connection clicks to the AppShell header button.
test.describe.serial("13 - LP Vault", () => {
  test("13.1 - Vault page renders UI + canonical price", async ({ page }) => {
    await page.addInitScript(ethereumBridgeScript(0));
    await page.goto("/vault");

    await expect(page.getByText("Vault not configured")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "LP Vault" })).toBeVisible();

    await expect(page.getByRole("button", { name: "LP", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Trade", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Positions", exact: true })).toBeVisible();

    await expect(page.getByText("Canonical settlement price")).toBeVisible();
    await expect(page.getByText("Price unavailable")).toHaveCount(0);
    await expect(page.getByText(/130 HKD\/LLM/).first()).toBeVisible({ timeout: 30000 });
  });

  test("13.2 - Trade tab is live against the canonical price", async ({ page }) => {
    await page.addInitScript(ethereumBridgeScript(0));
    await page.goto("/vault");

    await page.locator("header").getByRole("button", { name: "Connect Wallet" }).click();
    await expect(page.getByText(/0xf39F.*2266/)).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: "Trade", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Trade" })).toBeVisible({ timeout: 30000 });

    await expect(page.getByText("Entry price")).toBeVisible();
    await page.locator('input[inputmode="decimal"]').first().fill("10");
    await page.locator('input[inputmode="numeric"]').fill("600");

    // Setup settled the canonical price, so the open button is live.
    await expect(page.getByRole("button", { name: "Waiting for a price" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open LONG" })).toBeVisible({ timeout: 15000 });
  });

  test("13.3 - LP deposit reaches a success state", async ({ page }) => {
    await page.addInitScript(ethereumBridgeScript(0));
    await page.goto("/vault");

    await page.locator("header").getByRole("button", { name: "Connect Wallet" }).click();
    await expect(page.getByText(/0xf39F.*2266/)).toBeVisible({ timeout: 10000 });

    await expect(page.getByRole("heading", { name: "Pool" })).toBeVisible({ timeout: 30000 });

    const amountInput = page.locator('input[inputmode="decimal"]').first();
    await amountInput.fill("100");

    const actionButton = page.getByRole("button", { name: /^(Approve|Deposit)$/ });
    await expect(actionButton).toBeVisible({ timeout: 15000 });
    await expect(actionButton).toBeEnabled({ timeout: 15000 });

    // Setup pre-approves the vault; if the allowance query hasn't resolved yet, click Approve first.
    if ((await actionButton.textContent())?.trim() === "Approve") {
      await actionButton.click();
      await expect(actionButton).toHaveText("Deposit", { timeout: 30000 });
    }

    await actionButton.click();
    await expect(page.getByText("Deposit confirmed")).toBeVisible({ timeout: 60000 });
  });
});
