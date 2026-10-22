/**
 * deploy-market-stack.js — deploy the IRMarket-SIDE stack to an EVM chain; CONSUMER of upstream Monoracle.
 *
 * RULE (see docs/architecture.md §5 / monoracle-upstream-handoff.md): IRMarket CONSUMES the
 * upstream Monoracle — this script NEVER deploys it (<script>deploy-upstream-stack.js was
 * renamed; the oracle-deploy step was deliberately removed). The wrapper and vault bind the
 * oracle at construction (immutable); re-pointing = redeploying them, never editing ABIs.
 *
 * What this deploys (reusing what it can from the registries):
 *   1. IRMarket wrapper (oracle-bound)   — reused ONLY if the existing binding matches
 *   2. HKD quote token (MockERC20)       — reused from deployment-assets.json (NEVER redeployed)
 *   3. base tokens per asset (MockERC20) — reused by symbol from deployment-assets.json
 *   4. markets (ONE long-lived market per asset) — reused from the registry if the on-chain
 *                                          market matches (pair/marketMaker/feeBps); created
 *                                          only if missing. The market's own expiryBlock is
 *                                          INERT: rounds are defined by the QUOTE's expiryBlock
 *                                          (docs/sc-tech-spec.md).
 *   5. IRMarketVault                     — MVP ships exactly ONE vault (assets[0]); reused only
 *                                          if its oracle/pair bindings match this run
 *
 * Pre-flight gate: the ORACLE_ADDRESS is fingerprinted on-chain; it MUST read as upstream "A"
 * (VERIFICATION_SLOTS + MAX_VERIFICATION_SLOTS + submitQuote(uint32) selector) or the script
 * exits 1 — the rule is "migrate the oracle, never bend the ABI" (script/oracle-doctor.js).
 *
 * Usage:
 *   $env:ORACLE_ADDRESS  = "<upstream oracle>"          # REQUIRED; exit 1 if missing
 *   $env:PRIVATE_KEY     = "<funded deployer>"          # required for a real run
 *   node script/deploy-market-stack.js [ --dry-run ]    # --dry-run: checks + plan, zero txs
 *   --fresh-wrapper (FRESH_WRAPPER=1)                   # deploy a new wrapper even when the
 *                                                       # registry's wrapper binds this oracle
 *   FRESH_TOKENS=1 / --fresh-tokens                     # force-deploy brand-new tokens
 *   MARKET_MAKER="<addr>"                               # marketMaker for created markets (default: deployer)
 *   MARKET_EXPIRY_BLOCKS=3000                           # market's (inert) expiryBlock, 15 min @0.3s
 * Writes deployment.json / deployment-assets.json / deployment-vault.json.
 */
import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { shouldReuseWrapper, shouldReuseVault } from "./stack-reuse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const DRY_RUN = process.argv.includes("--dry-run");
const FRESH_TOKENS = process.env.FRESH_TOKENS === "1" || process.argv.includes("--fresh-tokens");
// --fresh-wrapper (FRESH_WRAPPER=1): force a brand-new wrapper even when the registry's
// wrapper binds the same oracle. Without it a same-oracle re-run silently KEEPS the
// old wrapper — which is how the wrapper gate (issue #22) ended up "not on chain"
// while main carried it. Tokens and the vault still reuse normally.
const FRESH_WRAPPER = process.env.FRESH_WRAPPER === "1" || process.argv.includes("--fresh-wrapper");
const RPC_URL = process.env.RPC_URL || "https://testnet-rpc.monad.xyz";
const CHAIN_ID = Number(process.env.CHAIN_ID || 10143);
const FEE_BPS = BigInt(process.env.FEE_BPS || "100");
// The market's own expiryBlock is ADVISORY/INERT (openLong validates the QUOTE's expiryBlock,
// never the market's), so we park it just past creation (15 min). Rounds = quote expiryBlock.
const MARKET_EXPIRY_BLOCKS = Number(process.env.MARKET_EXPIRY_BLOCKS || 3000); // 15 min @ 0.3s
// Fee recipient for created markets (used by createMarket's marketMaker param). Default: deployer.
const MARKET_MAKER = process.env.MARKET_MAKER || "";
const DECIMALS = 18;
const QUOTE_NAME = process.env.QUOTE_NAME || "HKD";
const QUOTE_SYMBOL = process.env.QUOTE_SYMBOL || "HKD";
const ASSETS_RAW = process.env.ASSETS || "NVDA:230,GLM:2.5,SNDK:88,DEEPSEEK:45,SOXX:514";

// Per-symbol real-price descriptor merged into deployment-assets.json so the bot knows how to
// price each asset (docs/design/bot-real-price-feed-spec.md §6.1). Unknown symbols => synthetic.
const FEED_DESCRIPTORS = {
  NVDA: { priceSource: "nasdaq", priceSymbol: "NVDA", assetClass: "stocks" },
  SNDK: { priceSource: "nasdaq", priceSymbol: "SNDK", assetClass: "stocks" },
  SOXX: { priceSource: "nasdaq", priceSymbol: "SOXX", assetClass: "etf" },
  GLM: { priceSource: "sina", priceSymbol: "hk02513", assetClass: "stocks" },
  DEEPSEEK: { priceSource: "synthetic" },
  // Nebius spot GPU prices (USD per GPU-hour; lowest across regions unless
  // priceSymbol pins one with `@region` — not exercised by any default entry;
  // set e.g. priceSymbol: "B300@us-central1" to pin). Opt-in via
  // ASSETS=B300:<fair> — no token/market exists for these by default.
  B300: { priceSource: "nebius", priceSymbol: "B300", assetClass: "gpu" },
  B200: { priceSource: "nebius", priceSymbol: "B200", assetClass: "gpu" },
  H200: { priceSource: "nebius", priceSymbol: "H200", assetClass: "gpu" },
  H100: { priceSource: "nebius", priceSymbol: "H100", assetClass: "gpu" },
  "RTX PRO 6000": { priceSource: "nebius", priceSymbol: "RTX PRO 6000", assetClass: "gpu" },
};
const feedDescriptor = (symbol) => FEED_DESCRIPTORS[symbol] || { priceSource: "synthetic" };

const ORACLE_ADDRESS = process.env.ORACLE_ADDRESS;
if (!ORACLE_ADDRESS) {
  console.error("Set ORACLE_ADDRESS env var — IRMarket CONSUMES the upstream oracle; this script never deploys one.");
  process.exit(1);
}
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY && !DRY_RUN) {
  console.error("Set PRIVATE_KEY env var (or pass --dry-run for checks+plan with zero txs).");
  process.exit(1);
}

const BLOCK_SECONDS = 0.3;
const E18 = 10n ** 18n;
const MINT_BASE = ethers.parseEther("1000000");
const MINT_QUOTE = ethers.parseEther("10000000");
const MAX_UINT = ethers.MaxUint256;

const GAS = { mint: 150_000, approve: 100_000, createMarket: 300_000, fallbackToken: 2_000_000, fallbackWrapper: 2_500_000, fallbackVault: 3_000_000 };

function loadArtifact(rel) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, "artifacts", "contracts", rel), "utf8"));
}
function loadJson(file) {
  const p = path.join(rootDir, file);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
function parseAssets(raw) {
  const out = [];
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [symbol, pricePart = "1"] = entry.split(":");
    if (!symbol) throw new Error(`Invalid ASSETS entry: "${entry}"`);
    const units = Number(pricePart);
    if (!Number.isFinite(units) || units <= 0) throw new Error(`Invalid fair price in "${entry}"`);
    out.push({ symbol: symbol.trim().toUpperCase(), name: symbol.trim(), fairPrice: ethers.parseEther(String(units)) });
  }
  if (out.length === 0) throw new Error("ASSETS is empty");
  return out;
}

const SHOW_LEN = (s) => Math.min(s.length, 48);

// --- pre-flight gate: the oracle MUST fingerprint as upstream "A" -----------------
async function gateOracle(provider) {
  const addr = ethers.getAddress(ORACLE_ADDRESS);
  const code = (await provider.getCode(addr)).toLowerCase();
  if (!code || code === "0x") {
    console.error(`GATE FAIL: ${addr} has no code.`);
    process.exit(1);
  }
  const sel = (s) => ethers.id(s).slice(2, 10);
  const has = (s) => code.includes(sel(s));
  const sub32 = "submitQuote(address,address,uint256,uint256,uint32)";
  const checks = {
    "VERIFICATION_SLOTS()": has("VERIFICATION_SLOTS()"),
    "MAX_VERIFICATION_SLOTS()": has("MAX_VERIFICATION_SLOTS()"),
    [sub32]: has(sub32),
  };
  const ok = Object.values(checks).every(Boolean);
  console.log("== oracle gate (upstream A fingerprint) ==");
  for (const [sig, present] of Object.entries(checks)) {
    console.log(`  ${sig.padEnd(SHOW_LEN(sig))} ${present ? "present" : "MISSING  <-- DRIFT"}`);
  }
  const o = new ethers.Contract(addr, ["function VERIFICATION_SLOTS() view returns (uint256)", "function MAX_VERIFICATION_SLOTS() view returns (uint256)"], provider);
  try {
    console.log(`  VERIFICATION_SLOTS = ${(await o.VERIFICATION_SLOTS()).toString()}  (upstream default: 2)`);
    console.log(`  MAX_VERIFICATION_SLOTS = ${(await o.MAX_VERIFICATION_SLOTS()).toString()}  (upstream cap ~1h: 12000)`);
  } catch (e) {
    console.log(`  (constant reads failed: ${e.shortMessage || e.message})`);
  }
  if (!ok) {
    console.error(`\nGATE FAIL: ${addr} is not the upstream (A) shape.`);
    console.error("Rule: if the ABI and the deployed oracle disagree, MIGRATE THE ORACLE — never bend the ABI (script/oracle-doctor.js).");
    process.exit(1);
  }
  console.log("  gate: PASS\n");
  return addr;
}

async function main() {
  const assets = parseAssets(ASSETS_RAW);
  const marketArtifact = loadArtifact("IRMarket.sol/IRMarket.json");
  const tokenArtifact = loadArtifact("MockERC20.sol/MockERC20.json");
  const vaultArtifact = loadArtifact("IRMarketVault.sol/IRMarketVault.json");
  const registry = loadJson("deployment-assets.json");
  const vaultRegistry = loadJson("deployment-vault.json");

  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const oracleAddr = await gateOracle(provider);

  console.log("=== deploy IRMarket market stack (consumer of upstream Monoracle) ===");
  console.log(`RPC ${RPC_URL} chainId ${CHAIN_ID}`);
  console.log(`oracle  (consumed): ${oracleAddr}`);
  console.log(`assets: ${assets.map((a) => `${a.symbol}@${ethers.formatEther(a.fairPrice)}`).join(", ")}`);
  console.log(`token mode: ${FRESH_TOKENS ? "FRESH (force new, FOR testing only)" : "reuse registry (mint top-ups, never redeploy)"}`);
  console.log(`wrapper mode: ${FRESH_WRAPPER ? "FRESH (--fresh-wrapper: deploy new even if the registry's wrapper binds this oracle)" : "reuse if the registry's wrapper binds this oracle"}\n`);

  // reuse decisions
  const reuseQuote = !FRESH_TOKENS && registry?.quoteToken && ethers.isAddress(registry.quoteToken) ? registry.quoteToken : undefined;
  const bySymbol = new Map((registry?.assets || []).map((a) => [a.symbol, a]));

  // deployment-assets.json is REWRITTEN wholesale from ASSETS at the end of this script,
  // so a symbol present in the current registry but absent from ASSETS is silently
  // dropped (losing its token/market links). Surface that instead of shrinking quietly.
  const dropped = [...bySymbol.keys()].filter((s) => !assets.some((a) => a.symbol === s));
  if (dropped.length) {
    console.warn(
      `WARNING: ASSETS omits registry symbol(s) ${dropped.join(", ")} — they will be DROPPED ` +
        "from deployment-assets.json. Add them to ASSETS to keep them."
    );
  }

  // wrapper reuse: only if the existing wrapper is bound to this exact oracle
  // (FRESH_WRAPPER=1 / --fresh-wrapper: deploy new, same-oracle rebuild — see header).
  let wrapperAddr;
  if (registry?.market && ethers.isAddress(registry.market)) {
    const m = new ethers.Contract(registry.market, ["function oracle() view returns (address)"], provider);
    const chainOracle = await m.oracle().catch(() => null);
    if (shouldReuseWrapper(registry, chainOracle, oracleAddr, { freshWrapper: FRESH_WRAPPER })) {
      wrapperAddr = ethers.getAddress(registry.market);
    }
  }
  if (wrapperAddr) console.log(`[1/5] IRMarket wrapper: REUSE ${wrapperAddr}`);
  else console.log("[1/5] IRMarket wrapper: deploy new (oracle-bound at construction)");
  console.log("[2/5] HKD quote: " + (reuseQuote ? `REUSE ${reuseQuote}` : "deploy new"));
  console.log(`[3/5] base tokens: ${assets.map((a) => {
    const r = bySymbol.get(a.symbol);
    return !FRESH_TOKENS && r?.baseToken ? `${a.symbol} REUSE ${r.baseToken}` : `${a.symbol} deploy new`;
  }).join(", ")}`);
  console.log("[4/5] markets: one long-lived market per asset (reuse from registry; create only if missing)");
  console.log("[5/5] vault: exactly ONE (assets[0]) — reuse if bindings match\n");

  if (DRY_RUN) {
    console.log("DRY RUN — no transactions sent. Registries (if present) were used only read-only.");
    return;
  }

  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const addr = await wallet.getAddress();
  console.log(`Deployer: ${addr}`);
  console.log(`Balance:  ${ethers.formatEther(await provider.getBalance(addr))} MON\n`);

  let nonce = BigInt(await provider.send("eth_getTransactionCount", [addr, "pending"]));
  const txHashes = {};

  async function estimateGas(txReq, fallback = GAS.fallbackToken) {
    try { return (await provider.estimateGas({ ...txReq, from: addr })) * 120n / 100n; }
    catch (e) { console.warn(`  ! estimateGas failed (${e.shortMessage || e.message}); using ${fallback} gas fallback`); return BigInt(fallback); }
  }
  async function send(label, txReq) {
    try {
      const tx = await wallet.sendTransaction({ ...txReq, nonce });
      nonce += 1n;
      console.log(`  ${label}: ${tx.hash}`);
      return await tx.wait();
    } catch (e) {
      nonce = BigInt(await provider.send("eth_getTransactionCount", [addr, "pending"]));
      throw e;
    }
  }
  async function deploy(label, artifact, args = [], fallback = GAS.fallbackToken) {
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
    const txReq = await factory.getDeployTransaction(...args);
    const gasLimit = await estimateGas(txReq, fallback);
    const rc = await send(label, { ...txReq, gasLimit });
    return { address: rc.contractAddress, abi: artifact.abi, txHash: rc.hash };
  }
  async function call(label, contract, method, args, gasLimit) {
    try {
      const tx = await contract[method](...args, { nonce, gasLimit });
      nonce += 1n;
      console.log(`  ${label}: ${tx.hash}`);
      return await tx.wait();
    } catch (e) {
      nonce = BigInt(await provider.send("eth_getTransactionCount", [addr, "pending"]));
      throw e;
    }
  }
  async function ensureApproval(tokenC, spender, label) {
    const cur = await tokenC.allowance(addr, spender);
    if (cur >= MAX_UINT / 2n) { console.log(`  approve ${label}: already set`); return; }
    await call(`approve ${label} -> oracle`, tokenC, "approve", [spender, MAX_UINT], GAS.approve);
  }
  async function topUp(tokenC, bal, need, label) {
    if (bal >= need) { console.log(`  ${label} balance ok (${ethers.formatEther(bal)})`); return; }
    await call(`mint ${label} top-up ${ethers.formatEther(need - bal)}`, tokenC, "mint", [addr, need - bal], GAS.mint);
  }

  // 1) wrapper
  let market;
  if (wrapperAddr) {
    market = { address: wrapperAddr, abi: marketArtifact.abi, txHash: null, reused: true };
  } else {
    market = { ...await deploy("IRMarket", marketArtifact, [oracleAddr], GAS.fallbackWrapper), reused: false };
    txHashes.market = market.txHash;
  }
  txHashes.market = txHashes.market || (market.reused ? "0x0 (reused)" : txHashes.market);

  // 2) HKD quote
  let quote;
  if (reuseQuote) {
    quote = { address: reuseQuote, abi: tokenArtifact.abi, txHash: null, reused: true };
  } else {
    quote = { ...await deploy("MockERC20 HKD", tokenArtifact, [QUOTE_NAME, QUOTE_SYMBOL, DECIMALS]), reused: false };
    txHashes.quoteToken = quote.txHash;
  }
  const quoteC = new ethers.Contract(quote.address, tokenArtifact.abi, wallet);
  await topUp(quoteC, await quoteC.balanceOf(addr), MINT_QUOTE, "HKD");
  await ensureApproval(quoteC, oracleAddr, "HKD");

  // 3-4) base tokens + one long-lived market per asset
  const marketC = new ethers.Contract(market.address, market.abi, wallet);
  const marketMakerAddr = MARKET_MAKER ? ethers.getAddress(MARKET_MAKER) : addr;
  const startBlock = BigInt(await provider.getBlockNumber());
  const expiryBlock = startBlock + BigInt(MARKET_EXPIRY_BLOCKS);
  console.log(`  market expiryBlock ${expiryBlock} (+${MARKET_EXPIRY_BLOCKS} blocks ~${Math.floor(MARKET_EXPIRY_BLOCKS * BLOCK_SECONDS)}s)`);
  console.log(`  marketMaker ${marketMakerAddr} (fee recipient${marketMakerAddr.toLowerCase() === addr.toLowerCase() ? " = deployer" : ""}; INERT market expiry — rounds = quote expiryBlock)`);
  const assetResults = [];
  for (const asset of assets) {
    console.log(`\n  [${asset.symbol}]`);
    const prev = bySymbol.get(asset.symbol);
    let base;
    if (!FRESH_TOKENS && prev?.baseToken && ethers.isAddress(prev.baseToken)) {
      base = { address: ethers.getAddress(prev.baseToken), abi: tokenArtifact.abi, txHash: prev.txHashes?.base, reused: true };
      console.log(`  base REUSE ${base.address}`);
    } else {
      base = { ...await deploy(`MockERC20 ${asset.symbol}`, tokenArtifact, [asset.name, asset.symbol, DECIMALS]), reused: false };
      txHashes[`base_${asset.symbol}`] = base.txHash;
    }
    const baseC = new ethers.Contract(base.address, tokenArtifact.abi, wallet);
    await topUp(baseC, await baseC.balanceOf(addr), MINT_BASE, asset.symbol);
    await ensureApproval(baseC, oracleAddr, asset.symbol);
    // Idempotent market reuse (deploy-owned): the registry's marketId points at a market on THIS wrapper
    // whose (pair, feeBps) still match → keep it; the round model no longer needs new markets.
    // NOTE: marketMaker is intentionally NOT matched — older registries used the deployer and
    // the fee recipient is advisory-only for the UI; a fresh market is created only when the
    // pair/fee no longer fit (or FRESH_TOKENS wiped the registry entry).
    let marketId = null;
    let marketReused = false;
    if (!FRESH_TOKENS && prev?.marketId && Number.isFinite(Number(prev.marketId)) && Number(prev.marketId) > 0) {
      try {
        const ex = await marketC.markets(BigInt(prev.marketId));
        if (
          ex.baseToken !== ethers.ZeroAddress &&
          ex.baseToken.toLowerCase() === base.address.toLowerCase() &&
          ex.quoteToken.toLowerCase() === quote.address.toLowerCase() &&
          Number(ex.feeBps) === Number(FEE_BPS)
        ) {
          marketId = String(prev.marketId);
          marketReused = true;
          console.log(`  marketId ${marketId} REUSE (long-lived — no createMarket needed)`);
        }
      } catch { /* markets() read failed (old wrapper / bad id) — create fresh */ }
    }
    if (!marketReused) {
      const rc = await call(`createMarket ${asset.symbol}`, marketC, "createMarket",
        [base.address, quote.address, marketMakerAddr, expiryBlock, FEE_BPS], GAS.createMarket);
      const log = rc.logs
        .map((l) => { try { return marketC.interface.parseLog(l); } catch { return null; } })
        .find((l) => l && l.name === "MarketCreated");
      marketId = log ? log.args.marketId.toString() : null;
      console.log(`  marketId ${marketId ?? "?"} (new)`);
    }
    assetResults.push({
      symbol: asset.symbol,
      baseToken: base.address,
      quoteToken: quote.address,
      fairPrice: asset.fairPrice.toString(),
      marketId,
      expiryBlock: expiryBlock.toString(),
      ...feedDescriptor(asset.symbol),
    });
  }

  // 5) vault — exactly one, for assets[0], reused only if bindings match
  const first = assetResults[0];
  let vault, vaultReused = false;
  if (vaultRegistry?.vault && ethers.isAddress(vaultRegistry.vault)) {
    const v = new ethers.Contract(vaultRegistry.vault, [
      "function oracle() view returns (address)",
      "function priceBase() view returns (address)",
      "function settlementToken() view returns (address)",
    ], provider);
    const bindings = {
      vault: vaultRegistry.vault,
      oracle: await v.oracle().catch(() => null),
      priceBase: await v.priceBase().catch(() => null),
      settlementToken: await v.settlementToken().catch(() => null),
    };
    if (shouldReuseVault(bindings, { oracle: oracleAddr, baseToken: first.baseToken, quoteToken: quote.address })) {
      vault = { address: ethers.getAddress(vaultRegistry.vault), abi: vaultArtifact.abi, txHash: vaultRegistry.txHashes?.vault };
      vaultReused = true;
      console.log(`\n[5/5] vault REUSE ${vault.address} (bindings match)`);
    } else {
      console.log(`\n[5/5] vault ${vaultRegistry.vault} bindings mismatch / not an IRMarketVault → deploy new`);
    }
  }
  if (!vault) {
    vault = await deploy("IRMarketVault", vaultArtifact, [oracleAddr, first.baseToken, quote.address, FEE_BPS], GAS.fallbackVault);
    txHashes.vault = vault.txHash;
  }
  first.vault = vault.address; // per-pair binding (MVP ships assets[0] only)

  const now = new Date().toISOString();
  const deployment = {
    network: "monad-testnet",
    chainId: CHAIN_ID,
    deployer: addr,
    oracle: oracleAddr,
    market: market.address,
    baseToken: first.baseToken,
    quoteToken: quote.address,
    marketId: first.marketId,
    feeBps: Number(FEE_BPS),
    expiryBlock: expiryBlock.toString(),
    reused: { market: market.reused, quoteToken: quote.reused, vault: vaultReused },
    txHashes,
    timestamp: now,
  };
  const assetsOut = {
    network: "monad-testnet",
    chainId: CHAIN_ID,
    oracle: oracleAddr,
    market: market.address,
    quoteToken: quote.address,
    assets: assetResults,
  };
  const vaultOut = {
    network: "monad-testnet",
    chainId: CHAIN_ID,
    deployer: addr,
    oracle: oracleAddr,
    priceBase: first.baseToken,
    settlementToken: quote.address,
    vault: vault.address,
    feeBps: Number(FEE_BPS),
    reusedExistingStack: vaultReused,
    txHashes: { vault: vault.txHash },
    timestamp: now,
  };

  fs.writeFileSync(path.join(rootDir, "deployment.json"), JSON.stringify(deployment, null, 2));
  fs.writeFileSync(path.join(rootDir, "deployment-assets.json"), JSON.stringify(assetsOut, null, 2));
  fs.writeFileSync(path.join(rootDir, "deployment-vault.json"), JSON.stringify(vaultOut, null, 2));

  console.log("\n=== Done — wrote deployment.json / deployment-assets.json / deployment-vault.json ===");
  console.log(`  NEXT_PUBLIC_ORACLE_ADDRESS=${oracleAddr}   (consumed upstream — NEVER redeploy this script side)`);
  console.log(`  NEXT_PUBLIC_MARKET_ADDRESS=${market.address}`);
  console.log(`  NEXT_PUBLIC_BASE_TOKEN=${first.baseToken}`);
  console.log(`  NEXT_PUBLIC_QUOTE_TOKEN=${quote.address}`);
  console.log(`  NEXT_PUBLIC_VAULT_ADDRESS=${vault.address}`);
  console.log(`\nExplorer: https://testnet.monadscan.com/address/${market.reused ? oracleAddr : market.address}`);
}

main().catch((e) => {
  console.error("Deploy failed:", e.shortMessage || e.message);
  if (e.info) console.error("  Info:", JSON.stringify(e.info, null, 2));
  process.exit(1);
});
