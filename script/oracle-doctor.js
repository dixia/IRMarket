/**
 * oracle-doctor.js — the guard against the upstream/fork Monoracle mix-up.
 *
 * Run it BEFORE every deploy and in CI. It checks BOTH:
 *   (1) the repo's own ABI copies agree and match the pinned upstream shape, and
 *   (2) the configured / known on-chain oracles' fingerprint (A upstream / B fork).
 * Exits 1 on any drift.
 *
 * Why this exists: the repo shipped TWO incompatible Monoracle ABIs, and a model hand-edited
 * them to match whichever oracle was in front of it — silently breaking the bot (submitQuote
 * selector) and the web (Quote field order). The rule: if the ABI and the oracle disagree,
 * MIGRATE THE ORACLE — never hand-patch the ABI.
 *
 * Usage:
 *   node script/oracle-doctor.js                     # repo ABIs + configured/known oracles
 *   node script/oracle-doctor.js 0xabc... 0xdef...   # also checks specific addresses
 */
import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const RPC = process.env.RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || "https://testnet-rpc.monad.xyz";
const CHAIN = Number(process.env.CHAIN_ID || process.env.NEXT_PUBLIC_CHAIN_ID || 10143);

// Pinned target = upstream build A. Change DELIBERATELY (and redeploy) if the target changes.
const EXPECTED_SUBMIT_SIG = "submitQuote(address,address,uint256,uint256,uint32)";
const EXPECTED_QUOTES_ORDER = ["provider","baseToken","quoteToken","baseAmount","quoteAmount","price","startSlot","expiryBlock","settledSlot","status"];
const EXPECTED_ERRORS = ["QuoteAmountTooSmall", "ExpiryTooFar"];

const SIG = {
  vs: "VERIFICATION_SLOTS()",
  maxvs: "MAX_VERIFICATION_SLOTS()",
  sub32: "submitQuote(address,address,uint256,uint256,uint32)",
  sub256: "submitQuote(address,address,uint256,uint256,uint256)",
};
const selector = (s) => ethers.id(s).slice(2, 10);

const KNOWN = {
  "0x0bc36e1ac475adef75f102deb1708be6e45aa16f": "upstream lazy-settlement build (IRMarket production, consumed)",
  "0x151286e6ca5f5ca20910de90c0dceaa9fd71f2c8": "upstream A (previous, ref build)",
  "0x807321100748d75a618e508de214123cb77c9f4d": "IRMarket pre-lazy production (rollback; identical bytes to ref build)",
  "0x1ababc60ca6950c94ea80f2f611ab06aaaad28c0": "older upstream (pre-cap legacy build; classifies unknown)",
  "0xf92a55d4e22456c987b3e7af2e3730b3f5022ccb": "older upstream (pre-cap legacy build; classifies unknown)",
  "0xb6523da6f177db25d766a27575624b3e1fe0a00e": "fork B (deployed, legacy prod)",
};

function loadAbi(rel) {
  const j = JSON.parse(fs.readFileSync(path.join(rootDir, rel), "utf8"));
  return j.abi || j;
}
function shape(abi) {
  const f = abi.find((x) => x.type === "function" && x.name === "submitQuote");
  const q = abi.find((x) => x.type === "function" && x.name === "quotes");
  const errs = new Set(abi.filter((x) => x.type === "error").map((x) => x.name));
  return {
    submitSig: f ? "submitQuote(" + f.inputs.map((i) => i.type).join(",") + ")" : null,
    quotesOrder: q ? q.outputs.map((c) => c.name) : null,
    missingErrors: EXPECTED_ERRORS.filter((e) => !errs.has(e)),
  };
}

let drift = false;

function checkRepoAbis() {
  console.log("== repo ABI copies ==");
  const files = ["abi/Monoracle.abi.json", "web/src/lib/abis/Monoracle.json"];
  const shapes = {};
  for (const rel of files) {
    const s = shape(loadAbi(rel));
    shapes[rel] = s;
    const ok = s.submitSig === EXPECTED_SUBMIT_SIG && JSON.stringify(s.quotesOrder) === JSON.stringify(EXPECTED_QUOTES_ORDER) && s.missingErrors.length === 0;
    console.log(`  ${rel}`);
    console.log(`    submitQuote: ${s.submitSig}   quotes: [${(s.quotesOrder || []).join(", ")}]   missingErrors: ${s.missingErrors.join(",") || "none"}`);
    console.log(`    matches pinned upstream A: ${ok ? "YES" : "NO  <-- DRIFT"}`);
    if (!ok) drift = true;
  }
  const [a, b] = files.map((f) => JSON.stringify(shapes[f]));
  const agree = a === b;
  console.log(`  the two copies agree: ${agree ? "YES" : "NO  <-- DRIFT (this is the bug that bit us)"}`);
  if (!agree) drift = true;
}

async function checkOracles(provider) {
  console.log("\n== on-chain oracles ==");
  const cli = process.argv.slice(2).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  const env = [process.env.ORACLE_ADDRESS, process.env.NEXT_PUBLIC_ORACLE_ADDRESS].filter(Boolean);
  const configured = [...new Set([...cli, ...env].map((a) => a.toLowerCase()))];
  const list = configured.length ? configured : Object.keys(KNOWN);
  const repoBuild = shape(loadAbi("abi/Monoracle.abi.json")).submitSig === EXPECTED_SUBMIT_SIG ? "A" : "B";
  if (!configured.length) console.log("  (no configured oracle; listing known deployments — informational)");

  for (const raw of list) {
    const addr = ethers.getAddress(raw);
    const code = (await provider.getCode(addr)).toLowerCase();
    if (code === "0x" || code === "") { console.log(`  ${addr}  (no code)`); continue; }
    const has = (s) => code.includes(selector(s));
    const vs = has(SIG.vs), sub32 = has(SIG.sub32), sub256 = has(SIG.sub256);
    const kind = vs && sub32 ? "A" : sub256 && !vs ? "B" : "unknown";
    const matches = repoBuild === kind;
    const enforced = configured.includes(raw);
    console.log(`  ${addr}${KNOWN[raw] ? `  (${KNOWN[raw]})` : ""}  -> ${kind}  | repo ABI(${repoBuild}) matches: ${matches ? "YES" : "NO"}${enforced ? "  <-- configured oracle MUST match" : "  (informational)"}`);
    if (enforced && !matches) drift = true;
  }
}

async function main() {
  console.log(`oracle-doctor  RPC ${RPC}  chainId ${CHAIN}\n`);
  checkRepoAbis();
  try {
    await checkOracles(new ethers.JsonRpcProvider(RPC, CHAIN));
  } catch (e) {
    console.log(`\n== on-chain oracles ==\n  RPC unreachable (${e.shortMessage || e.message}); skipped`);
  }
  console.log(drift ? "\nRESULT: DRIFT DETECTED (fix before deploy)" : "\nRESULT: ok");
  if (drift) process.exitCode = 1;
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exitCode = 1; });
