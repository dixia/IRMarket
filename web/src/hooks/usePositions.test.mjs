import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as viem from "viem";
import { QueryClient } from "@tanstack/react-query";
import { IRMARKET_ABI } from "../lib/abis/market.ts";
import { decodeQuote } from "../lib/decode.ts";

const MONORACLE_ABI = JSON.parse(readFileSync(new URL("../lib/abis/Monoracle.json", import.meta.url))).abi;
const USER = "0x1111111111111111111111111111111111111111";
const ORACLE = "0x2222222222222222222222222222222222222222";
const WRAPPER = "0x3333333333333333333333333333333333333333";
const ZERO = "0x0000000000000000000000000000000000000000";
const hookSource = ts.transpileModule(readFileSync(new URL("./usePositions.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function quote(provider = USER) {
  const fields = { provider, baseToken: USER, quoteToken: ORACLE, baseAmount: 10n,
    quoteAmount: 20n, price: 2n, startSlot: 1, expiryBlock: 9999, settledSlot: 0, status: 0 };
  return MONORACLE_ABI.find((entry) => entry.name === "quotes").outputs.map((output) => fields[output.name]);
}

function log(kind, quoteId = 1n, verifier = USER) {
  const wrapped = kind === "wrapped";
  const abi = wrapped ? IRMARKET_ABI : MONORACLE_ABI;
  const eventName = wrapped ? "VetoWrapped" : "QuoteVetoedUnderpriced";
  const args = wrapped
    ? { quoteId, marketId: 2n, trader: USER, side: 0, swapIn: 20n, swapOut: 10n, fee: 1n }
    : { quoteId, verifier };
  const event = abi.find((entry) => entry.type === "event" && entry.name === eventName);
  const plain = event.inputs.filter((input) => !input.indexed);
  return {
    blockNumber: 6000n,
    topics: viem.encodeEventTopics({ abi, eventName, args }),
    data: viem.encodeAbiParameters(plain, plain.map((input) => args[input.name])),
  };
}

// Run the actual hook query without React mounting or network requests. Only hook
// state, config and RPC transport are substituted; ABI decoding is the real code.
function captureQuery({ wrapped = [], direct = [], read = async () => quote() } = {}) {
  let options;
  const reads = [];
  const publicClient = { readContract: async (request) => {
    reads.push(request.args[0]);
    return read(request.args[0]);
  } };
  const dependencies = {
    "@tanstack/react-query": { useQuery: (value) => { options = value; return {}; } },
    wagmi: { usePublicClient: () => publicClient },
    viem,
    "@/lib/abis/oracle": { MONORACLE_ABI },
    "@/lib/abis/market": { IRMARKET_ABI },
    "@/lib/decode": { decodeQuote },
    "@/lib/logs": { getLogsChunked: async (_client, request) => request.address === WRAPPER ? wrapped : direct },
    "./useCurrentBlock": { useCurrentBlock: () => 6000n },
    "@/lib/config": { MARKET_ADDRESS: WRAPPER, ORACLE_ADDRESS: ORACLE, QUOTE_TOKEN: ORACLE,
      hasWrapper: true, isFullyConfigured: true },
  };
  const exports = {};
  vm.runInNewContext(hookSource, { exports, require: (id) => {
    assert.ok(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`);
    return dependencies[id];
  } }, { filename: "usePositions.ts" });
  exports.usePositions(USER);
  return { options, reads };
}

for (const kind of ["wrapped", "direct"]) {
  const events = (logs) => ({ [kind]: logs });

  test(`${kind}: hydrate a matching event with the real ABI`, async () => {
    const { options } = captureQuery(events([log(kind)]));
    const positions = await options.queryFn();
    assert.equal(positions.length, 1);
    assert.equal(positions[0].quoteId, 1n);
    assert.equal(positions[0].heldBase, 10n);
    assert.equal(positions[0].paidQuote, kind === "wrapped" ? 21n : 20n);
  });

  test(`${kind}: a quote RPC rejection must reject the query`, async () => {
    const failure = new Error("RPC rate limit (429)");
    const { options } = captureQuery({ ...events([log(kind)]), read: async () => { throw failure; } });
    await assert.rejects(options.queryFn(), (error) => error === failure);
  });

  test(`${kind}: one failed quote must not resolve a partial positions list`, async () => {
    const failure = new Error("RPC timeout");
    const { options, reads } = captureQuery({ ...events([log(kind, 1n), log(kind, 2n)]),
      read: async (id) => { if (id === 2n) throw failure; return quote(); } });
    await assert.rejects(options.queryFn(), (error) => error === failure);
    assert.deepEqual(reads, [1n, 2n]);
  });

  test(`${kind}: a malformed quote must surface instead of hiding the position`, async () => {
    const { options } = captureQuery({ ...events([log(kind)]), read: async () => [] });
    await assert.rejects(options.queryFn(), /missing output/);
  });

  test(`${kind}: a successful zero-provider quote is still omitted`, async () => {
    const { options } = captureQuery({ ...events([log(kind)]), read: async () => quote(ZERO) });
    assert.equal((await options.queryFn()).length, 0);
  });

  test(`${kind}: an undecodable event is skipped before quote hydration`, async () => {
    const { options, reads } = captureQuery(events([{ data: "0x", topics: [], blockNumber: 6000n }]));
    assert.equal((await options.queryFn()).length, 0);
    assert.equal(reads.length, 0);
  });

  test(`${kind}: failed refetch retains the last good TanStack Query data`, async () => {
    let fail = false;
    const failure = new Error("temporary RPC outage");
    const { options } = captureQuery({ ...events([log(kind)]), read: async () => {
      if (fail) throw failure;
      return quote();
    } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      const query = { ...options, staleTime: 0 };
      const original = await client.fetchQuery(query);
      assert.equal(original.length, 1);
      fail = true;
      await assert.rejects(client.fetchQuery(query), (error) => error === failure);
      assert.strictEqual(client.getQueryData(query.queryKey), original);
      assert.equal(client.getQueryState(query.queryKey).status, "error");
    } finally {
      client.clear();
    }
  });
}

test("no matching events is a successful empty result", async () => {
  const { options, reads } = captureQuery();
  assert.equal((await options.queryFn()).length, 0);
  assert.equal(reads.length, 0);
});

test("another verifier's veto does not trigger a quote read", async () => {
  const { options, reads } = captureQuery({ direct: [log("direct", 1n, WRAPPER)] });
  assert.equal((await options.queryFn()).length, 0);
  assert.equal(reads.length, 0);
});
