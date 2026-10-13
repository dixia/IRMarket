import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const OUT_FILE = path.join(rootDir, "deployment-assets.json");

const DRY_RUN = process.argv.includes("--dry-run");

const RPC_URL = process.env.RPC_URL || "https://testnet-rpc.monad.xyz";
const CHAIN_ID = Number(process.env.CHAIN_ID || 10143);
const FEE_BPS = Number(process.env.FEE_BPS || 100);
const EXPIRY_SECONDS = Number(process.env.EXPIRY_SECONDS || 1800);
const ASSET_NAME_PREFIX = process.env.ASSET_NAME_PREFIX || "";
const ASSETS_RAW = process.env.ASSETS || "NVDA:130,GLM:1,SNDK:50";

const BLOCK_SECONDS = 0.3;
const MINT_BASE = ethers.parseEther("1000000");
const MIN_QUOTE = ethers.parseEther("1000000");
const MAX_UINT = ethers.MaxUint256;

const GAS = {
  deployToken: 2_000_000,
  mint: 150_000,
  approve: 100_000,
  createMarket: 2_000_000,
};

function loadArtifact(name) {
  const p = path.join(rootDir, "artifacts", "contracts", name + ".sol", name + ".json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function parseAssets(raw) {
  const out = [];
  for (const entry of raw.split(",").map(s => s.trim()).filter(Boolean)) {
    const parts = entry.split(":");
    const symbol = (parts[0] || "").trim();
    if (!symbol) throw new Error(`Invalid ASSETS entry: "${entry}"`);
    const pricePart = parts.length > 1 ? parts[1].trim() : "";
    const units = pricePart === "" ? 1 : Number(pricePart);
    if (!Number.isFinite(units) || units <= 0) throw new Error(`Invalid fair price in "${entry}"`);
    const fairPrice = ethers.parseEther(String(units));
    const name = ASSET_NAME_PREFIX ? `${ASSET_NAME_PREFIX} ${symbol}` : symbol;
    out.push({ symbol, name, fairPrice });
  }
  if (out.length === 0) throw new Error("ASSETS is empty");
  return out;
}

function loadExisting() {
  if (!fs.existsSync(OUT_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(OUT_FILE, "utf8")); } catch { return null; }
}

function printPlan(assets, existing) {
  const bySymbol = new Map((existing?.assets || []).map(a => [a.symbol, a]));
  const rows = assets.map(a => ({
    symbol: a.symbol,
    name: a.name,
    fairPrice: ethers.formatEther(a.fairPrice),
    baseToken: bySymbol.get(a.symbol)?.baseToken || "(new deploy)",
  }));
  console.log("=== DRY RUN — planned asset deployments ===");
  console.log(`chainId:      ${CHAIN_ID}`);
  console.log(`quoteToken:   ${process.env.QUOTE_TOKEN || "(unset)"}`);
  console.log(`feeBps:       ${FEE_BPS}`);
  console.log(`expiry:       ${EXPIRY_SECONDS}s (~${Math.floor(EXPIRY_SECONDS / BLOCK_SECONDS)} blocks)`);
  console.log(`namePrefix:   ${ASSET_NAME_PREFIX || "(none, name = symbol)"}`);
  console.table(rows);
  for (const a of assets) console.log(`${a.symbol}: fairPriceRaw=${a.fairPrice.toString()}`);
  console.log("No transactions sent.");
}

async function main() {
  const assets = parseAssets(ASSETS_RAW);
  const existing = loadExisting();

  if (DRY_RUN) {
    printPlan(assets, existing);
    return;
  }

  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  if (!PRIVATE_KEY) { console.error("Set PRIVATE_KEY env var"); process.exit(1); }
  const MARKET_ADDRESS = process.env.MARKET_ADDRESS;
  if (!MARKET_ADDRESS) { console.error("Set MARKET_ADDRESS env var"); process.exit(1); }
  const ORACLE_ADDRESS = process.env.ORACLE_ADDRESS;
  if (!ORACLE_ADDRESS) { console.error("Set ORACLE_ADDRESS env var"); process.exit(1); }
  const QUOTE_TOKEN = process.env.QUOTE_TOKEN;
  if (!QUOTE_TOKEN) { console.error("Set QUOTE_TOKEN env var"); process.exit(1); }

  const mockArtifact = loadArtifact("MockERC20");
  const marketAbi = loadArtifact("IRMarket").abi;

  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const addr = await wallet.getAddress();

  const marketAddr = ethers.getAddress(MARKET_ADDRESS);
  const oracleAddr = ethers.getAddress(ORACLE_ADDRESS);
  const quoteAddr = ethers.getAddress(QUOTE_TOKEN);

  console.log("=== Deploy Multi-Asset Markets ===");
  console.log(`Deployer: ${addr}`);
  console.log(`Balance:  ${ethers.formatEther(await provider.getBalance(addr))} MON`);
  console.log(`Market:   ${marketAddr}`);
  console.log(`Oracle:   ${oracleAddr}`);
  console.log(`Quote:    ${quoteAddr}`);

  const startBlock = BigInt(await provider.getBlockNumber());
  const expiryBlock = startBlock + BigInt(Math.floor(EXPIRY_SECONDS / BLOCK_SECONDS));
  let nonce = BigInt(await provider.send("eth_getTransactionCount", [addr, "pending"]));

  const factory = new ethers.ContractFactory(mockArtifact.abi, mockArtifact.bytecode, wallet);
  const quote = new ethers.Contract(quoteAddr, mockArtifact.abi, wallet);
  const market = new ethers.Contract(marketAddr, marketAbi, wallet);

  async function send(label, gasLimit, buildTx) {
    try {
      const tx = await buildTx({ nonce, gasLimit });
      nonce += 1n;
      console.log(`  ${label}: ${tx.hash}`);
      await tx.wait();
      return tx;
    } catch (e) {
      nonce = BigInt(await provider.send("eth_getTransactionCount", [addr, "pending"]));
      throw e;
    }
  }

  async function ensureApproval(token, label) {
    const current = await token.allowance(addr, oracleAddr);
    if (current >= MAX_UINT / 2n) {
      console.log(`  approve oracle ${label}: already set`);
      return;
    }
    await send(`approve oracle ${label}`, GAS.approve, o => token.approve(oracleAddr, MAX_UINT, o));
  }

  const quoteBal = await quote.balanceOf(addr);
  if (quoteBal < MIN_QUOTE) {
    try {
      await send(`mint QUOTE ${ethers.formatEther(MIN_QUOTE - quoteBal)}`, GAS.mint, o => quote.mint(addr, MIN_QUOTE - quoteBal, o));
    } catch (e) {
      console.warn(`  ! QUOTE mint skipped (${e.shortMessage || e.message})`);
    }
  } else {
    console.log(`  QUOTE balance: ${ethers.formatEther(quoteBal)}`);
  }
  await ensureApproval(quote, "QUOTE");

  const bySymbol = new Map((existing?.assets || []).map(a => [a.symbol, a]));
  const results = [];

  for (const asset of assets) {
    console.log(`\n[${asset.symbol}]`);
    let baseToken = bySymbol.get(asset.symbol)?.baseToken;
    let base;

    if (baseToken) {
      baseToken = ethers.getAddress(baseToken);
      base = new ethers.Contract(baseToken, mockArtifact.abi, wallet);
      console.log(`  baseToken (reused): ${baseToken}`);
    } else {
      base = await factory.deploy(asset.name, asset.symbol, 18, { nonce, gasLimit: GAS.deployToken });
      nonce += 1n;
      baseToken = base.target;
      console.log(`  deploy ${asset.name} (${asset.symbol}): ${baseToken}`);
      await base.waitForDeployment();
    }

    const bal = await base.balanceOf(addr);
    if (bal < MINT_BASE) {
      await send(`mint ${asset.symbol}`, GAS.mint, o => base.mint(addr, MINT_BASE - bal, o));
    } else {
      console.log(`  ${asset.symbol} balance: ${ethers.formatEther(bal)}`);
    }

    await ensureApproval(base, asset.symbol);

    const tx = await send(`createMarket ${asset.symbol}`, GAS.createMarket,
      o => market.createMarket(baseToken, quoteAddr, addr, expiryBlock, BigInt(FEE_BPS), o));
    const receipt = await provider.getTransactionReceipt(tx.hash);
    const createdLog = receipt.logs
      .map(l => { try { return market.interface.parseLog(l); } catch { return null; } })
      .find(l => l && l.name === "MarketCreated");
    const marketId = createdLog ? createdLog.args.marketId.toString() : null;
    console.log(`  marketId: ${marketId ?? "?"}  expiryBlock: ${expiryBlock}`);

    results.push({
      symbol: asset.symbol,
      baseToken,
      quoteToken: quoteAddr,
      fairPrice: asset.fairPrice.toString(),
      marketId,
      expiryBlock: expiryBlock.toString(),
    });
  }

  const out = {
    network: "monad-testnet",
    chainId: CHAIN_ID,
    oracle: oracleAddr,
    market: marketAddr,
    quoteToken: quoteAddr,
    assets: results,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));

  console.log("\n=== Summary ===");
  console.table(results);
  console.log(`Wrote ${path.relative(process.cwd(), OUT_FILE)}`);
}

main().catch(e => { console.error("Failed:", e.shortMessage || e.message); process.exit(1); });
