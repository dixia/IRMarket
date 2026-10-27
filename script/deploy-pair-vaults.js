/**
 * deploy-pair-vaults.js — one LP vault per pair, via IRMarketVaultFactory, seeded.
 *
 * The factory is the dedup point (one vault per (base, quote), LP-D12) and the
 * way a pair gets an LP page without an operator deploy. This script is the ops
 * side of that: for every asset in the registry it
 *
 *   1. asks `factory.vaultFor(base, quote)` — creates the vault if absent,
 *   2. mints the quote token to the deployer when the balance is short
 *      (MockERC20.testnet mint is public), approves the vault and deposits the
 *      seed:
 *         SEED_USD (default 1,000,000) for quote token symbol "USD"
 *         SEED_HKD (default 7,000,000) for quote token symbol "HKD"
 *   3. writes `deployment-vaults.json` (pair -> vault, seed, tx hashes).
 *
 * Usage:
 *   $env:ORACLE_ADDRESS="0x0BC3…"        # optional; defaults to the registry's
 *   $env:FACTORY_ADDRESS="0x…"           # REQUIRED
 *   $env:PRIVATE_KEY="0x…"
 *   node script/deploy-pair-vaults.js [--dry-run]
 *
 *   SEED_USD=0 SEED_HKD=0 node script/deploy-pair-vaults.js   # create only
 */
import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chainInfo, resolveRegistryFile } from "./networks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const DRY_RUN = process.argv.includes("--dry-run");
const RPC_URL = process.env.RPC_URL || "https://testnet-rpc.monad.xyz";
const CHAIN_ID = Number(process.env.CHAIN_ID || 10143);
const FEE_BPS = BigInt(process.env.FEE_BPS || "100");
const SEEDS = {
  USD: process.env.SEED_USD || "1000000",
  HKD: process.env.SEED_HKD || "7000000",
};

const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS;
if (!FACTORY_ADDRESS) {
  console.error("Set FACTORY_ADDRESS — the factory is the only way to create a pair's vault.");
  process.exit(1);
}
if (!process.env.PRIVATE_KEY && !DRY_RUN) {
  console.error("Set PRIVATE_KEY (or pass --dry-run).");
  process.exit(1);
}

const loadArtifact = (rel) => JSON.parse(fs.readFileSync(path.join(rootDir, "artifacts", "contracts", rel), "utf8"));

async function main() {
  const registryPath = process.env.ASSETS_FILE
    ? path.join(rootDir, process.env.ASSETS_FILE)
    : resolveRegistryFile(rootDir, "assets", CHAIN_ID);
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const oracleAddr = process.env.ORACLE_ADDRESS || registry.oracle;
  if (!oracleAddr) throw new Error("no oracle in the registry and ORACLE_ADDRESS is unset");

  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const factoryArtifact = loadArtifact("IRMarketVaultFactory.sol/IRMarketVaultFactory.json");
  const vaultArtifact = loadArtifact("IRMarketVault.sol/IRMarketVault.json");
  const tokenArtifact = loadArtifact("MockERC20.sol/MockERC20.json");

  const wallet = DRY_RUN ? null : new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const factory = new ethers.Contract(FACTORY_ADDRESS, factoryArtifact.abi, wallet || provider);
  const factoryOracle = await factory.oracle();
  if (factoryOracle.toLowerCase() !== ethers.getAddress(oracleAddr).toLowerCase()) {
    throw new Error(`factory oracle ${factoryOracle} != ${oracleAddr}`);
  }

  console.log(`factory ${FACTORY_ADDRESS} (oracle ${factoryOracle})`);
  console.log(`seeds: ${SEEDS.USD} per USD pair, ${SEEDS.HKD} per HKD pair\n`);

  const out = { network: chainInfo(CHAIN_ID).slug, chainId: CHAIN_ID, factory: FACTORY_ADDRESS, oracle: factoryOracle, vaults: {} };

  for (const asset of registry.assets) {
    const base = asset.baseToken;
    const quote = asset.quoteToken;
    const symbol = `${asset.symbol}/${asset.quoteSymbol || "?"}`;
    let vaultAddr = await factory.vaultFor(base, quote);
    console.log(`[${symbol}] vault ${vaultAddr === ethers.ZeroAddress ? "ABSENT → create" : vaultAddr}`);
    if (DRY_RUN) {
      out.vaults[asset.symbol] = { vault: vaultAddr === ethers.ZeroAddress ? null : vaultAddr, base, quote, dryRun: true };
      continue;
    }
    let txHashes = {};
    if (vaultAddr === ethers.ZeroAddress) {
      const tx = await factory.createVault(base, quote, FEE_BPS);
      console.log(`  createVault: ${tx.hash}`);
      const rc = await tx.wait();
      txHashes.create = rc.hash;
      vaultAddr = await factory.vaultFor(base, quote);
      console.log(`  → ${vaultAddr}`);
    }
    const vault = new ethers.Contract(vaultAddr, vaultArtifact.abi, wallet);
    const vaultOracle = await vault.oracle();
    if (vaultOracle.toLowerCase() !== ethers.getAddress(factoryOracle).toLowerCase()) {
      throw new Error(`${symbol}: vault oracle ${vaultOracle} != factory oracle`);
    }

    const seedUnits = SEEDS[(asset.quoteSymbol || "").toUpperCase()] || "0";
    const seed = ethers.parseEther(String(seedUnits));
    if (seed > 0n) {
      const token = new ethers.Contract(quote, tokenArtifact.abi, wallet);
      const bal = await token.balanceOf(wallet.address);
      if (bal < seed) {
        const tx = await token.mint(wallet.address, seed - bal);
        console.log(`  mint ${ethers.formatEther(seed - bal)} ${asset.quoteSymbol}: ${tx.hash}`);
        await tx.wait();
      }
      const allowance = await token.allowance(wallet.address, vaultAddr);
      if (allowance < seed) {
        const tx = await token.approve(vaultAddr, seed);
        console.log(`  approve ${asset.quoteSymbol} → vault: ${tx.hash}`);
        await tx.wait();
      }
      const tx = await vault.deposit(seed);
      console.log(`  deposit ${ethers.formatEther(seed)} ${asset.quoteSymbol}: ${tx.hash}`);
      await tx.wait();
      txHashes.deposit = tx.hash;
      console.log(`  LP equity now ${ethers.formatEther(await vault.equity())} ${asset.quoteSymbol}`);
    }
    out.vaults[asset.symbol] = {
      vault: vaultAddr,
      base,
      quote,
      quoteSymbol: asset.quoteSymbol,
      seed: seed.toString(),
      txHashes,
    };
  }

  if (!DRY_RUN) {
    const file = resolveRegistryFile(rootDir, "vaults", CHAIN_ID);
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`\n=== wrote ${path.basename(file)} (${Object.keys(out.vaults).length} pair vaults) ===`);
  } else {
    console.log("\nDRY RUN — no transactions sent.");
  }
}

main().catch((e) => {
  console.error("deploy-pair-vaults failed:", e.shortMessage || e.message);
  process.exit(1);
});
