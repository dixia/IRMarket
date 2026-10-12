/**
 * vault-demo.js — scripted end-to-end walkthrough of the LP-pool MVP.
 *
 * LP deposit → publish + settle a Monoracle quote at S0 → open a LONG →
 * publish + settle a quote at S1 (higher) → settlePosition. Logs the trader PnL
 * and the LP equity delta, and asserts they match the plan §3.2 / spec §4.2 math:
 *   payout ∈ [0, 2N]   and   Δequity(pre-open → post-settle) == fee − pnl.
 *
 * Run:  npx hardhat run script/vault-demo.js
 * Exits 0 on success, 1 on any assertion failure.
 */
import assert from "node:assert/strict";
import hre from "hardhat";

const connection = await hre.network.create();
const { ethers } = connection;

const E18 = 10n ** 18n;
const LONG = 0;

async function mineBlocks(n) {
  for (let i = 0; i < n; i++) {
    await ethers.provider.send("evm_mine", []);
  }
}

function fmt(x) {
  // signed decimal display for 1e18 amounts
  const neg = x < 0n;
  const abs = neg ? -x : x;
  const whole = abs / E18;
  const frac = (abs % E18).toString().padStart(18, "0").replace(/0+$/, "") || "0";
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

async function main() {
  const [, lp, trader, provider] = await ethers.getSigners();

  // --- deploy stack ---------------------------------------------------------
  const Oracle = await ethers.getContractFactory("MonoracleMock");
  const oracle = await Oracle.deploy();
  const Token = await ethers.getContractFactory("MockERC20");
  const base = await Token.deploy("Liuliumei", "LLM", 18);
  const quote = await Token.deploy("HKD", "HKD", 18);
  const Vault = await ethers.getContractFactory("IRMarketVault");
  const feeBps = 100n; // 1%
  const vault = await Vault.deploy(oracle.target, base.target, quote.target, feeBps);

  await quote.mint(lp.address, 100_000n * E18);
  await quote.mint(trader.address, 100_000n * E18);
  await base.mint(provider.address, 100_000n * E18);
  await quote.mint(provider.address, 1_000_000n * E18);

  await quote.connect(lp).approve(vault.target, ethers.MaxUint256);
  await quote.connect(trader).approve(vault.target, ethers.MaxUint256);
  await base.connect(provider).approve(oracle.target, ethers.MaxUint256);
  await quote.connect(provider).approve(oracle.target, ethers.MaxUint256);

  // Publish a canonical price: submitQuote with baseAmount=1e18 so that
  // price == quoteAmount (WAD). Mine past the veto window, then settle.
  async function setPrice(priceWad) {
    const id = await oracle.nextQuoteId();
    const block = await ethers.provider.getBlockNumber();
    await oracle.connect(provider).submitQuote(base.target, quote.target, 1n * E18, priceWad, block + 10);
    await mineBlocks(11);
    await oracle.settleValidQuote(id);
  }

  console.log("=== IRMarketVault MVP demo ===\n");
  console.log(`Vault ${vault.target}  feeBps=${feeBps}`);

  // --- 1. LP deposit at S0 --------------------------------------------------
  const S0 = 100n * E18;
  await setPrice(S0);
  console.log(`\n[1] Publish canonical price S0 = ${fmt(S0)} HKD/LLM`);

  await vault.connect(lp).deposit(1000n * E18);
  const equityBeforeOpen = await vault.equity();
  console.log(`[2] LP deposits 1000 HKD → equity = ${fmt(equityBeforeOpen)}`);

  // --- 2. open LONG ---------------------------------------------------------
  const D = 100n * E18;
  const fee = (D * feeBps) / 10_000n; // 1 HKD
  const N = D - fee; // 99 HKD
  const maxPayout = (N * 20_000n) / 10_000n; // 2N = 198 HKD

  await vault.connect(trader).openPosition(LONG, D, 10n);
  const equityAfterOpen = await vault.equity();
  console.log(
    `[3] Trader opens LONG: D=${fmt(D)}, fee=${fmt(fee)}, N=${fmt(N)}, maxPayout=2N=${fmt(maxPayout)}`
  );
  console.log(`    equity dips to ${fmt(equityAfterOpen)}  (Δopen = D − 2N = ${fmt(equityAfterOpen - equityBeforeOpen)})`);
  assert.equal(equityAfterOpen, equityBeforeOpen + D - maxPayout, "open equity dip");
  assert.equal(equityAfterOpen, 902n * E18, "spec §6.5: LP1=1000, D=100 → equity 902");

  // --- 3. move price up, settle --------------------------------------------
  const S1 = 150n * E18;
  await setPrice(S1);
  console.log(`\n[4] Publish canonical price S1 = ${fmt(S1)} HKD/LLM`);

  const traderBefore = await quote.balanceOf(trader.address);
  const payout = await vault.connect(trader).settlePosition.staticCall(0);
  await vault.connect(trader).settlePosition(0);
  const equityAfterSettle = await vault.equity();

  const pnl = payout - N; // signed option P&L, ex-premium (spec §4.2)
  const traderPnl = payout - D; // net of premium paid
  const equityDelta = equityAfterSettle - equityBeforeOpen;

  console.log(`[5] settlePosition(0):`);
  console.log(`      settlePrice   = ${fmt(S1)}`);
  console.log(`      payout        = ${fmt(payout)}  (N + pnl = ${fmt(N + pnl)})`);
  console.log(`      trader PnL    = payout − D = ${fmt(traderPnl)}`);
  console.log(`      LP equity delta = ${fmt(equityDelta)}  (fee − pnl = ${fmt(fee - pnl)})`);
  console.log(`      LP equity now = ${fmt(equityAfterSettle)}`);

  // --- assertions: match plan §3.2 / spec §4.2 ------------------------------
  assert.equal(payout, 1485n * E18 / 10n, "LONG payout at S=1.5·S0 is N + 0.5N");
  assert.ok(payout >= 0n && payout <= 2n * N, "payout ∈ [0, 2N]");
  assert.equal(equityDelta, fee - pnl, "Δequity(pre-open → post-settle) == fee − pnl");
  assert.equal(await quote.balanceOf(trader.address), traderBefore + payout, "trader receives payout");
  assert.equal(await vault.pendingPayout(), 0n, "pendingPayout released");
  assert.equal(await vault.equity(), 9515n * E18 / 10n, "LP1 ends at 951.5 HKD");

  // --- bonus: LP exits ------------------------------------------------------
  const lpBefore = await quote.balanceOf(lp.address);
  const withdrawn = await vault.connect(lp).withdraw.staticCall(1000n * E18);
  await vault.connect(lp).withdraw(1000n * E18);
  console.log(`\n[6] LP withdraws 1000 shares → ${fmt(withdrawn)} HKD (LP P&L ${fmt(withdrawn - 1000n * E18)})`);
  assert.equal(await quote.balanceOf(lp.address), lpBefore + withdrawn, "LP receives withdrawal");
  assert.equal(await vault.balance(), 0n, "vault drained");
  assert.equal(await quote.balanceOf(vault.target), await vault.balance(), "vault token balance == cached balance");

  console.log("\n=== All assertions passed ===");
}

main()
  .then(async () => {
    await connection.close();
  })
  .catch(async (e) => {
    console.error("\nDemo failed:", e.message);
    try {
      await connection.close();
    } catch {}
    process.exitCode = 1;
  });
