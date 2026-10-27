/**
 * mint-demo-tokens.js — mint the registered demo/test tokens to any wallet, on demand.
 *
 * Test tokens are a REGISTRY (deployment-assets.json), not a per-demo deploy: whenever a
 * demo/test balance is needed, mint — never redeploy (docs/architecture.md §5). MockERC20
 * `mint` is permissionless, so any caller can do this; PRIVATE_KEY here is the funder.
 *
 * Usage:
 *   node script/mint-demo-tokens.js 0xRecipient [ 1000e18-per-asset ]
 *   node script/mint-demo-tokens.js --dry-run 0xRecipient
 *   ASSETS="NVDA,SNDK" node script/mint-demo-tokens.js 0xRecipient 100000e18
 */
import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { resolveRegistryFile } from "./networks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const rest = args.filter((a) => a !== "--dry-run");
const RECIPIENT = rest.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
const AMOUNT_RAW = rest.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a) === false && a && !a.startsWith("--"));
const amount = ethers.parseEther((AMOUNT_RAW || "100000").replace(/e18$|E18$/, ""));

const RPC_URL = process.env.RPC_URL || "https://testnet-rpc.monad.xyz";
const CHAIN_ID = Number(process.env.CHAIN_ID || 10143);
const assetsFile = process.env.ASSETS_FILE || resolveRegistryFile(rootDir, "assets", CHAIN_ID);
const symbolFilter = (process.env.ASSETS || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

if (!RECIPIENT) {
  console.error("Usage: node script/mint-demo-tokens.js [--dry-run] 0xRecipient [amountLike100000e18]\n" +
    "  env: PRIVATE_KEY (funder), ASSETS=NVDA,SNDK to mint a subset, AMOUNT default 100000 per asset");
  process.exit(1);
}
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY && !DRY_RUN) { console.error("Set PRIVATE_KEY (the funder) or use --dry-run"); process.exit(1); }

const registryPath = path.isAbsolute(assetsFile) ? assetsFile : path.join(rootDir, assetsFile);
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
if (!registry?.assets?.length) { console.error(`${assetsFile} has no assets — deploy the market stack first`); process.exit(1); }
if (registry.chainId !== undefined && Number(registry.chainId) !== CHAIN_ID) {
  console.error(`registry ${assetsFile} is for chain ${registry.chainId}, not ${CHAIN_ID} — refusing to mint`);
  process.exit(1);
}

const tokens = [{ symbol: "HKD", token: registry.quoteToken },
  ...registry.assets.map((a) => ({ symbol: a.symbol, token: a.baseToken }))]
  .filter((t) => symbolFilter.length === 0 || symbolFilter.includes(t.symbol));

const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
const erc20 = ["function mint(address to, uint256 amount)", "function symbol() view returns (string)", "function balanceOf(address) view returns (uint256)"];

console.log(`minting demo tokens -> ${RECIPIENT}${DRY_RUN ? "  (DRY RUN)" : ""}`);
for (const t of tokens) {
  const c = new ethers.Contract(t.token, erc20, provider);
  const sym = await c.symbol().catch(() => t.symbol);
  const bal = await c.balanceOf(RECIPIENT).catch(() => null);
  console.log(`  ${sym.padEnd(8)} ${t.token}  current=${bal === null ? "?" : ethers.formatEther(bal)}  -> mint ${ethers.formatEther(amount)}`);
  if (DRY_RUN) continue;
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  const tx = await (c.connect(signer)).mint(RECIPIENT, amount);
  await tx.wait();
  console.log(`    tx ${tx.hash}`);
}
console.log(DRY_RUN ? "dry run — nothing sent" : "done");
