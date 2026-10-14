import fs from "fs";
import path from "path";
import { createPublicClient, http } from "viem";
import { anvil } from "viem/chains";
import { deployContracts } from "../helpers/deploy.ts";
import { createMarketShortExpiry } from "../helpers/market.ts";
import { submitQuote, settleQuote } from "../helpers/bot.ts";
import { mineBlocks } from "../helpers/mine.ts";

// Standalone deploy: same steps as tests/setup.ts, but runs under plain Node so the
// stack can be orchestrated persistently (anvil + next dev) for the video walkthrough.
const RPC = "http://127.0.0.1:8545";
const publicClient = createPublicClient({ chain: anvil, transport: http(RPC) });

// PR #6 points wagmi's chain config at Multicall3 (0xcA11…), which exists on Monad
// testnet but NOT on a fresh anvil. Batched reads would all fail, so place the real
// Multicall3 code (fetched from Monad testnet) at the canonical address.
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const mc3Bytecode = fs.readFileSync(path.resolve(import.meta.dirname, "..", "helpers", "multicall3-bytecode.txt"), "utf8").trim();
await publicClient.request({ method: "anvil_setCode", params: [MULTICALL3, mc3Bytecode] });
console.log("[deploy-stack] Multicall3 set at", MULTICALL3);

const webDir = path.resolve(import.meta.dirname, "..", "..");
const rootDir = path.resolve(webDir, "..");

const deployed = await deployContracts();

const marketId = await createMarketShortExpiry(
  deployed.market,
  deployed.baseToken,
  deployed.quoteToken,
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  500,
  100,
);
console.log(`[deploy-stack] marketId=${marketId}`);

const bn = await publicClient.getBlockNumber();
const quoteId = await submitQuote(
  deployed.oracle,
  deployed.baseToken,
  deployed.quoteToken,
  1n * 10n ** 18n,
  130n * 10n ** 18n,
  bn + 500n,
);
console.log(`[deploy-stack] seeded quoteId=${quoteId}`);

// Publish a settled canonical price for the vault (fresh timestamps avoid ExpiryMustBeFuture).
const cb = await publicClient.getBlockNumber();
const canonicalId = await submitQuote(
  deployed.oracle,
  deployed.baseToken,
  deployed.quoteToken,
  1n * 10n ** 18n,
  130n * 10n ** 18n,
  cb + 5n,
);
await mineBlocks(6);
await settleQuote(deployed.oracle, canonicalId);
console.log(`[deploy-stack] settled canonical price 130 (quoteId=${canonicalId})`);

fs.writeFileSync(
  path.join(webDir, ".env.local"),
  [
    `NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8545`,
    `NEXT_PUBLIC_CHAIN_ID=31337`,
    `NEXT_PUBLIC_ORACLE_ADDRESS=${deployed.oracle}`,
    `NEXT_PUBLIC_MARKET_ADDRESS=${deployed.market}`,
    `NEXT_PUBLIC_BASE_TOKEN=${deployed.baseToken}`,
    `NEXT_PUBLIC_QUOTE_TOKEN=${deployed.quoteToken}`,
    `NEXT_PUBLIC_VAULT_ADDRESS=${deployed.vault}`,
    `NEXT_PUBLIC_EXPIRY_SECONDS=300`,
    "",
  ].join("\n"),
);

fs.writeFileSync(
  path.join(webDir, "tests", "helpers", "addresses.json"),
  JSON.stringify({ ...deployed, marketId: marketId.toString() }, null, 2),
);

console.log("[deploy-stack] wrote .env.local and addresses.json");
console.log(`  VAULT: ${deployed.vault}`);
