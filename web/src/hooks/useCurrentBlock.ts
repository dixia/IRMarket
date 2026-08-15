"use client";

import { useBlockNumber } from "wagmi";

/** Current block number (polled) — drives expiry/quote-window countdowns. */
export function useCurrentBlock(): bigint | undefined {
  const { data } = useBlockNumber({ watch: true });
  return data;
}