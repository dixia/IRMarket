// Shared domain types for the IRMarket frontend (Veto-Market, sc-tech-spec V0.9).

export type Side = "bull" | "bear";

export type QuoteStatus = 0 | 1 | 2 | 3 | 4;

export interface Quote {
  quoteId: bigint;
  provider: `0x${string}`;
  baseToken: `0x${string}`;
  quoteToken: `0x${string}`;
  baseAmount: bigint;
  quoteAmount: bigint;
  price: bigint; // 1e18 fixed-point, quote per base
  startSlot: number;
  settledSlot: number;
  expiryBlock: bigint;
  status: QuoteStatus;
}

export interface Market {
  marketId: bigint;
  baseToken: `0x${string}`;
  quoteToken: `0x${string}`;
  marketMaker: `0x${string}`;
  feeBps: bigint;
  expiryBlock: bigint;
  createdAtBlock: bigint;
}

export interface Position {
  id: string;
  side: Side;
  marketId: bigint | null;
  quoteId: bigint;
  openPrice: bigint; // locked quote price at entry (1e18)
  // bull (long): receives baseAmount (LLM), posted quoteAmount + fee (HKD)
  // bear (short): receives quoteAmount − fee (HKD), posted baseAmount (LLM)
  heldBase: bigint;
  heldQuote: bigint;
  paidBase: bigint;
  paidQuote: bigint;
  fee: bigint;
  expiryBlock: bigint;
  openedAtBlock: number;
}

export type PriceState =
  | { status: "loading" }
  | { status: "missing"; exists: false }
  | { status: "ok"; price: bigint; settledSlot: number; exists: true };

export interface MarketWithMeta extends Market {
  name: string;
  ticker: string;
}