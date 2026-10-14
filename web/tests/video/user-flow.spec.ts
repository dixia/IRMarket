import { test, expect } from "@playwright/test";
import { createPublicClient, http } from "viem";
import { anvil } from "viem/chains";
import { ethereumBridgeScript } from "../helpers/ethereum-bridge";
import { submitQuote, settleQuote, ensureBotApprovals } from "../helpers/bot";
import { mineBlocks } from "../helpers/mine";
import fs from "fs";
import path from "path";

const webDir = path.resolve(import.meta.dirname!, "..", "..");
const addresses = JSON.parse(
  fs.readFileSync(path.join(webDir, "tests", "helpers", "addresses.json"), "utf8"),
);

const ACCOUNT_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const E18 = 10n ** 18n;
const publicClient = createPublicClient({ chain: anvil, transport: http("http://127.0.0.1:8545") });

test.describe.serial("LP Vault user flow (video)", () => {
  test("walkthrough", async ({ page }) => {
    await page.addInitScript(ethereumBridgeScript(0));

    await test.step("1. Home · connect wallet · claim test tokens", async () => {
      await page.goto("/");
      await expect(page.getByText("Anything with a price can become an option")).toBeVisible();
      await page.waitForTimeout(1200);

      await page.getByRole("button", { name: "Connect Wallet" }).click();
      await expect(page.getByText(/0xf39F.*2266/)).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(800);

      await page.getByRole("button", { name: "Claim test tokens" }).first().click();
      await page.locator('input[placeholder="0x…"]').fill(ACCOUNT_0);
      await page.locator('button:has-text("Claim test tokens")').last().click();
      await expect(page.getByText("Done ✓")).toBeVisible({ timeout: 30000 });
      await page.waitForTimeout(1500);
    });

    await test.step("2. Vault · LP deposit", async () => {
      await page.goto("/vault");
      await expect(page.getByRole("heading", { name: "LP Vault" })).toBeVisible({ timeout: 30000 });
      await expect(page.getByText("Canonical settlement price")).toBeVisible();
      await page.waitForTimeout(1200);

      const diag = await page.evaluate(async (vault) => {
        const post = async (method: string, params: unknown[]) => {
          const r = await fetch("http://127.0.0.1:8545", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          });
          return r.json();
        };
        const code = await post("eth_getCode", [vault, "latest"]);
        const pb = await post("eth_call", [{ to: vault, data: "0x7310561b" }, "latest"]);
        const st = await post("eth_call", [{ to: vault, data: "0x7b9e618d" }, "latest"]);
        return {
          ethChainId: (window as unknown as { ethereum?: { chainId?: string } }).ethereum?.chainId,
          code: String(code.result || "").slice(0, 12),
          priceBase: pb.result,
          settlementToken: st.result,
        };
      }, addresses.vault);
      // Sanity: the vault must exist and expose the single-asset getters before trading.
      expect(diag.code).toMatch(/0x60806040/);
      expect(diag.ethChainId).toBe("0x7A69");

      await page.getByRole("button", { name: "LP", exact: true }).click();
      const amount = page.locator('input[inputmode="decimal"]').first();
      await amount.fill("100");
      await page.waitForTimeout(600);

      const action = page.getByRole("button", { name: /^(Approve|Deposit)$/ });
      await expect(action).toBeEnabled({ timeout: 15000 });
      if ((await action.textContent())?.trim() === "Approve") {
        await action.click();
        await expect(action).toHaveText("Deposit", { timeout: 30000 });
      }
      await action.click();
      await expect(page.getByText("Deposit confirmed")).toBeVisible({ timeout: 60000 });
      await page.waitForTimeout(1500);
    });

    await test.step("3. Vault · open LONG", async () => {
      await page.getByRole("button", { name: "Trade", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Trade" })).toBeVisible({ timeout: 30000 });
      await page.waitForTimeout(800);

      await page.locator('input[inputmode="decimal"]').first().fill("10");
      await page.locator('input[inputmode="numeric"]').fill("600");
      await page.waitForTimeout(1000);

      const open = page.getByRole("button", { name: "Open LONG" });
      await expect(open).toBeEnabled({ timeout: 15000 });
      await open.click();
      await expect(page.getByText("Position opened")).toBeVisible({ timeout: 60000 });
      await page.waitForTimeout(1500);
    });

    await test.step("4. Vault · position + estimated PnL", async () => {
      await page.getByRole("button", { name: "Positions", exact: true }).click();
      await expect(page.getByText("Open PnL").first()).toBeVisible({ timeout: 30000 });
      await expect(page.getByText("Estimated PnL").first()).toBeVisible({ timeout: 30000 });
      await page.waitForTimeout(2000);
    });

    await test.step("5. Price moves up → PnL turns positive", async () => {
      // Setup already approves ACCOUNT_0 → oracle for both tokens, so publish directly.
      const bn = await publicClient.getBlockNumber();
      const id = await submitQuote(
        addresses.oracle,
        addresses.baseToken,
        addresses.quoteToken,
        1n * E18,
        150n * E18,
        bn + 5n,
      );
      await mineBlocks(6);
      await settleQuote(addresses.oracle, id);
      await page.waitForTimeout(500);

      await page.reload();
      await page.getByRole("button", { name: "Positions", exact: true }).click();
      await expect(page.getByText("Open PnL").first()).toBeVisible({ timeout: 30000 });
      await expect(page.getByText(/\+1\.\d/).first()).toBeVisible({ timeout: 30000 });
      await page.waitForTimeout(2500);
    });

    await test.step("6. V0.9 Market tab (event-derived positions)", async () => {
      await page.goto("/");
      await expect(page.getByText(/HKD/).first()).toBeVisible({ timeout: 30000 });
      await page.waitForTimeout(2000);
    });
  });
});
