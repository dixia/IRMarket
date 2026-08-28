import { test, expect } from "@playwright/test";
import { ETHEREUM_BRIDGE_SCRIPT } from "../helpers/ethereum-bridge";

test.describe("02 - Trade & Positions", () => {
  test("2.1 - Trade page shows market and active quote", async ({ page }) => {
    await page.addInitScript(ETHEREUM_BRIDGE_SCRIPT);
    await page.goto("/");

    await page.getByRole("button", { name: "Connect Wallet" }).click();
    await expect(page.getByText(/0xf39F.*2266/)).toBeVisible({ timeout: 10000 });

    await page.getByRole("link", { name: "Long" }).first().click();
    await expect(page.getByRole("heading", { name: "Trade panel" })).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole("heading", { name: "Liuliumei" })).toBeVisible();
    await expect(page.getByText("HKD/LLM")).toBeVisible({ timeout: 30000 });
    await expect(page.getByText("Confirm long position")).toBeVisible();
  });

  test("2.2 - Positions page starts empty", async ({ page }) => {
    await page.addInitScript(ETHEREUM_BRIDGE_SCRIPT);
    await page.goto("/positions");

    await page.getByRole("button", { name: "Connect Wallet" }).click();
    await expect(page.getByText(/0xf39F.*2266/)).toBeVisible({ timeout: 10000 });

    await expect(page.getByText("No positions yet")).toBeVisible({ timeout: 30000 });
  });
});
