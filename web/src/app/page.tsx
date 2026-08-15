export default function Home() {
  return (
    <main className="flex-1 bg-monad-dot">
      <header className="border-b border-monad-purple/20 bg-[#0E100F]/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between">
          <span className="font-bold text-lg tracking-tight">
            <span className="text-monad-purple">IR</span>Market
          </span>
        </div>
      </header>
      <div className="max-w-2xl mx-auto px-4 py-12 space-y-6">
        <h1 className="text-3xl font-bold tracking-tight">
          Exotic options on <span className="text-monad-purple">any priced asset</span>
        </h1>
        <p className="text-zinc-400">
          A-share stocks, Labubu, whatever has a price. Built on Monad with Monoracle-style
          veto-arbitrage settlement — no off-chain data feeds, no validators.
        </p>
        <p className="text-sm text-zinc-600">
          Scaffold — the dapp UI lands with the product requirement analysis.
        </p>
      </div>
    </main>
  );
}