// Position events from a nuthatch nest (github.com/nuthatch-org/nuthatch) over IRMarket +
// Monoracle. Tables are `<alias>__<event>`, with the aliases `irmarket` and `monoracle` (#1).

export type IndexedSide = "bull" | "bear";

export interface IndexedPositionEvent {
  kind: "wrapped" | "vetoed";
  quoteId: bigint;
  marketId: bigint | null;
  side: IndexedSide;
  swapIn: bigint;
  swapOut: bigint;
  fee: bigint;
  blockNumber: bigint;
}

interface SqlAnswer {
  rows: Record<string, unknown>[];
  truncated?: boolean;
  degraded?: boolean;
  tip_unavailable?: boolean;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;

// Lowercase and validate before an address goes into SQL text.
function sqlAddress(address: string): string {
  const a = address.trim().toLowerCase();
  if (!ADDRESS.test(a)) throw new Error(`not an address: ${address}`);
  return `'${a}'`;
}

/** Rows proving the nest indexes these exact deployments; zero for either means it does not. */
export function coverageSql(market: string | null, oracle: string): string {
  const marketRows = market
    ? `(SELECT count(*) FROM irmarket__market_created WHERE address = ${sqlAddress(market)})`
    : "1";
  return (
    `SELECT ${marketRows} AS market_rows, ` +
    `(SELECT count(*) FROM monoracle__quote_submitted WHERE address = ${sqlAddress(oracle)}) AS oracle_rows`
  );
}

/** Wrapper opens by trader, then direct vetoes by verifier, as usePositions derives them. */
export function positionsSql(wallet: string, market: string | null, oracle: string): string {
  const w = sqlAddress(wallet);
  const o = sqlAddress(oracle);
  const wrapped = market
    ? `SELECT 'wrapped' AS kind, quoteId AS quote_id, marketId AS market_id, CAST(side AS VARCHAR) AS side, ` +
      `swapIn AS swap_in, swapOut AS swap_out, fee, block_number FROM irmarket__veto_wrapped ` +
      `WHERE trader = ${w} AND address = ${sqlAddress(market)} UNION ALL `
    : "";
  const vetoed = (event: string, side: IndexedSide) =>
    `SELECT 'vetoed', quoteId, NULL, '${side}', NULL, NULL, NULL, block_number FROM monoracle__${event} ` +
    `WHERE verifier = ${w} AND address = ${o}`;
  return (
    wrapped +
    vetoed("quote_vetoed_underpriced", "bull") +
    " UNION ALL " +
    vetoed("quote_vetoed_overpriced", "bear") +
    " ORDER BY block_number"
  );
}

const big = (v: unknown): bigint => (v === null || v === undefined ? 0n : BigInt(String(v)));

export function parsePositionRows(rows: Record<string, unknown>[]): IndexedPositionEvent[] {
  return rows.map((r) => {
    const kind = r.kind === "wrapped" ? "wrapped" : "vetoed";
    // VetoWrapped.side is the wrapper's enum: 0 = long (bull), 1 = short (bear).
    const side: IndexedSide =
      kind === "wrapped" ? (String(r.side) === "1" ? "bear" : "bull") : r.side === "bear" ? "bear" : "bull";
    return {
      kind,
      quoteId: big(r.quote_id),
      marketId: r.market_id === null || r.market_id === undefined ? null : big(r.market_id),
      side,
      swapIn: big(r.swap_in),
      swapOut: big(r.swap_out),
      fee: big(r.fee),
      blockNumber: big(r.block_number),
    };
  });
}

async function sql(base: string, q: string, fetchImpl: typeof fetch): Promise<SqlAnswer> {
  const url = `${base.replace(/\/+$/, "")}/sql?q=${encodeURIComponent(q)}`;
  const res = await fetchImpl(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`indexer ${res.status}`);
  const answer = (await res.json()) as SqlAnswer;
  // A partial answer would read as "no positions"; refuse it so the caller falls back to RPC.
  if (answer.truncated || answer.degraded || answer.tip_unavailable) throw new Error("indexer answer incomplete");
  return answer;
}

const coverage = new Map<string, Promise<boolean>>();

/**
 * Position events for `wallet` from the nest at `base`, or `null` when the nest cannot be
 * trusted for these contracts (unreachable, partial, or indexing another deployment). A
 * `null` means "use the RPC path", never "no positions".
 */
export async function fetchPositionEvents(
  base: string,
  wallet: string,
  market: string | null,
  oracle: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IndexedPositionEvent[] | null> {
  try {
    const key = `${base}|${market ?? ""}|${oracle}`.toLowerCase();
    let covered = coverage.get(key);
    if (!covered) {
      covered = sql(base, coverageSql(market, oracle), fetchImpl).then((a) => {
        const row = a.rows[0] ?? {};
        return big(row.market_rows) > 0n && big(row.oracle_rows) > 0n;
      });
      coverage.set(key, covered);
    }
    // Only a positive check is kept: a new deployment with no rows yet is re-checked next poll.
    const ok = await covered.catch(() => false);
    if (!ok) {
      coverage.delete(key);
      return null;
    }
    const answer = await sql(base, positionsSql(wallet, market, oracle), fetchImpl);
    return parsePositionRows(answer.rows);
  } catch {
    return null;
  }
}
