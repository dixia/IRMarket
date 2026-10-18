/**
 * IRMarketVault — end-to-end (E2E) suite for the LP-vault MVP.
 *
 * Unlike `test/IRMarketVault.test.js` (unit / M5 hardening), these tests drive the
 * full real flow through the deployed contracts and the real oracle mechanics:
 * MonoracleMock quote submit → mine past the veto window → the price is canonical
 * (lazy/implicit settlement; settleValidQuote is only an optional checkpoint) →
 * vault reads it. The vault boundary is never mocked.
 *
 * Canonical walkthrough + exact numbers mirror `script/vault-demo.js` (see E2E-7).
 * Payoff: `docs/design/lp-pool-tech-spec.md` §4.2; accounting §6; lifecycle §9;
 * MVP cut §1.4; risks §1.4 (accepted list).
 *
 * Signers: [deployer, lp1, lp2, trader, trader2, keeper, provider].
 */
import { expect } from "chai";
import hre from "hardhat";

const { ethers } = await hre.network.create();

const E18 = 10n ** 18n;
const LONG = 0;
const SHORT = 1;

async function mineBlocks(n) {
  for (let i = 0; i < n; i++) {
    await ethers.provider.send("evm_mine", []);
  }
}

async function currentBlock() {
  return await ethers.provider.getBlockNumber();
}

describe("IRMarketVault — E2E (LP-vault MVP)", function () {
  let deployer, lp1, lp2, trader, trader2, keeper, provider;
  let oracle, base, quote, vault;

  const FEE_BPS = 100n; // 1%
  const D = 100n * E18; // trader premium
  const FEE = 1n * E18; // D * feeBps / 10_000
  const N = 99n * E18; // D - FEE, notional at risk
  const MAX_PAYOUT = 2n * N; // 198e18, worst case the vault reserves

  beforeEach(async function () {
    [deployer, lp1, lp2, trader, trader2, keeper, provider] = await ethers.getSigners();

    const Oracle = await ethers.getContractFactory("MonoracleMock");
    oracle = await Oracle.deploy();

    const Token = await ethers.getContractFactory("MockERC20");
    base = await Token.deploy("Liuliumei", "LLM", 18);
    quote = await Token.deploy("HKD", "HKD", 18);

    const Vault = await ethers.getContractFactory("IRMarketVault");
    vault = await Vault.deploy(oracle.target, base.target, quote.target, FEE_BPS);

    for (const who of [lp1, lp2, trader, trader2, keeper, provider]) {
      await quote.mint(who.address, 1_000_000n * E18);
      await base.mint(who.address, 100_000n * E18);
    }

    for (const who of [lp1, lp2, trader, trader2]) {
      await quote.connect(who).approve(vault.target, ethers.MaxUint256);
    }
    for (const who of [provider, keeper]) {
      await base.connect(who).approve(oracle.target, ethers.MaxUint256);
      await quote.connect(who).approve(oracle.target, ethers.MaxUint256);
    }
  });

  // Publish a quote at `priceWad` (baseAmount = 1e18 so price == quoteAmount in WAD),
  // mine past the veto window, then settle it so it becomes the canonical price.
  async function setPrice(priceWad, publisher = provider) {
    const id = await oracle.nextQuoteId();
    const block = await currentBlock();
    await oracle.connect(publisher).submitQuote(base.target, quote.target, 1n * E18, priceWad, block + 10);
    await mineBlocks(11);
    await oracle.connect(deployer).settleValidQuote(id);
    return id;
  }

  // The vault's real token balance must always equal its cached `balance`.
  async function assertLockstep() {
    expect(await quote.balanceOf(vault.target)).to.equal(await vault.balance(), "token balance == cached balance");
  }

  // Solvency + `pendingPayout == Σ open maxPayout` (spec §6.2 / §14).
  async function assertInvariants() {
    const bal = await vault.balance();
    const pend = await vault.pendingPayout();
    expect(bal >= pend).to.equal(true, "balance >= pendingPayout");

    const n = await vault.positionCount();
    let sum = 0n;
    for (let i = 0n; i < n; i++) {
      const p = await vault.positions(i);
      if (p.status === 0n) sum += p.maxPayout; // Status.OPEN
    }
    expect(pend).to.equal(sum, "pendingPayout == Σ open maxPayout");
    await assertLockstep();
  }

  // ------------------------------------------------------------------
  // 1. Full LONG lifecycle
  // ------------------------------------------------------------------
  it("E2E-1: full LONG lifecycle (deposit → open → settle → withdraw)", async function () {
    await vault.connect(lp1).deposit(1000n * E18);
    await setPrice(100n * E18); // S0

    const traderBefore = await quote.balanceOf(trader.address);
    await expect(vault.connect(trader).openPosition(LONG, D, 10n)).to.emit(vault, "PositionOpened");

    await setPrice(150n * E18); // S1 = 1.5·S0 → raw pnl = 0.5N
    await expect(vault.connect(trader).settlePosition(0))
      .to.emit(vault, "PositionSettled")
      .withArgs(0n, 150n * E18, (1485n * E18) / 10n); // N + 0.5N = 148.5e18

    expect(await quote.balanceOf(trader.address)).to.equal(traderBefore + (485n * E18) / 10n); // +48.5
    expect(await vault.pendingPayout()).to.equal(0n);
    expect(await vault.equity()).to.equal((9515n * E18) / 10n); // 951.5e18
    await assertLockstep();

    const lpBefore = await quote.balanceOf(lp1.address);
    const out = await vault.connect(lp1).withdraw.staticCall(1000n * E18);
    await vault.connect(lp1).withdraw(1000n * E18);

    expect(out).to.equal((9515n * E18) / 10n); // LP1 receives 951.5e18
    expect(await quote.balanceOf(lp1.address)).to.equal(lpBefore + out);
    expect(await vault.totalShares()).to.equal(0n);
    expect(await vault.balance()).to.equal(0n);
    await assertLockstep();
  });

  // ------------------------------------------------------------------
  // 2. Full SHORT lifecycle
  // ------------------------------------------------------------------
  it("E2E-2: full SHORT lifecycle (falling price pays N + N·(S0−S)/S0)", async function () {
    await vault.connect(lp1).deposit(1000n * E18);
    await setPrice(100n * E18); // S0

    const traderBefore = await quote.balanceOf(trader.address);
    await vault.connect(trader).openPosition(SHORT, D, 10n);

    await setPrice(50n * E18); // S1 = 0.5·S0 → down = 0.5N
    await expect(vault.connect(trader).settlePosition(0))
      .to.emit(vault, "PositionSettled")
      .withArgs(0n, 50n * E18, (1485n * E18) / 10n); // 99 + 49.5

    expect(await quote.balanceOf(trader.address)).to.equal(traderBefore + (485n * E18) / 10n); // +48.5
    expect(await vault.pendingPayout()).to.equal(0n);
    expect(await vault.equity()).to.equal((9515n * E18) / 10n);
    await assertLockstep();

    const out = await vault.connect(lp1).withdraw.staticCall(1000n * E18);
    expect(out).to.equal((9515n * E18) / 10n);
  });

  // ------------------------------------------------------------------
  // 3. Pool: 2 LPs, opposing LONG + SHORT, one new canonical price
  // ------------------------------------------------------------------
  it("E2E-3: 2-LP pool with opposing positions settles at one canonical price", async function () {
    await vault.connect(lp1).deposit(1000n * E18);
    await vault.connect(lp2).deposit(500n * E18);
    await assertLockstep();
    await setPrice(100n * E18); // shared entry S0

    const t1Before = await quote.balanceOf(trader.address);
    const t2Before = await quote.balanceOf(trader2.address);

    await vault.connect(trader).openPosition(LONG, D, 10n);
    await vault.connect(trader2).openPosition(SHORT, D, 10n);
    const sharesBefore = await vault.totalShares(); // 1500e18
    expect(sharesBefore).to.equal(1500n * E18);
    await assertInvariants();

    await setPrice(150n * E18); // both settle against B
    await expect(vault.connect(trader).settlePosition(0))
      .to.emit(vault, "PositionSettled")
      .withArgs(0n, 150n * E18, (1485n * E18) / 10n); // LONG +49.5
    await expect(vault.connect(trader2).settlePosition(1))
      .to.emit(vault, "PositionSettled")
      .withArgs(1n, 150n * E18, (495n * E18) / 10n); // SHORT 49.5

    expect(await vault.pendingPayout()).to.equal(0n);
    expect(await vault.totalShares()).to.equal(sharesBefore); // shares conserved
    await assertLockstep();

    // Both traders are paid correctly; the pool nets only the two fees.
    expect(await quote.balanceOf(trader.address)).to.equal(t1Before + (485n * E18) / 10n); // +48.5
    expect(await quote.balanceOf(trader2.address)).to.equal(t2Before - (505n * E18) / 10n); // -50.5

    const eq = await vault.equity();
    expect(eq).to.equal(1502n * E18); // 1500 deposits + 2 fees, net pnl 0

    // Real sequential withdrawals. LP1's floor of `shares * equity / supply` leaves a
    // 1-wei floor remainder in the pool (equity 1502e18, supply 1500e18):
    // LP1 1000e18 shares → 1001.333…e18, then LP2 500e18 shares → 500.666…e18 + 1 wei
    // (500666666666666666667), because LP2 sweeps the floor remainder LP1 left behind.
    const LP1_PAYOUT = 1001333333333333333333n;
    const LP2_PAYOUT = 500666666666666666667n;

    const lp1Before = await quote.balanceOf(lp1.address);
    expect(await vault.connect(lp1).withdraw.staticCall(1000n * E18)).to.equal(LP1_PAYOUT);
    await vault.connect(lp1).withdraw(1000n * E18);
    expect(await quote.balanceOf(lp1.address)).to.equal(lp1Before + LP1_PAYOUT);

    const lp2Before = await quote.balanceOf(lp2.address);
    expect(await vault.connect(lp2).withdraw.staticCall(500n * E18)).to.equal(LP2_PAYOUT);
    await vault.connect(lp2).withdraw(500n * E18);
    expect(await quote.balanceOf(lp2.address)).to.equal(lp2Before + LP2_PAYOUT);

    expect(await vault.totalShares()).to.equal(0n);
    expect(await vault.balance()).to.equal(0n);
    expect(LP1_PAYOUT + LP2_PAYOUT).to.equal(1502n * E18);
    await assertLockstep();
  });

  // ------------------------------------------------------------------
  // 4. Canonical price = newest quote (B replaces A), settle optional
  // ------------------------------------------------------------------
  it("E2E-4: canonical price is the newest quote (B replaces A), no settle needed", async function () {
    await vault.connect(lp1).deposit(1000n * E18);

    // A @ 100 and B @ 150 share one window; B is submitted last.
    const idA = await oracle.nextQuoteId();
    const block = await currentBlock();
    await oracle.connect(provider).submitQuote(base.target, quote.target, 1n * E18, 100n * E18, block + 10);
    await oracle.connect(provider).submitQuote(base.target, quote.target, 1n * E18, 150n * E18, block + 10);
    await mineBlocks(11); // both windows pass — NO settle tx

    // Lazy settlement: B is canonical the moment its window passes.
    const [price, settledSlot, exists] = await oracle.getLatestPrice(base.target, quote.target);
    expect(exists).to.equal(true);
    expect(price).to.equal(150n * E18); // B, not A
    expect(settledSlot).to.equal(BigInt(block) + 10n); // expiryBlock backfill (D4)

    // A late checkpoint of the OLDER quote must not drag the price back to A.
    await oracle.connect(deployer).settleValidQuote(idA);
    const [priceAfterCheckpoint] = await oracle.getLatestPrice(base.target, quote.target);
    expect(priceAfterCheckpoint).to.equal(150n * E18);

    await vault.connect(trader).openPosition(LONG, D, 10n);
    const p = await vault.positions(0);
    expect(p.entryPrice).to.equal(150n * E18); // opened at B, not A

    await mineBlocks(11); // pass the tenor (no new quote: canonical stays B)
    await expect(vault.connect(trader).settlePosition(0))
      .to.emit(vault, "PositionSettled")
      .withArgs(0n, 150n * E18, N); // settled at B → flat → payout N
  });

  // ------------------------------------------------------------------
  // 5. No trustworthy price
  // ------------------------------------------------------------------
  it("E2E-5a: no settled quote → openPosition reverts PriceUnavailable", async function () {
    await expect(vault.connect(trader).openPosition(LONG, D, 10n))
      .to.be.revertedWithCustomError(vault, "PriceUnavailable");
  });

  it("E2E-5b: canonical price 0 → settlePosition reverts PriceUnavailable", async function () {
    // Mock-specific path: a zero canonical price is NOT reachable on the real oracle —
    // upstream Monoracle rejects tiny quotes (QuoteAmountTooSmall). MonoracleMock allows
    // it, so this is a defensive guard test of the vault's own `settlePrice == 0` check.
    await setPrice(100n * E18);
    await vault.connect(lp1).deposit(1000n * E18);
    await vault.connect(trader).openPosition(LONG, D, 10n);

    await setPrice(0n); // a settled quote with quoteAmount 0 → price 0 exists but is unusable
    await expect(vault.connect(trader).settlePosition(0))
      .to.be.revertedWithCustomError(vault, "PriceUnavailable");
  });

  // ------------------------------------------------------------------
  // 6. Accepted-risk characterization — price manipulation (NOT a guarantee)
  // ------------------------------------------------------------------
  it("E2E-6: accepted-risk — a tiny third-party quote becomes canonical and the vault settles at it", async function () {
    // TODO(V1 PriceAdapter): flip this to expect a revert once the adapter ships.
    // NOTE: this test must NOT survive V1 unchanged — it pins down the exact manipulation
    // the PriceAdapter removes, so when the adapter lands it becomes a `reverted` assertion.
    // Documents the MVP's accepted limitation (spec §1.4, plan §6 risk 1): there is
    // NO bond floor, so anyone can publish a tiny quote that becomes the canonical
    // price and the vault settles against it. V1's PriceAdapter (minQuoteNotional,
    // freshness, bannedProvider, circuit breaker — spec §8) is what closes this gap.
    await setPrice(100n * E18); // S0
    await vault.connect(lp1).deposit(1000n * E18);

    const traderBefore = await quote.balanceOf(trader.address);
    await vault.connect(trader).openPosition(LONG, D, 10n); // entry 100

    await mineBlocks(11); // let the LONG expire

    // Third party (keeper, not the vault operator): 1 wei base + 200 wei quote →
    // canonical price 200 HKD/LLM (2·S0) for 201 wei of collateral, no bond required.
    const id = await oracle.nextQuoteId();
    const block = await currentBlock();
    await oracle.connect(keeper).submitQuote(base.target, quote.target, 1n, 200n, block + 10);
    await mineBlocks(11);
    await oracle.connect(deployer).settleValidQuote(id);

    const [mPrice, , mExists] = await oracle.getLatestPrice(base.target, quote.target);
    expect(mExists).to.equal(true);
    expect(mPrice).to.equal(200n * E18); // unbonded 2× price is now canonical

    const payout = await vault.connect(keeper).settlePosition.staticCall(0);
    expect(payout).to.equal(MAX_PAYOUT); // 198e18 = 2N, the cap
    await vault.connect(keeper).settlePosition(0);

    expect(await quote.balanceOf(trader.address)).to.equal(traderBefore + 98n * E18); // +2N − D
    expect(await vault.equity()).to.equal(902n * E18); // LP1 eats the 98 payout
    await assertLockstep();
  });

  // ------------------------------------------------------------------
  // 7. Drift guard: reproduce script/vault-demo.js numbers exactly
  // ------------------------------------------------------------------
  it("E2E-7: script/vault-demo.js numbers exactly (drift guard)", async function () {
    const S0 = 100n * E18;
    const S1 = 150n * E18;

    await setPrice(S0);
    await vault.connect(lp1).deposit(1000n * E18);
    const equityBeforeOpen = await vault.equity();
    expect(equityBeforeOpen).to.equal(1000n * E18);

    await vault.connect(trader).openPosition(LONG, D, 10n);
    expect(await vault.equity()).to.equal(902n * E18); // demo asserts the open dip == 902

    const traderBefore = await quote.balanceOf(trader.address);
    await setPrice(S1);
    const payout = await vault.connect(trader).settlePosition.staticCall(0);
    await vault.connect(trader).settlePosition(0);
    const equityAfterSettle = await vault.equity();

    expect(payout).to.equal((1485n * E18) / 10n); // payout 148.5
    expect(payout - D).to.equal((485n * E18) / 10n); // trader PnL 48.5
    expect(await quote.balanceOf(trader.address)).to.equal(traderBefore + payout);
    expect(await vault.pendingPayout()).to.equal(0n);
    expect(equityAfterSettle).to.equal((9515n * E18) / 10n); // LP equity 951.5
    expect(equityAfterSettle - equityBeforeOpen).to.equal(FEE - (payout - N)); // Δequity == fee − pnl

    const lpBefore = await quote.balanceOf(lp1.address);
    const withdrawn = await vault.connect(lp1).withdraw.staticCall(1000n * E18);
    await vault.connect(lp1).withdraw(1000n * E18);
    expect(withdrawn).to.equal((9515n * E18) / 10n);
    expect(await quote.balanceOf(lp1.address)).to.equal(lpBefore + withdrawn);
    expect(await vault.balance()).to.equal(0n);
    await assertLockstep();
  });

  // ------------------------------------------------------------------
  // 8. Flow-level insolvency: never reserve more than the pool holds
  // ------------------------------------------------------------------
  it("E2E-8: openPosition reverts Insolvent when maxPayout exceeds the vault balance", async function () {
    await setPrice(100n * E18); // S0, needed before any open attempt

    // Case A: no LP capital. The trader's own premium (100e18) is the only backing,
    // but the worst-case obligation is 2N = 198e18 > 100e18 → the open is rejected.
    const traderBeforeA = await quote.balanceOf(trader.address);
    await assertInvariants();
    await expect(vault.connect(trader).openPosition(LONG, D, 10n))
      .to.be.revertedWithCustomError(vault, "Insolvent");
    expect(await vault.positionCount()).to.equal(0n);
    expect(await vault.balance()).to.equal(0n);
    expect(await vault.equity()).to.equal(0n);
    expect(await vault.pendingPayout()).to.equal(0n);
    expect(await quote.balanceOf(trader.address)).to.equal(traderBeforeA);
    await assertLockstep();
    await assertInvariants();

    // Case B: 50e18 of LP capital. balance = 50 + 100 = 150e18 < 198e18 → still insolvent.
    await vault.connect(lp1).deposit(50n * E18);
    const traderBeforeB = await quote.balanceOf(trader.address);
    await assertInvariants();
    await expect(vault.connect(trader).openPosition(LONG, D, 10n))
      .to.be.revertedWithCustomError(vault, "Insolvent");
    expect(await vault.positionCount()).to.equal(0n);
    expect(await vault.balance()).to.equal(50n * E18);
    expect(await vault.equity()).to.equal(50n * E18);
    expect(await vault.pendingPayout()).to.equal(0n);
    expect(await quote.balanceOf(trader.address)).to.equal(traderBeforeB);
    await assertLockstep();
    await assertInvariants();
  });
});
