/**
 * deploy-vault-rpc.js — deploy the LP-vault MVP stack to any JSON-RPC EVM and smoke-test it.
 *
 * Defaults to a local Foundry anvil; works unchanged on Monad testnet via env vars:
 *
 *   local anvil :  node script/deploy-vault-rpc.js
 *   monad       :  $env:RPC_URL="https://testnet-rpc.monad.xyz"
 *                  $env:CHAIN_ID="10143"
 *                  $env:PRIVATE_KEY="0x..."          # funded with MON
 *                  node script/deploy-vault-rpc.js
 *
 * Env: RPC_URL (default http://127.0.0.1:8545), CHAIN_ID (31337), PRIVATE_KEY (optional on
 * anvil — falls back to the node's unlocked account 0), FEE_BPS (100), SMOKE=0 to skip the
 * lifecycle walkthrough, MINE=1 to force evm_mine on a non-31337 chain.
 *
 * Reuse mode (deploy ONLY the vault against an existing stack): set ORACLE_ADDRESS,
 * PRICE_BASE and SETTLEMENT_TOKEN together (BASE_TOKEN/QUOTE_TOKEN are accepted as legacy
 * aliases). The vault is single-asset: `settlementToken` is the only asset it custodies and
 * `priceBase` is just the Monoracle pair key.
 *
 * Writes the addresses to `deployment-vault.json` (gitignored).
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chainInfo, registryFile } from "./networks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env.CHAIN_ID || 31337);
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const FEE_BPS = BigInt(process.env.FEE_BPS || "100");
// Reuse an existing oracle/token stack (deploy ONLY the vault). Set ORACLE_ADDRESS,
// PRICE_BASE and SETTLEMENT_TOKEN together to point the vault at a live market (e.g. the
// V0.9 test tokens) instead of deploying a fresh MonoracleMock + MockERC20 pair.
// BASE_TOKEN/QUOTE_TOKEN are accepted as legacy aliases for PRICE_BASE/SETTLEMENT_TOKEN.
const REUSE_ORACLE = process.env.ORACLE_ADDRESS;
const REUSE_BASE = process.env.PRICE_BASE || process.env.BASE_TOKEN;
const REUSE_QUOTE = process.env.SETTLEMENT_TOKEN || process.env.QUOTE_TOKEN;
const REUSE = Boolean(REUSE_ORACLE && REUSE_BASE && REUSE_QUOTE);
const RUN_SMOKE = process.env.SMOKE !== "0" && !REUSE;
const E18 = 10n ** 18n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getArtifact(rel) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, "artifacts", rel), "utf8"));
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const net = await provider.getNetwork();
  const signer = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY, provider) : await provider.getSigner(0);
  const addr = await signer.getAddress();
  const canMine = net.chainId === 31337n || process.env.MINE === "1";

  console.log(`RPC ${RPC_URL}  chainId=${net.chainId}  deployer=${addr}`);
  console.log(`Balance ${ethers.formatEther(await provider.getBalance(addr))} native`);

  async function nextNonce() {
    return BigInt(await provider.send("eth_getTransactionCount", [addr, "pending"]));
  }
  async function deploy(name, rel, args = []) {
    const art = getArtifact(rel);
    const factory = new ethers.ContractFactory(art.abi, art.bytecode, signer);
    const tx = await factory.getDeployTransaction(...args);
    const sent = await signer.sendTransaction({ ...tx, nonce: await nextNonce() });
    const rc = await sent.wait();
    console.log(`  ${name.padEnd(16)} ${rc.contractAddress}`);
    return { address: rc.contractAddress, abi: art.abi, txHash: sent.hash };
  }

  console.log("\nDeploying...");
  let oracle, base, quote;
  if (REUSE) {
    console.log(`  reusing oracle ${REUSE_ORACLE}`);
    console.log(`  reusing priceBase ${REUSE_BASE}`);
    console.log(`  reusing settlementToken ${REUSE_QUOTE}`);
    oracle = { address: REUSE_ORACLE, abi: getArtifact("contracts/test/MonoracleMock.sol/MonoracleMock.json").abi };
    base = { address: REUSE_BASE, abi: getArtifact("contracts/MockERC20.sol/MockERC20.json").abi };
    quote = { address: REUSE_QUOTE, abi: getArtifact("contracts/MockERC20.sol/MockERC20.json").abi };
  } else {
    oracle = await deploy("MonoracleMock", "contracts/test/MonoracleMock.sol/MonoracleMock.json");
    base = await deploy("MockERC20 LLM", "contracts/MockERC20.sol/MockERC20.json", ["Liuliumei", "LLM", 18]);
    quote = await deploy("MockERC20 HKD", "contracts/MockERC20.sol/MockERC20.json", ["HKD", "HKD", 18]);
  }
  const vault = await deploy("IRMarketVault", "contracts/IRMarketVault.sol/IRMarketVault.json", [
    oracle.address,
    base.address,
    quote.address,
    FEE_BPS,
  ]);

  const baseC = new ethers.Contract(base.address, base.abi, signer);
  const quoteC = new ethers.Contract(quote.address, quote.abi, signer);
  const oracleC = new ethers.Contract(oracle.address, oracle.abi, signer);
  const vaultC = new ethers.Contract(vault.address, vault.abi, signer);

  async function advanceBlocks(n) {
    if (canMine) {
      for (let i = 0; i < n; i++) await provider.send("evm_mine", []);
      return;
    }
    const start = await provider.getBlockNumber();
    while ((await provider.getBlockNumber()) < start + n) await sleep(400);
  }

  if (RUN_SMOKE) {
    console.log("\nSmoke test (full LONG lifecycle)...");
    const S0 = 100n * E18;
    const S1 = 150n * E18;
    const D = 100n * E18;

    await (await quoteC.mint(addr, 1_000_000n * E18)).wait();
    await (await baseC.mint(addr, 100_000n * E18)).wait();
    await (await quoteC.approve(vault.address, ethers.MaxUint256)).wait();
    await (await baseC.approve(oracle.address, ethers.MaxUint256)).wait();
    await (await quoteC.approve(oracle.address, ethers.MaxUint256)).wait();

    async function publish(priceWad) {
      const id = await oracleC.nextQuoteId();
      const bn = await provider.getBlockNumber();
      await (await oracleC.submitQuote(base.address, quote.address, E18, priceWad, bn + 10)).wait();
      await advanceBlocks(11);
      await (await oracleC.settleValidQuote(id)).wait();
    }

    await publish(S0);
    await (await vaultC.deposit(1000n * E18)).wait();
    await (await vaultC.openPosition(0, D, 10)).wait();
    await publish(S1);

    const payout = await vaultC.settlePosition.staticCall(0);
    await (await vaultC.settlePosition(0)).wait();
    assert.equal(payout, (1485n * E18) / 10n, "LONG payout at S1=1.5*S0 should be 148.5");

    const eq = await vaultC.equity();
    assert.equal(eq, (9515n * E18) / 10n, "LP equity after settle should be 951.5");

    const shares = await vaultC.shares(addr);
    const out = await vaultC.withdraw.staticCall(shares);
    await (await vaultC.withdraw(shares)).wait();
    assert.equal(out, (9515n * E18) / 10n, "LP withdrawal should be 951.5");

    console.log(
      `  payout=${ethers.formatEther(payout)}  equity=${ethers.formatEther(eq)}  withdraw=${ethers.formatEther(out)}`
    );
    console.log("  smoke test PASSED");
  }

  const info = {
    network: chainInfo(net.chainId).slug,
    chainId: Number(net.chainId),
    deployer: addr,
    oracle: oracle.address,
    priceBase: base.address,
    settlementToken: quote.address,
    vault: vault.address,
    feeBps: Number(FEE_BPS),
    reusedExistingStack: REUSE,
    txHashes: {
      oracle: oracle.txHash,
      priceBase: base.txHash,
      settlementToken: quote.txHash,
      vault: vault.txHash,
    },
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(rootDir, registryFile("vault", net.chainId)), JSON.stringify(info, null, 2));
  console.log(`\nSaved ${registryFile("vault", net.chainId)}`);
  console.log(`  ORACLE_ADDRESS=${oracle.address}`);
  console.log(`  PRICE_BASE=${base.address}`);
  console.log(`  SETTLEMENT_TOKEN=${quote.address}`);
  console.log(`  VAULT_ADDRESS=${vault.address}`);
}

main().catch((e) => {
  console.error("Deploy failed:", e.shortMessage || e.message);
  process.exitCode = 1;
});
