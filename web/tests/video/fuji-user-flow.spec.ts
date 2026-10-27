/**
 * fuji-user-flow.spec.ts — records the LP-vault walkthrough against the LIVE Avalanche Fuji
 * stack (chain 43113). The local sibling (user-flow.spec.ts) runs on anvil; this one talks
 * to the deployed contracts and uses the injected testnet bridge for signing.
 *
 * State the spec prepares Node-side (real Fuji txs):
 *   - oracle approvals for the burner
 *   - a fresh market round (so the Market tab shows an active NVDA round)
 *   - a settled canonical price (the vault cannot open a position without one)
 *   - a +30% settled price move, to show PnL turn positive
 */
import { test, expect, type Page } from "@playwright/test";
import path from "path";
import { avalancheFuji } from "viem/chains";
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { wireTestnetWallet } from "../helpers/testnet-bridge";
import {
  makeBurnerClients,
  loadStageStack,
  ensureOracleApprovals,
  ensureCanonicalPrice,
  getCanonicalPrice,
  submitQuoteAtPrice,
  settleAfterExpiry,
} from "../helpers/preview-fixtures";

const WEB_DIR = path.resolve(import.meta.dirname!, "..", "..");
const RPC = process.env.E2E_TESTNET_RPC as string;
const KEY = process.env.E2E_BURNER_KEY as Hex;
const CHAIN_ID = Number(process.env.E2E_CHAIN_ID ?? 43113);
const TENOR_BLOCKS = Number(process.env.E2E_TENOR_BLOCKS ?? 300); // ~10 min on Fuji
const PRICE_EXPIRY_BLOCKS = Number(process.env.E2E_PRICE_EXPIRY_BLOCKS ?? 15); // ~30 s
const E18 = 10n ** 18n;

const stack = loadStageStack(WEB_DIR, { chainId: CHAIN_ID, asset: process.env.E2E_ASSET ?? "NVDA" });
const burner = makeBurnerClients({ rpc: RPC, key: KEY, stack, chain: avalancheFuji });

const WRAPPER_ABI = parseAbi([
  "function createMarket(address baseToken, address quoteToken, address marketMaker, uint256 expiryBlock, uint256 feeBps) returns (uint256)",
]);

async function rollRound(): Promise<void> {
  const head = await burner.publicClient.getBlockNumber();
  const expiry = head + BigInt(Number(process.env.E2E_ROUND_BLOCKS ?? 900)); // ~30 min
  const data = encodeFunctionData({
    abi: WRAPPER_ABI,
    functionName: "createMarket",
    args: [stack.baseToken, stack.quoteToken, burner.account.address, expiry, 100n],
  });
  await burner.sendTx({ to: stack.market, data, gas: 2_000_000n });
}

function wire(page: Page): Promise<void> {
  return wireTestnetWallet(page, { rpc: RPC, key: KEY, chain: avalancheFuji, chainId: CHAIN_ID });
}

async function ensureConnected(page: Page): Promise<void> {
  const connect = page.locator("header").getByRole("button", { name: "Connect Wallet" });
  if ((await connect.count()) > 0) await connect.click();
  await expect(page.getByText(new RegExp(burner.account.address.slice(0, 6)))).toBeVisible({ timeout: 30_000 });
}

test.describe.serial(`LP Vault user flow on Avalanche Fuji (${stack.symbol})`, () => {
  test.beforeAll(async () => {
    await ensureOracleApprovals(burner);
    await rollRound();
    await ensureCanonicalPrice(burner, { expiryBlocks: PRICE_EXPIRY_BLOCKS });
  });

  test("walkthrough", async ({ page }) => {
    await wire(page);

    await test.step("1. Home · connect wallet · claim test tokens", async () => {
      await page.goto("/");
      await expect(page.getByText("Anything with a price can become an option")).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(1200);

      await ensureConnected(page);
      await page.waitForTimeout(800);

      await page.getByRole("button", { name: "Claim test tokens" }).first().click();
      await page.locator('input[placeholder="0x…"]').fill(burner.account.address);
      await page.locator('button:has-text("Claim test tokens")').last().click();
      await expect(page.getByText("Done ✓")).toBeVisible({ timeout: 180_000 });
      await page.waitForTimeout(1500);
    });

    await test.step("2. Vault · LP deposit", async () => {
      await page.goto("/vault");
      await expect(page.getByRole("heading", { name: "LP Vault" })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText("Canonical settlement price")).toBeVisible();
      await page.waitForTimeout(1200);

      await ensureConnected(page);
      await page.getByRole("button", { name: "LP", exact: true }).click();
      await page.locator('input[inputmode="decimal"]').first().fill("100");
      await page.waitForTimeout(600);

      const action = page.getByRole("button", { name: /^(Approve|Deposit)$/ });
      await expect(action).toBeEnabled({ timeout: 30_000 });
      if ((await action.textContent())?.trim() === "Approve") {
        await action.click();
        await expect(action).toHaveText("Deposit", { timeout: 180_000 });
      }
      await action.click();
      await expect(page.getByText("Deposit confirmed")).toBeVisible({ timeout: 180_000 });
      await page.waitForTimeout(1500);
    });

    await test.step("3. Vault · open LONG", async () => {
      await page.getByRole("button", { name: "Trade", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Trade" })).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(800);

      await page.locator('input[inputmode="decimal"]').first().fill("10");
      await page.locator('input[inputmode="numeric"]').fill(String(TENOR_BLOCKS));
      await page.waitForTimeout(1000);

      const open = page.getByRole("button", { name: "Open LONG" });
      await expect(open).toBeEnabled({ timeout: 30_000 });
      await open.click();
      await expect(page.getByText("Position opened")).toBeVisible({ timeout: 180_000 });
      await page.waitForTimeout(1500);
    });

    await test.step("4. Vault · position + estimated PnL", async () => {
      await page.getByRole("button", { name: "Positions", exact: true }).click();
      await expect(page.getByText("Open PnL").first()).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText("Estimated PnL").first()).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(2000);
    });

    await test.step("5. Price moves up → PnL turns positive", async () => {
      // Publish +30% relative to the current canonical price and settle it, so the move is
      // meaningful even if a previous run left a different mark.
      const before = await getCanonicalPrice(burner);
      const target = before.price > 0n ? (before.price * 13n) / 10n : 300n * E18;
      const qid = await submitQuoteAtPrice(burner, { price: target, expiryBlocks: PRICE_EXPIRY_BLOCKS });
      await settleAfterExpiry(burner, qid);
      await page.waitForTimeout(1000);

      await page.reload();
      await ensureConnected(page);
      await page.getByRole("button", { name: "Positions", exact: true }).click();
      await expect(page.getByText("Estimated PnL").first()).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(/\+[1-9]/).first()).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(2500);
    });

    await test.step("6. Market tab — fresh NVDA round", async () => {
      await page.goto("/");
      await expect(page.getByRole("link", { name: "Long" }).first()).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(2500);
      await page.screenshot({ path: "test-results/fuji-market-tab.png", fullPage: true });
      await page.waitForTimeout(6000);
    });
  });
});
