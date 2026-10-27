/**
 * deploy-vault-factory.js — deploy (or reuse) the per-pair LP vault factory on a chain.
 *
 * The factory is the directory every pair's vault hangs off (IRMarketVaultFactory,
 * LP-D12: one vault per (base, quote)). It binds the consumed Monoracle at
 * construction, so re-pointing the oracle means deploying a new factory — never
 * editing ABIs. This script therefore:
 *
 *   1. reuses the registry's factory when `factory.oracle()` is the oracle this run
 *      targets (and `MAX_FEE_BPS()` still reads the expected 1_000),
 *   2. otherwise deploys a fresh IRMarketVaultFactory(oracle),
 *   3. records it in deployment-factory.<chain>.json + the chain's deployment /
 *      deployment-assets registries, so the web (`NEXT_PUBLIC_FACTORY_ADDRESS`) and
 *      `deploy-pair-vaults.js` can read it instead of taking an address by hand.
 *
 * Usage:
 *   $env:ORACLE_ADDRESS = "0x…"        # REQUIRED (or read from the registry)
 *   $env:PRIVATE_KEY    = "0x…"        # required for a real run
 *   $env:CHAIN_ID / RPC_URL            # defaults: Monad testnet
 *   node script/deploy-vault-factory.js [--dry-run] [--fresh]
 */
import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chainInfo, registryFile, resolveRegistryFile } from "./networks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const DRY_RUN = process.argv.includes("--dry-run");
const FRESH = process.argv.includes("--fresh") || process.env.FRESH_FACTORY === "1";
const RPC_URL = process.env.RPC_URL || "https://testnet-rpc.monad.xyz";
const CHAIN_ID = Number(process.env.CHAIN_ID || 10143);

if (!process.env.PRIVATE_KEY && !DRY_RUN) {
  console.error("Set PRIVATE_KEY (or pass --dry-run).");
  process.exit(1);
}

const loadArtifact = (rel) => JSON.parse(fs.readFileSync(path.join(rootDir, "artifacts", "contracts", rel), "utf8"));
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

async function main() {
  const assetsPath = resolveRegistryFile(rootDir, "assets", CHAIN_ID);
  const assets = readJson(assetsPath);
  const oracleAddr = process.env.ORACLE_ADDRESS || assets?.oracle;
  if (!oracleAddr) throw new Error("ORACLE_ADDRESS is unset and the registry has no oracle");

  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`RPC is chain ${net.chainId}, expected ${CHAIN_ID} (${RPC_URL})`);
  }

  const factoryArtifact = loadArtifact("IRMarketVaultFactory.sol/IRMarketVaultFactory.json");
  const known = readJson(path.join(rootDir, registryFile("factory", CHAIN_ID)));
  const existing = process.env.FACTORY_ADDRESS || known?.factory || assets?.factory;

  console.log(`chain ${CHAIN_ID} (${chainInfo(CHAIN_ID).slug}) · oracle ${oracleAddr}`);

  if (existing && ethers.isAddress(existing) && !FRESH) {
    const code = await provider.getCode(existing);
    if (code !== "0x") {
      const c = new ethers.Contract(existing, factoryArtifact.abi, provider);
      const boundOracle = await c.oracle();
      const maxFee = await c.MAX_FEE_BPS();
      if (boundOracle.toLowerCase() === ethers.getAddress(oracleAddr).toLowerCase() && maxFee === 1_000n) {
        console.log(`  REUSE ${existing} (oracle-bound, MAX_FEE_BPS=1000)`);
        writeRegistries(existing, oracleAddr);
        return;
      }
      console.log(`  registry factory ${existing} is bound to ${boundOracle} → deploying a fresh one`);
    } else {
      console.log(`  registry factory ${existing} has no code on this chain → deploying a fresh one`);
    }
  }

  if (DRY_RUN) {
    console.log("\nDRY RUN — would deploy IRMarketVaultFactory(" + oracleAddr + ")");
    return;
  }

  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  console.log(`  deployer ${wallet.address} · ${ethers.formatEther(await provider.getBalance(wallet.address))} native`);
  const Factory = new ethers.ContractFactory(factoryArtifact.abi, factoryArtifact.bytecode, wallet);
  const factory = await Factory.deploy(oracleAddr);
  console.log(`  deploy tx ${factory.deploymentTransaction().hash}`);
  await factory.waitForDeployment();
  const address = await factory.getAddress();
  const boundOracle = await factory.oracle();
  if (boundOracle.toLowerCase() !== ethers.getAddress(oracleAddr).toLowerCase()) {
    throw new Error(`deployed factory oracle ${boundOracle} != ${oracleAddr}`);
  }
  console.log(`  ✅ factory ${address} (tx ${factory.deploymentTransaction().hash})`);
  writeRegistries(address, boundOracle);
}

function writeRegistries(factory, oracle) {
  const net = chainInfo(CHAIN_ID);
  const out = {
    network: net.slug,
    chainId: CHAIN_ID,
    factory,
    oracle,
    maxFeeBps: 1000,
    timestamp: new Date().toISOString(),
  };
  if (DRY_RUN) return;
  fs.writeFileSync(path.join(rootDir, registryFile("factory", CHAIN_ID)), JSON.stringify(out, null, 2));

  // Point the other registries at it (the web + deploy-pair-vaults read these).
  for (const kind of ["deployment", "assets"]) {
    const file = path.join(rootDir, registryFile(kind, CHAIN_ID));
    const data = readJson(file);
    if (!data) continue;
    data.factory = factory;
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }
  console.log(`  wrote ${registryFile("factory", CHAIN_ID)} (+ factory in deployment/assets registries)`);
}

main().catch((e) => {
  console.error("deploy-vault-factory failed:", e.shortMessage || e.message);
  process.exit(1);
});
