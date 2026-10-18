/**
 * tools/backtest/premium-backtest.js — OFF-CHAIN backtest: BSM-priced vs 1%-flat premium.
 *
 * No contract changes, no on-chain writes, no keys. Reads ONLY:
 *   - deployment.json  (oracle address + base/quote tokens + deploy tx → start block)
 *   - process.env.RPC_URL  (pass via $env:RPC_URL; NEVER hardcode a key/URL in this file)
 *
 * What it does:
 *   1. Pull ALL Monoracle A-stack oracle logs from the oracle deploy block (from
 *      deployment.json txHashes.oracle receipt, else head−1,000,000) to head.
 *      Verified against this QuickNode endpoint: getLogs range limit = 1,000 blocks
 *      (500 OK / 5000 → "eth_getLogs is limited to a 1,000 range"; the "~100-block"
 *      note underestimates — we still stay ≤ ~1000), and JSON-RPC BATCHING (20
 *      eth_getLogs requests per HTTP POST) is supported → 472 wide requests fit in
 *      ~24 POSTs × 7 in flight ⇒ well under the ~4-min target (cap ~8 min).
 *      Two events per request, decoded + joined off-chain (DUAL-MODE settle join):
 *        QuoteSubmitted(uint256 indexed, address indexed, address indexed baseToken, ...)
 *          → topic0=0x54…, topic3=baseToken (pair attribution via quoteId!); also carries
 *            price + expiryBlock for the implicit path.
 *        QuoteSettledValid(uint256 indexed quoteId, uint256 settledPrice) → topic0=0xb65…
 *      A price counts as NVDA/HKD only if its quoteId was SUBMITTED with
 *      baseToken == deployment.json baseToken.
 *      DUAL-MODE: OLD oracle — a quote settles via an explicit settleValidQuote tx →
 *      QuoteSettledValid (mark at the settle block, price = settledPrice). NEW oracle
 *      (lazy settlement) — a quote is canonical once block.number > expiryBlock with NO
 *      settle tx; getLatestPrice derives it at read time, so a never-checkpointed quote's
 *      mark = its QuoteSubmitted price at its expiryBlock (= the on-chain settledSlot for
 *      an implicit settle). When several never-checkpointed quotes share one expiryBlock
 *      (restock + the final settlement quote) only the highest quoteId is canonical
 *      (getLatestPrice returns the newest matured valid quote), so implicit marks keep the
 *      highest id per (baseToken, expiryBlock) — a superseded restock quote drops out.
 *   2. Build NVDA-only price series [(block, WAD→float)], drop same-block repeats
 *      (keep last), dedupe consecutive identical prices.
 *   3. Frame each pair of consecutive NVDA settled points with Δt ≤ 1h as ONE SOLD ATM CALL:
 *        K = S_i, T = Δt_blocks × 0.3s / (365 × 86400)  (0.3 s/block).
 *      σ Vol estimation (see sigmaRound): per-sample log returns between consecutive
 *      NVDA settled marks Δt ≤ 30min; these are per-sample-interval returns whose mean
 *      interval is meanGapBlocks (blocks). Pricing vol at the round horizon Δt_i is the
 *      sqrt-of-time naturalization σ_T = std(r) × sqrt(Δt_i / meanGapBlocks). Annualized
 *      equivalent σ_ann = std(r) / sqrt(meanGapBlocks × 0.3s / yearSeconds) is computed
 *      for REFERENCE ONLY — never used for pricing. Priced with a SLIDING WINDOW of the
 *      last 24 completed samples at round open (fallback: all history before the round).
 *        BSM r=0: premium = S·Φ(d1) − K·Φ(d2); Φ via Abramowitz–Stegun 26.2.17
 *        (max abs error ~1e-6 — far below vol-estimation noise). ATM K=S ⇒ analytic form
 *        S·(2Φ(σ√T/2)−1), implemented through the general d1/d2 path.
 *   4. Normalize to the SAME traded notional both ways, explained:
 *        - Trader puts up a 100 HKD deposit; pool keeps 1% fee ⇒ effective notional
 *          N = 99 HKD; the CURRENT model charges flat 1 HKD (the fee spread).
 *        - BSM model charges premium × notional: units = 100 HKD / S_i NVDA-equivalents;
 *          per-unit premium in HKD ⇒ BSM premium HKD = units · premiumPerUnit
 *          = 100 · (premiumPerUnit / S_i) = 100 × premiumPct (ATM premiumPct).
 *        - Realized payout to the buyer at t_{i+1}: units · max(S_{i+1} − K, 0);
 *          pool cap applied: payout = min(payoutUncapped, 2N) = min(·, 198 HKD).
 *        - LP cash flow per round = premium − payout, for BSM-priced and flat books
 *          over the SAME rounds (rounds with no completed σ window are excluded from
 *          BOTH books and reported separately, so the comparison stays apples-to-apples).
 *   5. Sensitivity: σ × 0.5, σ × 1.5 on the same window σ and same payout book.
 *
 * Two-side book (2026-10-16 extension, dixia/IRMarket#11 review): the vault
 * sells BOTH sides of the same 100 HKD notional every round — the version this
 * file replaced replayed ONLY the CALL (LONG-buyer) book max(S1−S0,0), but the
 * capped-linear payoff the pool sells is put-like for SHORT positions. Per
 * round we now ALSO price/sell the PUT side against the SAME units (100/S_i):
 *   payoutPut = units · max(K − S1, 0), cap applied PER SIDE at min(·, 198)
 *   (= 2 × 99); put BSM premium via r=0 parity put = call − S + K, floored at
 *   0 (degenerate σ/T already returns the 0/floor case at ATM); MVP-flat
 *   charges the SAME 1 HKD (1% of 100) on the put side — SHORT pays the same
 *   fee spread. σ logic and the σ×0.5/σ×1.5 sensitivity apply to BOTH books
 *   identically (call and put are both ATM on K=S_i, so an annualized lift is
 *   symmetric). The CSV keeps every existing call column and its order and
 *   APPENDS: putPremiumBSM, putPremiumFlat, putPayout, putBSMPnL, putFlatPNL,
 *   bsmStraddlePremium, flatStraddlePremium, straddlePayout, straddleBSMPnL,
 *   straddleFlatPNL (straddle = call + put). The summary keeps the call-book
 *   block byte-for-byte comparable to the reviewed numbers and appends a
 *   "STRADDLE BOOK" section (§4/§5/Usage otherwise unchanged).
 *
 * Usage:  $env:RPC_URL = "<rpc>"; node tools/backtest/premium-backtest.js
 * Output: docs/design/lp-pool-premium-backtest-2026-10-16.csv + printed summary.
 */
import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const RPC = process.env.RPC_URL;
if (!RPC) {
  console.error("ERROR: set $env:RPC_URL (never hardcode it in this file).");
  process.exit(1);
}
const OUT_CSV = path.join(ROOT, "docs", "design", "lp-pool-premium-backtest-2026-10-16.csv");

// ---- constants -------------------------------------------------------------
const SECS_PER_BLOCK = 0.3; // Monad testnet, observed
const SECS_PER_YEAR = 365 * 24 * 3600;
const CHUNK = 1000; // per-request getLogs width (node limit verified: 1000 OK, 5000 → "limited to a 1,000 range")
const BATCH = 20; // JSON-RPC batch = this many eth_getLogs in ONE HTTP POST
const CONCURRENCY = 7; // HTTP POSTs in flight
const MAX_RUNTIME_MS = 8 * 60 * 1000; // hard cap ~8 min (documented target ~4)
const GAP_BREAK_BLOCKS = Math.round(2 * 3600 / SECS_PER_BLOCK); // 2h ≈ 24000 blocks
const SAMPLE_MAX_BLOCKS = Math.round(30 * 60 / SECS_PER_BLOCK); // 30min = 6000 blocks
const ROUND_MAX_BLOCKS = Math.round(60 * 60 / SECS_PER_BLOCK); // 1h = 12000 blocks
const START_HINT_MIN = 70990000; // documented oracle live floor (2026-10-14T14:30Z)
const NOTIONAL = 100; // HKD deposit
const FEE = 0.01; // 1% flat fee
const N_TRADE = NOTIONAL * (1 - FEE); // 99 HKD effective notional
const FLAT_PREMIUM = NOTIONAL * FEE; // 1 HKD
const PAYOUT_CAP = 2 * N_TRADE; // 198 HKD pool cap (2N)
const WINDOW_RETURNS = 24; // sliding window for σ

const deps = JSON.parse(fs.readFileSync(path.join(ROOT, "deployment.json"), "utf8"));
// Fresh-clone reproducibility: env overrides win over the (gitignored) deployment.json.
//   $env:ORACLE_ADDRESS / $env:BASE_TOKEN / $env:QUOTE_TOKEN / $env:START_BLOCK
const ORACLE = process.env.ORACLE_ADDRESS || deps.oracle;
const NVDA_TOKEN = process.env.BASE_TOKEN || deps.baseToken; // NVDA per deployment registry
const QUOTE_TOKEN_ENV = process.env.QUOTE_TOKEN || deps.quoteToken;
if (process.env.ORACLE_ADDRESS) {
  console.log("config: ORACLE/BASE/QUOTE from env overrides (fresh-clone mode)");
} else {
  console.log("config: ORACLE/BASE/QUOTE from gitignored deployment.json — set $env:ORACLE_ADDRESS, $env:BASE_TOKEN, $env:QUOTE_TOKEN to run on a fresh clone");
}
const provider = new ethers.JsonRpcProvider(RPC, Number(process.env.CHAIN_ID || deps.chainId || 10143), { staticNetwork: true });
const T_SETTLED = "0xb6534e1b0a46120b0ef870d3b6214387a8dec3c83d1d1dcc32ea4f11ac28ba6c";
const T_SUBMITTED = ethers.id("QuoteSubmitted(uint256,address,address,address,uint256,uint256,uint256,uint32,uint32)");
const iface = new ethers.Interface([
  "event QuoteSettledValid(uint256 indexed quoteId, uint256 settledPrice)",
  "event QuoteSubmitted(uint256 indexed quoteId, address indexed provider, address indexed baseToken, address quoteToken, uint256 baseAmount, uint256 quoteAmount, uint256 price, uint32 startSlot, uint32 expiryBlock)",
]);

// ---- normal CDF, Abramowitz–Stegun 26.2.17 (~1e-6 max abs error) -----------
function Phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly =
    t *
    (0.319381530 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pdf = Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);
  return x >= 0 ? 1 - pdf * poly : pdf * poly;
}

// BSM r=0 European call
function bsmCall(S, K, sigma, T) {
  if (sigma <= 0 || T <= 0) return Math.max(S - K, 0); // degenerate → intrinsic
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (sigma * sigma * T) / 2) / sq;
  const d2 = d1 - sq;
  return S * Phi(d1) - K * Phi(d2);
}

// BSM r=0 European put via parity: put = call − S + K, floored at 0
// (degenerate σ/T: bsmCall returns intrinsic max(S−K,0) ⇒ put = max(0, 0)/intrinsic correctly)
function bsmPut(S, K, sigma, T) {
  return Math.max(bsmCall(S, K, sigma, T) - S + K, 0);
}

// ---- 1. chunked log retrieval (JSON-RPC batched) ---------------------------
// QuickNode wants hex-QUANTITY block refs; raw provider.send() does NOT hexlify JSON numbers.
// Batched POSTs: BATCH getLogs per HTTP request keeps total wall clock under the ~8 min cap.
const hexify = (n) => "0x" + n.toString(16);
function rpcBody(f, t, id) {
  const q = { address: ORACLE, topics: [[T_SETTLED, T_SUBMITTED]], fromBlock: hexify(f), toBlock: hexify(t) };
  return { jsonrpc: "2.0", id, method: "eth_getLogs", params: [q] };
}
async function postBatch(body) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function main() {
  const t0 = Date.now();
  const head = Number(await provider.getBlockNumber());
  // start block: $env:START_BLOCK override > oracle deploy tx receipt; fallback head−1,000,000
  let start;
  if (process.env.START_BLOCK) {
    start = Number(process.env.START_BLOCK);
    console.log(`start=${start} from $env:START_BLOCK`);
  } else
  try {
    const rc = await provider.getTransactionReceipt(deps.txHashes.oracle);
    if (!rc) throw new Error("receipt null");
    start = Number(rc.blockNumber);
    console.log(`start=${start} from deployment.json oracle tx receipt`);
  } catch {
    start = Math.max(START_HINT_MIN, head - 1_000_000);
    console.log(`start=${start} (fallback: head−1,000,000 floored at ${START_HINT_MIN})`);
  }
  console.log(`head=${head}, span=${head - start} blocks (~${(((head - start) * SECS_PER_BLOCK) / 86400).toFixed(1)} days)`);
  console.log(`two events per request (QuoteSettledValid + QuoteSubmitted) — DUAL-MODE settle join (explicit QuoteSettledValid ∪ implicit matured-at-expiryBlock); NVDA attribution via quoteId↔baseToken; width/req=${CHUNK}, ${BATCH} req/POST, ${CONCURRENCY} POSTs in flight`);

  // job list: 1000-block requests, gathered into batches of BATCH posts
  const chunks = [];
  for (let f = start; f <= head; f += CHUNK) chunks.push({ f, t: Math.min(f + CHUNK - 1, head) });
  const rawLogs = [];
  const failedChunks = [];
  let done = 0;
  let nextBatch = 0;
  const batches = [];
  for (let i = 0; i < chunks.length; i += BATCH) batches.push(chunks.slice(i, i + BATCH));
  async function worker() {
    while (true) {
      if (Date.now() - t0 > MAX_RUNTIME_MS) return;
      const bi = nextBatch++;
      if (bi >= batches.length) return;
      const batch = batches[bi];
      const body = batch.map((c, j) => rpcBody(c.f, c.t, j));
      try {
        const res = await postBatch(body);
        for (const item of res) {
          const c = batch[item.id];
          if (!c || item.id == null) continue;
          if (item.error) failedChunks.push({ ...c, tries: 1 });
          else { rawLogs.push(...(item.result || [])); done++; }
        }
      } catch {
        for (const c of batch) failedChunks.push({ ...c, tries: 1 });
      }
      if (done % 250 === 0 && done > 0) console.log(`  ${done}/${chunks.length} requests, ${rawLogs.length} raw events, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  // retry-once failed chunks individually (same wide width), sequentially small batches
  if (failedChunks.length && Date.now() - t0 < MAX_RUNTIME_MS) {
    const retry = failedChunks.splice(0, failedChunks.length);
    console.log(`retrying ${retry.length} failed chunk(s) once...`);
    const id0 = BigInt(Date.now());
    const body = retry.map((c, j) => rpcBody(c.f, c.t, Number((id0 + BigInt(j)) & 0x7fffffff)));
    try {
      const res = await postBatch(body);
      for (const item of res) {
        if (item.error || !Array.isArray(item.result)) failedChunks.push(retry[Number(item.id) - Number(id0)]);
        else { rawLogs.push(...item.result); done++; }
      }
    } catch {
      failedChunks.push(...retry);
    }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`getLogs done: ${rawLogs.length} raw events from ${done}/${chunks.length} requests (failed=${failedChunks.length} of ${Math.ceil((head - start + 1) / CHUNK)} total), ${elapsed}s`);
  if (failedChunks.length > 0) console.log(`WARNING: ${failedChunks.length} chunk(s) unrecoverable → small holes possible in the series.`);

  // ---- 2. decode + join submitted↔settled by quoteId (DUAL-MODE) ------------
  // OLD oracle: a quote settles via an explicit settleValidQuote tx → QuoteSettledValid
  // (mark at the settle block, price = settledPrice). NEW oracle (lazy settlement): a
  // quote is canonical once block.number > expiryBlock with NO settle tx; getLatestPrice
  // derives it at read time, so a never-checkpointed quote's mark = its QuoteSubmitted
  // price at its expiryBlock (= the on-chain settledSlot for an implicit settle). Each
  // quote takes the EXPLICIT path if a QuoteSettledValid exists, else the IMPLICIT path —
  // but only for a round that has NO explicit checkpoint: once a round carries a
  // QuoteSettledValid that quote is the canonical mark, and any never-checkpointed quote
  // in the same round (a restock, possibly vetoed) is superseded, not canonical. When a
  // round has no checkpoint at all, its never-checkpointed quotes collapse to the highest
  // quoteId (getLatestPrice returns the newest matured valid quote = the final settlement
  // quote).
  const submitted = new Map(); // quoteId → { base, price (WAD), expiryBlock }
  const duplicates = new Map(); // quoteId → count of conflicts
  for (const lg of rawLogs) {
    if (lg.topics[0] !== T_SUBMITTED) continue;
    const ev = iface.parseLog({ topics: lg.topics, data: lg.data });
    const id = ev.args.quoteId.toString();
    const base = ev.args.baseToken.toLowerCase();
    if (submitted.has(id) && submitted.get(id).base !== base) duplicates.set(id, (duplicates.get(id) || 1) + 1);
    else submitted.set(id, { base, price: BigInt(ev.args.price.toString()), expiryBlock: Number(ev.args.expiryBlock) });
  }
  if (duplicates.size) console.log(`WARNING: ${duplicates.size} quoteId(ies) submitted under MULTIPLE tokens (storage slot reuse) — attribution ambiguous, excluded.`);
  const settledById = new Map(); // quoteId → { block, wad } — explicit QuoteSettledValid checkpoints
  for (const lg of rawLogs) {
    if (lg.topics[0] !== T_SETTLED) continue;
    const ev = iface.parseLog({ topics: lg.topics, data: lg.data });
    settledById.set(ev.args.quoteId.toString(), { block: Number(lg.blockNumber), wad: BigInt(ev.args.settledPrice.toString()) });
  }
  // rounds that carry an explicit checkpoint: their canonical mark is that QuoteSettledValid,
  // so never-checkpointed quotes in the SAME round are superseded/vetoed, not canonical.
  const explicitRounds = new Set(); // `${base}@${expiryBlock}`
  for (const [id, sub] of submitted) {
    if (settledById.has(id)) explicitRounds.add(`${sub.base}@${sub.expiryBlock}`);
  }
  // implicit settle: per (baseToken, expiryBlock) with NO explicit checkpoint, the highest
  // never-checkpointed quoteId is canonical (getLatestPrice returns the newest matured valid quote)
  const implicitWinner = new Map(); // `${base}@${expiryBlock}` → highest never-checkpointed quoteId
  for (const [id, sub] of submitted) {
    if (settledById.has(id)) continue; // explicit path already covers it
    const key = `${sub.base}@${sub.expiryBlock}`;
    if (explicitRounds.has(key)) continue; // round already checkpointed → never-checkpointed quotes here are superseded/vetoed
    const prev = implicitWinner.get(key);
    if (prev === undefined || BigInt(id) > BigInt(prev)) implicitWinner.set(key, id);
  }
  const marksRaw = [];
  for (const [id, sub] of submitted) {
    const base = sub.base;
    const pair = base === NVDA_TOKEN.toLowerCase() ? "NVDA" : "other";
    const settled = settledById.get(id);
    if (settled) {
      // EXPLICIT checkpoint (old deployment / the bot's optional checkpoint): settle-tx block.
      marksRaw.push({ block: settled.block, wad: settled.wad, quoteId: id, pair });
    } else if (sub.expiryBlock < head && implicitWinner.get(`${base}@${sub.expiryBlock}`) === id) {
      // IMPLICIT settlement (new deployment, never checkpointed): canonical once
      // block.number > expiryBlock — only once head has passed it (expiryBlock < head).
      marksRaw.push({ block: sub.expiryBlock, wad: sub.price, quoteId: id, pair, implicit: true });
    }
    // else: a superseded (non-canonical) never-checkpointed quote — dropped.
  }
  const other = marksRaw.filter((m) => m.pair !== "NVDA").length;
  const nImplicit = marksRaw.filter((m) => m.implicit).length;
  console.log(`attribution: ${marksRaw.length} marks mapped (explicit=${marksRaw.length - nImplicit} QuoteSettledValid, implicit=${nImplicit} matured-at-expiryBlock; NVDA=${marksRaw.length - other}, other-pair=${other}; submitted-known=${submitted.size}${duplicates.size ? `, ambiguous=${duplicates.size}` : ""})`);

  // NVDA series: sort, same-block repeats → keep last, then dedupe consecutive identical prices
  const nvdaRaw = marksRaw.filter((m) => m.pair === "NVDA").sort((a, b) => a.block - b.block);
  const series = [];
  for (const p of nvdaRaw) {
    if (series.length && series.at(-1).block === p.block) series[series.length - 1] = p;
    else series.push(p);
  }
  const marks = [];
  for (const p of series) {
    if (marks.length && marks.at(-1).wad === p.wad) marks[marks.length - 1] = p; // same price, later block → advance
    else marks.push(p);
  }
  marks.forEach((m) => (m.S = Number(m.wad) / 1e18));
  if (marks.length < 2) {
    console.log(`\nDATA TOO SPARSE FOR ANY CONCLUSION: ${marks.length} deduped NVDA settled mark(s) after attribution.`);
    console.log(`CSV written: ${OUT_CSV} (0 data rows + header) — nothing useful.`);
    return;
  }
  console.log(`NVDA series: ${marks.length} deduped marks, S range [${Math.min(...marks.map((m) => m.S)).toFixed(3)}, ${Math.max(...marks.map((m) => m.S)).toFixed(3)}] HKD`);

  // data-quality: >2h continuation breaks (still usable for vol, noted)
  const gaps = [];
  for (let i = 1; i < marks.length; i++) {
    const db = marks[i].block - marks[i - 1].block;
    if (db > GAP_BREAK_BLOCKS) gaps.push({ from: marks[i - 1].block, to: marks[i].block, hours: (db * SECS_PER_BLOCK) / 3600 });
  }
  for (const g of gaps) console.log(`GAP-BREAK >2h: blocks ${g.from} → ${g.to} (${g.hours.toFixed(1)}h) — usable for vol, treated as continuation break for round framing`);

  // vol samples: consecutive NVDA marks with Δt ≤ 30min (per-spec primary set).
  // Observed reality: NVDA rounds settle ~28–33 min apart, so the 30-min cap leaves
  // nothing to price with early on → documented fallback set with Δt ≤ 60min (same
  // band as the rounds themselves), used for a round ONLY when the 30-min set has
  // <2 completed samples at round open; flagged as sigmaFallback=null→"fallback60".
  const samples30 = [], samples60 = [];
  for (let i = 1; i < marks.length; i++) {
    const gap = marks[i].block - marks[i - 1].block;
    if (gap <= 0 || gap > ROUND_MAX_BLOCKS) continue; // exclude gap-breaks and >1h holes
    const r = Math.log(marks[i].S / marks[i - 1].S);
    const s = { block: marks[i].block, gapBlocks: gap, r };
    samples60.push(s);
    if (gap <= SAMPLE_MAX_BLOCKS) samples30.push(s);
  }

  // ---- 3. sigma: sliding-window naturalization (see header comment) ----------
  function sigmaRound(endBlock, dtBlocks, windowed) {
    for (const pool0 of [{ s: samples30, label: null }, { s: samples60, label: "fallback60" }]) {
      const pool = pool0.s.filter((x) => x.block <= endBlock);
      if (pool.length < 2) continue;
      const use = windowed && pool.length > WINDOW_RETURNS ? pool.slice(-WINDOW_RETURNS) : pool;
      const mean = use.reduce((a, x) => a + x.r, 0) / use.length;
      const std = Math.sqrt(use.reduce((a, x) => a + (x.r - mean) ** 2, 0) / (use.length - 1));
      const meanGap = use.reduce((a, x) => a + x.gapBlocks, 0) / use.length;
      if (!(meanGap > 0)) continue;
      return { sigmaT: std * Math.sqrt(dtBlocks / meanGap), std, meanGapBlocks: meanGap, nSample: use.length, sampleSet: pool0.label };
    }
    return null;
  }

  // ---- 4. rounds + backtest --------------------------------------------------
  // Units discipline (critical): sigmaRound returns σ as a PROPORTIONAL std of
  // ln(S_T/S_0) over the round horizon (the naturalized sqrt-of-time quantity).
  // bsmCall(S,K,σ,T) expects an ANNUALIZED σ ⇒ convert: σ_ann = σ_prop / √T_years.
  // Equivalent shortcut used here: ATM premium% = 2·Φ(σ_prop/2) − 1 via
  // bsmCall(S0, S0, σ_prop/√T, T). Multiplying σ_prop by {0.5,1.5} in the
  // sensitivity pass is operationally identical to lifting annualized IV.
  const priceOption = (S0, sigmaProp, T) => {
    if (!sigmaProp || !isFinite(sigmaProp) || sigmaProp <= 0 || !(T > 0)) return null;
    const perUnit = bsmCall(S0, S0, sigmaProp / Math.sqrt(T), T); // ATM: K=S0
    const hkd = (perUnit / S0) * NOTIONAL; // = 100 × premiumPct (same notional as flat)
    return isFinite(hkd) ? hkd : null;
  };
  // PUT side, same units/notional transform. ATM K=S0 ⇒ parity put = call − S0 + S0 = call,
  // but priced through bsmPut explicitly so the put-floor/parity semantics stay visible.
  const pricePut = (S0, sigmaProp, T) => {
    if (!sigmaProp || !isFinite(sigmaProp) || sigmaProp <= 0 || !(T > 0)) return null;
    const perUnit = bsmPut(S0, S0, sigmaProp / Math.sqrt(T), T); // ATM: K=S0
    const hkd = (perUnit / S0) * NOTIONAL;
    return isFinite(hkd) ? hkd : null;
  };
  const rows = [];
  for (let i = 1; i < marks.length; i++) {
    const dt = marks[i].block - marks[i - 1].block;
    if (dt <= 0 || dt > ROUND_MAX_BLOCKS) continue; // one round = consecutive marks ≤ 1h apart
    const S0 = marks[i - 1].S, S1 = marks[i].S;
    const units = NOTIONAL / S0; // 100 HKD notional
    const payoutUncapped = units * Math.max(S1 - S0, 0);
    const payout = Math.min(payoutUncapped, PAYOUT_CAP); // pool cap = 2N = 198 HKD
    const payoutPutUncapped = units * Math.max(S0 - S1, 0); // same units, SHORT-buyer side
    const payoutPut = Math.min(payoutPutUncapped, PAYOUT_CAP); // cap applied PER SIDE (198 each)
    const sig = sigmaRound(marks[i - 1].block, dt, true);
    const sigAllHist = sigmaRound(marks[i - 1].block, dt, false) ?? sig;
    const T = (dt * SECS_PER_BLOCK) / SECS_PER_YEAR;
    const flatPNL = FLAT_PREMIUM - payout;
    const flatPutPNL = FLAT_PREMIUM - payoutPut; // MVP-flat: same 1 HKD on the put side
    const wPrem = priceOption(S0, sig?.sigmaT ?? null, T);
    const aPrem = priceOption(S0, sigAllHist?.sigmaT ?? null, T);
    const wPutPrem = pricePut(S0, sig?.sigmaT ?? null, T);
    rows.push({
      i: rows.length + 1, blockStart: marks[i - 1].block, blockEnd: marks[i].block,
      S0, S1, dtBlocks: dt, T,
      sigmaWindow: sig?.sigmaT ?? null, sigmaAll: sigAllHist?.sigmaT ?? null,
      bsmPremiumHKD_w: wPrem, bsmPremiumHKD_a: aPrem, flatPremiumHKD: FLAT_PREMIUM,
      payoutHKD: payout, payoutUncappedHKD: payoutUncapped,
      bsmPNL_w: wPrem === null ? -payout : wPrem - payout, // unpriced round: sold at 0 → full payout loss
      bsmPNL_a: aPrem === null ? -payout : aPrem - payout, flatPNL,
      // put side + straddle (call + put of the SAME notional)
      putPremiumBSM_w: wPutPrem, putFlatPremiumHKD: FLAT_PREMIUM,
      putPayoutHKD: payoutPut, putPayoutUncappedHKD: payoutPutUncapped,
      putBSMPNL_w: wPutPrem === null ? -payoutPut : wPutPrem - payoutPut,
      putFlatPNL: flatPutPNL,
      straddlePremiumBSM_w: (wPrem ?? 0) + (wPutPrem ?? 0),
      straddleFlatPremiumHKD: 2 * FLAT_PREMIUM,
      straddlePayoutHKD: payout + payoutPut, // one side is always 0 at ATM ⇒ = capped units·|S1−S0|
      straddleBSMPNL_w: (wPrem === null ? -payout : wPrem - payout) + (wPutPrem === null ? -payoutPut : wPutPrem - payoutPut),
      straddleFlatPNL: flatPNL + flatPutPNL,
      nSampleWin: sig?.nSample ?? 0,
      sigmaAnnWin: sig ? sig.std / Math.sqrt((sig.meanGapBlocks * SECS_PER_BLOCK) / SECS_PER_YEAR) : NaN,
    });
  }
  const noSigma = rows.filter((r) => r.bsmPremiumHKD_w === null).length;

  // ---- CSV (headline = sliding-window σ) ------------------------------------
  const csvLines = ["i,blockStart,blockEnd,S0,S1,dtBlocks,sigmaUsed,bsmPremiumHKD,flatPremiumHKD,payoutHKD(lpCapped),bsmPNL,flatPNL,putPremiumBSM,putPremiumFlat,putPayout,putBSMPnL,putFlatPNL,bsmStraddlePremium,flatStraddlePremium,straddlePayout,straddleBSMPnL,straddleFlatPNL"];
  for (const r of rows) {
    const n6 = (x, d = 6) => (x === null || x === undefined || (typeof x === "number" && !isFinite(x)) ? "" : x.toFixed(d));
    csvLines.push([r.i, r.blockStart, r.blockEnd, r.S0.toFixed(6), r.S1.toFixed(6), r.dtBlocks, r.sigmaWindow ? r.sigmaWindow.toPrecision(6) : "", r.bsmPremiumHKD_w?.toFixed(6) ?? "", r.flatPremiumHKD.toFixed(4), r.payoutHKD.toFixed(6), r.bsmPNL_w.toFixed(6), r.flatPNL.toFixed(6), r.putPremiumBSM_w?.toFixed(6) ?? "", r.putFlatPremiumHKD.toFixed(4), r.putPayoutHKD.toFixed(6), r.putBSMPNL_w.toFixed(6), r.putFlatPNL.toFixed(6), r.straddlePremiumBSM_w.toFixed(6), r.straddleFlatPremiumHKD.toFixed(4), r.straddlePayoutHKD.toFixed(6), r.straddleBSMPNL_w.toFixed(6), r.straddleFlatPNL.toFixed(6)].join(","));
  }
  fs.mkdirSync(path.dirname(OUT_CSV), { recursive: true });
  fs.writeFileSync(OUT_CSV, csvLines.join("\n") + "\n");

  // ---- summary ------------------------------------------------------------
  const wPriced = rows.filter((r) => r.bsmPremiumHKD_w !== null);
  const wPrem = wPriced.reduce((a, r) => a + r.bsmPremiumHKD_w, 0);
  const wPayout = wPriced.reduce((a, r) => a + r.payoutHKD, 0);
  const wPNL = wPriced.reduce((a, r) => a + r.bsmPNL_w, 0);
  const flatSame = wPriced.reduce((a, r) => a + FLAT_PREMIUM, 0);
  const flatSamePNL = flatSame - wPayout;
  const payoutTotal = rows.reduce((a, r) => a + r.payoutHKD, 0);
  const flatAllTotal = rows.reduce((a, r) => a + FLAT_PREMIUM, 0);
  const flatAllPNL = flatAllTotal - payoutTotal;
  const aPriced = rows.filter((r) => r.bsmPremiumHKD_a !== null);
  const aPrem = aPriced.reduce((a, r) => a + r.bsmPremiumHKD_a, 0);
  const aPNL = aPriced.reduce((a, r) => a + r.bsmPNL_a, 0);
  const worst = (arr) => (arr.length ? Math.min(...arr) : NaN);
  const worstW = worst(wPriced.map((r) => r.bsmPNL_w));
  const worstFlat = worst(wPriced.map((r) => r.flatPNL));
  const worstA = worst(aPriced.map((r) => r.bsmPNL_a));
  const beatsW = wPriced.filter((r) => r.payoutHKD > r.bsmPremiumHKD_w).length;
  const beatsFlat = wPriced.filter((r) => r.payoutHKD > FLAT_PREMIUM).length;

  const meanSigmaT = wPriced.length ? wPriced.reduce((a, r) => a + r.sigmaWindow, 0) / wPriced.length : 0;
  const annRows = wPriced.filter((r) => isFinite(r.sigmaAnnWin));
  const meanSigmaAnn = annRows.length ? annRows.reduce((a, r) => a + r.sigmaAnnWin, 0) / annRows.length : 0;
  const dtMinutes = rows.map((r) => (r.dtBlocks * SECS_PER_BLOCK) / 60);
  const dtMedian = dtMinutes.length ? [...dtMinutes].sort((a, b) => a - b)[Math.floor(dtMinutes.length / 2)] : NaN;
  const dtsIn20to60blocks = rows.filter((r) => r.dtBlocks >= 20 && r.dtBlocks <= 60).length;
  const dtsIn20to60min = dtMinutes.filter((d) => d >= 20 && d <= 60).length;

  // sensitivity σ ×{0.5, 1.5} (headline window σ, same payout book)
  function sens(mult) {
    let prem = 0, pnl = 0, bad = 0;
    for (const r of wPriced) {
      const hkd = priceOption(r.S0, r.sigmaWindow * mult, r.T); // σ lift applied identically in proportional space
      if (hkd === null) { bad++; continue; }
      prem += hkd;
      pnl += hkd - r.payoutHKD;
    }
    return { mult, prem, pnl, bad };
  }
  const s05 = sens(0.5), s10 = { mult: 1, prem: wPrem, pnl: wPNL, bad: 0 }, s15 = sens(1.5);

  // STRADDLE BOOK (call + put of the same notional) — window24 σ headline, wPriced subset
  // (BSM and flat compared over the SAME priced rounds, apples-to-apples with [1]).
  const stPremB = wPriced.reduce((a, r) => a + r.straddlePremiumBSM_w, 0);
  const stPayout = wPriced.reduce((a, r) => a + r.straddlePayoutHKD, 0);
  const stPNLB = wPriced.reduce((a, r) => a + r.straddleBSMPNL_w, 0);
  const stPremF = wPriced.length * 2 * FLAT_PREMIUM;
  const stPNLF = wPriced.reduce((a, r) => a + r.straddleFlatPNL, 0);
  const worstStB = worst(wPriced.map((r) => r.straddleBSMPNL_w));
  const worstStF = worst(wPriced.map((r) => r.straddleFlatPNL));
  // σ×{0.5,1.5} on BOTH sides (ATM: BSM put = call by parity, so the straddle is 2×Call)
  function sensStraddle(mult) {
    let prem = 0, pnl = 0, bad = 0;
    for (const r of wPriced) {
      const call = priceOption(r.S0, r.sigmaWindow * mult, r.T);
      const put = pricePut(r.S0, r.sigmaWindow * mult, r.T);
      if (call === null || put === null) { bad++; continue; }
      prem += call + put;
      pnl += call + put - r.straddlePayoutHKD;
    }
    return { mult, prem, pnl, bad };
  }
  const st05 = sensStraddle(0.5), st10 = sensStraddle(1), st15 = sensStraddle(1.5);
  // reconciliation: per-row straddlePayout = capped call payout + capped put payout (one side ≡ 0 at ATM)
  const reconSt = wPriced.reduce((a, r) => a + r.straddlePayoutHKD - r.payoutHKD - r.putPayoutHKD, 0);

  // reconciliation check
  const reconBSM = rows.reduce((a, r) => a + r.bsmPNL_w, 0);
  const reconFlat = rows.reduce((a, r) => a + r.flatPNL, 0);
  const reconBSMSame = wPriced.reduce((a, r) => a + r.bsmPNL_w, 0);
  const reconFlatSame = wPriced.reduce((a, r) => a + r.flatPNL, 0);

  // ---- print ---------------------------------------------------------------
  console.log(`
==================== SUMMARY ====================`);
  console.log(`total rounds (consecutive NVDA settled marks, Δt ≤ 1h): ${rows.length}`);
  console.log(`  Δt minutes: median=${dtMedian.toFixed(2)}  rounds with Δt in [20,60] MIN=${dtsIn20to60min}  literal Δt in [20,60] blocks=${dtsIn20to60blocks}`);
  console.log(`  continuous coverage: ${(((rows.length / (marks.length - 1)) * 100) || 0).toFixed(1)}% of consecutive-mark pairs (rest = >2h gap breaks or >1h)`);
  console.log(`  gap breaks >2h: ${gaps.length}${gaps.length ? " (see GAP-BREAK lines above)" : ""} | no-σ rounds: ${noSigma} (excluded from both books; payouts there = ${(payoutTotal - wPayout).toFixed(2)} HKD)`);
  console.log(`mean σ per round (window24, naturalized to round horizon): ${(meanSigmaT * 100).toFixed(4)}% per round | mean annualized equivalent (reference): ${(meanSigmaAnn * 100).toFixed(1)}%`);

  console.log(`
[1] BOOKS: BSM-priced (window24 σ) vs 1%-flat, same ${NOTIONAL} HKD notional, SAME ${wPriced.length} rounds:`);
  console.log(`  total BSM premium = ${wPrem.toFixed(2)} HKD vs total flat premium = ${flatSame.toFixed(2)} HKD`);
  console.log(`  total capped payout (same rounds) = ${wPayout.toFixed(2)} HKD — charged against BOTH books (one sold book)`);
  console.log(`  BSM book net PnL = ${wPNL.toFixed(2)} HKD   |   flat book net PnL = ${flatSamePNL.toFixed(2)} HKD   (flat over ALL ${rows.length} rounds: ${flatAllPNL.toFixed(2)} HKD)`);
  console.log(`  worst single-round book loss: BSM ${worstW.toFixed(2)} / flat ${worstFlat.toFixed(2)} | rounds payout>BSM premium: ${beatsW}/${wPriced.length} (payout>flat premium: ${beatsFlat}/${wPriced.length})`);

  console.log(`
[2] SENSITIVITY (window24 σ × m, same payout book):`);
  for (const s of [s05, s10, s15]) {
    console.log(`  σ×${s.mult}: premium=${s.prem.toFixed(2)} HKD  net PnL=${s.pnl.toFixed(2)} HKD${s.bad ? `  (${s.bad} row(s) unpriceable → skipped)` : ""}`);
  }

  console.log(`
[3] BOOK: BSM-priced ALL-HISTORY σ (variant):`);
  console.log(`  premium=${aPrem.toFixed(2)} HKD  net PnL=${aPNL.toFixed(2)} HKD  worst=${worstA.toFixed(2)} HKD (${aPriced.length} rounds priced)`);

  console.log(`
[3b] STRADDLE BOOK (pool sells CALL **and** PUT of the SAME ${NOTIONAL} HKD notional/round, same ${wPriced.length} priced rounds):`);
  console.log(`  total straddle BSM premium = ${stPremB.toFixed(2)} HKD (call ${wPrem.toFixed(2)} + put ${(stPremB - wPrem).toFixed(2)}) vs total straddle flat premium = ${stPremF.toFixed(2)} HKD (${FLAT_PREMIUM.toFixed(2)}/side × 2)`);
  console.log(`  total straddle capped payout (same rounds) = ${stPayout.toFixed(2)} HKD — charged against BOTH books`);
  console.log(`  straddle BSM net PnL = ${stPNLB.toFixed(2)} HKD   |   straddle flat net PnL = ${stPNLF.toFixed(2)} HKD`);
  console.log(`  worst single-round straddle loss: BSM ${worstStB.toFixed(2)} / flat ${worstStF.toFixed(2)} HKD`);
  console.log(`  σ-sensitivity (window24 ×m, both sides):`);
  for (const s of [st05, st10, st15]) {
    console.log(`    σ×${s.mult}: straddle premium=${s.prem.toFixed(2)} HKD  net PnL=${s.pnl.toFixed(2)} HKD${s.bad ? `  (${s.bad} row(s) unpriceable → skipped)` : ""}`);
  }
  console.log(`  reconciliation: Σ(straddlePayout − callPayout − putPayout) over priced rounds = ${reconSt.toFixed(6)} (0 expected: at ATM one side is always 0, cap is per side); printed straddle totals = Σ per-row straddleBSMPnL(${stPNLB.toFixed(2)}) / straddleFlatPnL(${stPNLF.toFixed(2)}) over the same ${wPriced.length} rows.`);
  console.log(`  honest note: LONG and SHORT sides hedge each other by construction — at ATM exactly one side finishes ITM, so straddlePayout = units·|S1−S0| (capped). The straddle book's PnL is therefore ± a small drift/vol term around −(realized |move| − charged premium), NOT the deep-loss tail the call-only book showed; with flat pricing it converges to ≈ 2×1 HKD fees plus strike-adjacent noise (payout tiny when |S1−S0| is small relative to S0). Treat per-round magnitudes as indicative only.`);

  console.log(`
reconciliation: Σ per-round bsmPNL(all rows) = ${reconBSM.toFixed(2)} = Σ priced(${reconBSMSame.toFixed(2)}) + Σ unpriced(${(reconBSM - reconBSMSame).toFixed(2)}); Σ per-round flatPNL(all rows) = ${reconFlat.toFixed(2)}; printed totals reconcile when: priced-only ${reconBSMSame.toFixed(2)} == [1] BSM net PnL ${wPNL.toFixed(2)} and all-rounds flat ${reconFlat.toFixed(2)} == (flat all ${flatAllTotal.toFixed(2)} − payout all ${payoutTotal.toFixed(2)}).`);

  // sparsity gate
  if (rows.length < 15 || dtsIn20to60blocks < 8) {
    console.log(`
DATA TOO SPARSE FOR A DEFINITIVE CONCLUSION: ${rows.length} rounds total (${dtsIn20to60blocks} with literal Δt in [20,60] blocks — note: at 0.3s/block that window is seconds, while the natural round cadence here is minutes; ${dtsIn20to60min} rounds fall in the [20,60] MINUTE band). Totals above are still internally consistent; treat direction, not size.`);
  }

  // honest conclusion (3 lines)
  const verdict = wPNL > flatSamePNL ? "EARN MORE" : wPNL < flatSamePNL ? "EARN LESS" : "tie";
  console.log(`
CONCLUSION (real Monad testnet NVDA/HKD QuoteSettledValid marks, ${marks.length} pts / ${rows.length} rounds):`);
  console.log(`  1) BSM at realized σ would have ${verdict} LP income than the live 1%-flat model: BSM book net ${wPNL.toFixed(2)} HKD vs flat ${flatSamePNL.toFixed(2)} HKD on identical sold notional (${NOTIONAL} HKD/round, same ${wPriced.length} rounds), capped payout ${wPayout.toFixed(2)} HKD.`);
  console.log(`  2) Realized per-round ATM σ ≈${(meanSigmaT * 100).toFixed(3)}% (annualized ref ≈${(meanSigmaAnn * 100).toFixed(0)}%) ⇒ BSM charged ~${(wPriced.length ? (wPrem / wPriced.length / NOTIONAL * 100).toFixed(3) : "?")}% premium/round vs the flat 1.000%; the short horizon makes BSM σ-driven premiums SMALL unless σ is high.`);
  console.log(`  3) Tail risk dominates: ${beatsW}/${wPriced.length} rounds paid out more than the BSM premium (hard cap 198 HKD); sensitivity shows pricing at σ×0.5 nets ${s05.pnl.toFixed(2)} vs σ×1.5 nets ${s15.pnl.toFixed(2)} — LP income is essentially a bet that charged IV ≥ realized vol; data is ${rows.length < 15 ? "Sparse" : "modest"}, so direction over magnitude.`);
  console.log(`
CSV written: ${OUT_CSV} (${rows.length} data rows + header)`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
