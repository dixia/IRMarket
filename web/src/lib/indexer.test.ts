import { test } from "node:test";
import assert from "node:assert/strict";
import { coverageSql, fetchPositionEvents, parsePositionRows, positionsSql } from "./indexer.ts";

const MARKET = "0x05475037AE4e0717083737eDAc38590850968E7c";
const ORACLE = "0x0BC36e1ac475AdEF75F102deb1708BE6E45aA16f";
const WALLET = "0x1111111111111111111111111111111111111111";

// Row shapes as the nest's /sql returns them: uint256 as decimal strings, block_number a number.
const WRAPPED_ROW = { kind: "wrapped", quote_id: "42", market_id: "7", side: "1", swap_in: "1000", swap_out: "990", fee: "10", block_number: 73880001 };
const VETOED_ROW = { kind: "vetoed", quote_id: "43", market_id: null, side: "bull", swap_in: null, swap_out: null, fee: null, block_number: 73880002 };

function fakeFetch(answers: Array<Record<string, unknown> | number>) {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(decodeURIComponent(String(url)));
    const next = answers.shift();
    if (typeof next === "number") return new Response("", { status: next });
    return new Response(JSON.stringify(next), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, urls };
}

test("SQL lowercases addresses and refuses anything that is not one", () => {
  const q = positionsSql(WALLET, MARKET, ORACLE);
  assert.match(q, /trader = '0x1111111111111111111111111111111111111111'/);
  assert.match(q, /address = '0x05475037ae4e0717083737edac38590850968e7c'/);
  assert.match(q, /verifier = '0x1111111111111111111111111111111111111111' AND address = '0x0bc36e1ac475adef75f102deb1708be6e45aa16f'/);
  assert.throws(() => positionsSql("0x1' OR '1'='1", MARKET, ORACLE));
  assert.doesNotMatch(positionsSql(WALLET, null, ORACLE), /veto_wrapped/);
  assert.doesNotMatch(coverageSql(null, ORACLE), /market_created/);
});

test("rows parse to the same event shape the RPC path builds", () => {
  const [w, v] = parsePositionRows([WRAPPED_ROW, VETOED_ROW]);
  assert.deepEqual(w, { kind: "wrapped", quoteId: 42n, marketId: 7n, side: "bear", swapIn: 1000n, swapOut: 990n, fee: 10n, blockNumber: 73880001n });
  assert.deepEqual(v, { kind: "vetoed", quoteId: 43n, marketId: null, side: "bull", swapIn: 0n, swapOut: 0n, fee: 0n, blockNumber: 73880002n });
  assert.equal(parsePositionRows([{ ...WRAPPED_ROW, side: "0" }])[0].side, "bull");
});

test("a covered nest answers with its events", async () => {
  const { impl, urls } = fakeFetch([{ rows: [{ market_rows: 3, oracle_rows: 5 }] }, { rows: [WRAPPED_ROW, VETOED_ROW] }]);
  const got = await fetchPositionEvents("https://nest.example/", WALLET, MARKET, ORACLE, impl);
  assert.equal(got?.length, 2);
  assert.ok(urls.every((u) => u.startsWith("https://nest.example/sql?q=")));
});

test("a nest indexing another deployment, a partial answer, or an error means use the RPC", async () => {
  // Distinct oracle per case so the module's coverage cache cannot carry one case into the next.
  const o = (n: number) => `0x${String(n).repeat(40)}`;
  // The positions answer is queued so that only the coverage check can make this null.
  const other = fakeFetch([{ rows: [{ market_rows: 0, oracle_rows: 9 }] }, { rows: [WRAPPED_ROW] }]);
  assert.equal(await fetchPositionEvents("https://n", WALLET, MARKET, o(2), other.impl), null);
  assert.equal(other.urls.length, 1, "positions must not be read from a nest that does not cover these contracts");
  assert.equal(
    await fetchPositionEvents("https://n", WALLET, MARKET, o(3), fakeFetch([{ rows: [{ market_rows: 1, oracle_rows: 1 }] }, { rows: [], degraded: true }]).impl),
    null,
  );
  assert.equal(await fetchPositionEvents("https://n", WALLET, MARKET, o(4), fakeFetch([502]).impl), null);
});

test("an uncovered answer is re-checked on the next call, not cached", async () => {
  const oracle = `0x${"5".repeat(40)}`;
  const first = fakeFetch([{ rows: [{ market_rows: 0, oracle_rows: 0 }] }]);
  assert.equal(await fetchPositionEvents("https://n", WALLET, MARKET, oracle, first.impl), null);
  const second = fakeFetch([{ rows: [{ market_rows: 1, oracle_rows: 1 }] }, { rows: [] }]);
  assert.deepEqual(await fetchPositionEvents("https://n", WALLET, MARKET, oracle, second.impl), []);
});
