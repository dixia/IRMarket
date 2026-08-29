# IRMarket — Work Log

## 2026-08-29: Monoracle Migration (CWV-01) Complete

### What changed
IRMarket no longer runs a custom fork of Monoracle (`MonoracleWindowed.sol`). The stack now uses the **upstream Monoracle** contract directly:
- Added `contracts/IMonoracle.sol` (upstream interface)
- Added `contracts/test/MonoracleMock.sol` (in-memory mock for Hardhat tests)
- Deleted `contracts/MonoracleWindowed.sol`, `contracts/IMonoracleWindowed.sol`
- Updated `contracts/IRMarket.sol` to reference `IMonoracle`
- Refreshed `abi/Monoracle.abi.json` to upstream 30-entry ABI
- Updated `web/src/lib/abis/oracle.ts` to export `monoracleJson.abi` (was blocking all wagmi reads)
- Fixed `useQuotes.ts` / `usePositions.ts` struct field order (`expiryBlock` / `settledSlot` positions)
- Fixed BigInt arithmetic in `TradePanel` countdown
- Updated `bot/verifier.py` `quotes()` tuple indices (`expiryBlock` 8→7)
- Replaced all `MonoracleWindowed` references with `Monoracle` in docs, comments, and deploy scripts
- Marked CWV-01 as **DONE** in `TODO.md`

### Why it matters
- **Maintenance**: future Monoracle upgrades only require an ABI refresh, not a fork rebase
- **Correctness**: frontend and bot now parse on-chain data against the canonical ABI
- **Narrative**: docs, errors, and deploy scripts consistently reference “Monoracle” (no fork jargon)

### What users get
- Trade panel reliably shows active quotes and enables “Confirm long/short position”
- Bot quoting/settlement works against upstream Monoracle testnet deployment
- Cleaner product story for onboarding and demo walkthroughs

### Verification
- `npx hardhat test` → 17 passing
- `npx playwright test` → 5 passing
- `cd web && npx tsc --noEmit` → clean

### Next steps
- Live bot integration test on Monad testnet (code ready; needs funded wallet + active market)
- Refresh `abi/Monoracle.abi.json` on each upstream release
- Close GH issue #2 (CWV-01)
