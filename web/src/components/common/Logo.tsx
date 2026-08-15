"use client";

import Link from "next/link";

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-1 font-bold text-lg tracking-tight">
      <span className="text-primary">IR</span>
      <span>Market</span>
    </Link>
  );
}