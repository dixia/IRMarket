/**
 * deploy-vault.js — local, in-process deployment of the LP-pool MVP stack.
 *
 * Deploys MockERC20 (base LLM + quote HKD), the MonoracleMock oracle and the
 * IRMarketVault, then mints/approves demo balances and reads `vault.equity()`.
 *
 * Run:  npx hardhat run script/deploy-vault.js
 *
 * This is the *local* (in-process Hardhat network) deploy path. It deliberately
 * does NOT touch `deployment.json` — that file belongs to `script/deploy.js`
 * (Monad testnet). No environment variables are required.
 */
import hre from "hardhat";

const connection = await hre.network.create();
const { ethers } = connection;

const E18 = 10n ** 18n;

async function main() {
  const [deployer, lp, trader, provider] = await ethers.getSigners();

  console.log("=== Deploy IRMarketVault MVP stack (local) ===\n");
  console.log(`Deployer: ${deployer.address}`);

  const Oracle = await ethers.getContractFactory("MonoracleMock");
  const oracle = await Oracle.deploy();

  const Token = await ethers.getContractFactory("MockERC20");
  const base = await Token.deploy("Liuliumei", "LLM", 18);
  const quote = await Token.deploy("HKD", "HKD", 18);

  const Vault = await ethers.getContractFactory("IRMarketVault");
  const feeBps = 100n; // 1%
  const vault = await Vault.deploy(oracle.target, base.target, quote.target, feeBps);

  console.log(`MonoracleMock : ${oracle.target}`);
  console.log(`PriceBase LLM : ${base.target}`);
  console.log(`Settlement HKD: ${quote.target}`);
  console.log(`IRMarketVault : ${vault.target} (feeBps=${feeBps})`);

  // Fund demo accounts and wire approvals.
  await quote.mint(lp.address, 100_000n * E18);
  await quote.mint(trader.address, 100_000n * E18);
  await base.mint(provider.address, 100_000n * E18);
  await quote.mint(provider.address, 1_000_000n * E18);

  await quote.connect(lp).approve(vault.target, ethers.MaxUint256);
  await quote.connect(trader).approve(vault.target, ethers.MaxUint256);
  await base.connect(provider).approve(oracle.target, ethers.MaxUint256);
  await quote.connect(provider).approve(oracle.target, ethers.MaxUint256);

  // Seed the pool so `equity()` is a meaningful (non-zero) number.
  await vault.connect(lp).deposit(1000n * E18);

  console.log("\nMinted + approved: 100k HKD (lp/trader), 100k LLM + 1M HKD (provider)");
  console.log(`LP seed deposit:   1000 HKD`);
  console.log(`\nvault.balance()      = ${(await vault.balance()) / E18} HKD`);
  console.log(`vault.pendingPayout()= ${(await vault.pendingPayout()) / E18} HKD`);
  console.log(`vault.equity()       = ${(await vault.equity()) / E18} HKD`);
  console.log("\n=== Done ===");
}

main()
  .then(async () => {
    await connection.close();
  })
  .catch(async (e) => {
    console.error("Deploy failed:", e.shortMessage || e.message);
    try {
      await connection.close();
    } catch {}
    process.exitCode = 1;
  });
