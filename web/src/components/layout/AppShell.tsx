"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/common/Logo";
import { WalletButton } from "@/components/wallet/WalletButton";
import { NetworkBadge } from "@/components/wallet/NetworkBadge";

const NAV = [
  { href: "/", label: "市场" },
  { href: "/positions", label: "持仓" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-50 border-b border-card-border bg-bg-dark/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4">
          <div className="flex items-center gap-6">
            <Logo />
            <nav className="flex items-center gap-1 text-sm">
              {NAV.map((item) => {
                const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`rounded-lg px-3 py-1.5 transition-colors ${
                      active ? "bg-card text-text" : "text-text-dim hover:text-text"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <WalletButton />
        </div>
      </header>

      <NetworkBadgeContainer />

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}

// wrapper so the badge renders inside the shell but below the header
function NetworkBadgeContainer() {
  return (
    <div className="mx-auto mt-4 w-full max-w-5xl px-4">
      <NetworkBadge />
    </div>
  );
}