"use client";

import { useEffect, useState } from "react";
import { formatCountdown } from "@/lib/format";
import { useCurrentBlock } from "@/hooks/useCurrentBlock";

/** Expiry countdown from blocks to a target block (D-01: market property). */
export function BlockCountdown({ expiryBlock }: { expiryBlock: bigint | undefined }) {
  const blockNumber = useCurrentBlock();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (expiryBlock === undefined) return <span aria-hidden>—</span>;
  if (blockNumber === undefined) return <span className="text-text-dim">…</span>;

  const blocksLeft = expiryBlock - blockNumber;
  const expired = blocksLeft < 0n;

  void now;

  return (
    <span className={expired ? "text-bear" : "text-primary"}>
      {formatCountdown(blocksLeft)}
    </span>
  );
}