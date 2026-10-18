/**
 * IRMarketVault (MVP) — Hardhat test suite.
 * Minimal LP pool over Monoracle: LP shares, LONG/SHORT open, PnL settled against
 * Monoracle's canonical price (`getLatestPrice`). Payoff per lp-pool-tech-spec §4.2.
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

describe("IRMarketVault — MVP LP pool", function () {
  let oracle, base, quote, vault, lp, trader, provider, lp2, keeper;

  beforeEach(async function () {
    [lp, trader, provider, lp2, keeper] = await ethers.getSigners();

    const Oracle = await ethers.getContractFactory("MonoracleMock");
    oracle = await Oracle.deploy();

    const Token = await ethers.getContractFactory("MockERC20");
    base = await Token.deploy("Liuliumei", "LLM", 18);
    quote = await Token.deploy("HKD", "HKD", 18);

    const Vault = await ethers.getContractFactory("IRMarketVault");
    vault = await Vault.deploy(oracle.target, base.target, quote.target, 100n); // 1% fee

    await quote.mint(lp.address, 100_000n * E18);
    await quote.mint(trader.address, 100_000n * E18);
    await quote.mint(lp2.address, 100_000n * E18);
    await base.mint(provider.address, 100_000n * E18);
    await quote.mint(provider.address, 1_000_000n * E18);

    await quote.connect(lp).approve(vault.target, ethers.MaxUint256);
    await quote.connect(trader).approve(vault.target, ethers.MaxUint256);
    await quote.connect(lp2).approve(vault.target, ethers.MaxUint256);
    await base.connect(provider).approve(oracle.target, ethers.MaxUint256);
    await quote.connect(provider).approve(oracle.target, ethers.MaxUint256);
  });

  // Publish a quote at `priceWad` (WAD) and settle it so it becomes canonical.
  async function setPrice(priceWad) {
    const id = await oracle.nextQuoteId();
    const block = await currentBlock();
    await oracle.connect(provider).submitQuote(base.target, quote.target, 1n * E18, priceWad, block + 10);
    await mineBlocks(11);
    await oracle.settleValidQuote(id);
  }

  // Publish a quote at `priceWad` and mine past its window — NO settleValidQuote.
  // Under upstream lazy settlement the quote is canonical once block.number >
  // expiryBlock, so the vault must mark against it without any checkpoint tx.
  async function setPriceNoSettle(priceWad) {
    const block = await currentBlock();
    await oracle.connect(provider).submitQuote(base.target, quote.target, 1n * E18, priceWad, block + 10);
    await mineBlocks(11);
  }

  // M5 invariant (spec §14): solvency + pendingPayout == Σ open maxPayout, and
  // the vault's token balance always equals its cached `balance`.
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
    expect(await quote.balanceOf(vault.target)).to.equal(bal, "token balance == cached balance");
  }

  it("LP deposit mints pro-rata shares and tracks equity", async function () {
    await vault.connect(lp).deposit(1000n * E18);

    expect(await vault.totalShares()).to.equal(1000n * E18);
    expect(await vault.shares(lp.address)).to.equal(1000n * E18);
    expect(await vault.balance()).to.equal(1000n * E18);
    expect(await vault.equity()).to.equal(1000n * E18);
    expect(await quote.balanceOf(vault.target)).to.equal(1000n * E18);
  });

  it("LONG settles at a higher price, capped at 2N", async function () {
    await setPrice(100n * E18);
    await vault.connect(lp).deposit(1000n * E18);

    const before = await quote.balanceOf(trader.address);
    await expect(vault.connect(trader).openPosition(LONG, 100n * E18, 10n))
      .to.emit(vault, "PositionOpened");

    // price doubles -> raw pnl = N = 99, capped at N -> payout 2N = 198
    await setPrice(200n * E18);
    await expect(vault.connect(trader).settlePosition(0))
      .to.emit(vault, "PositionSettled")
      .withArgs(0n, 200n * E18, 198n * E18);

    expect(await quote.balanceOf(trader.address)).to.equal(before + 98n * E18); // +198 payout -100 premium
    expect(await vault.pendingPayout()).to.equal(0n);
    expect(await vault.equity()).to.equal(902n * E18); // LP lost 98 net
  });

  it("flat price: trader loses only the fee, LP gains it", async function () {
    await setPrice(100n * E18);
    await vault.connect(lp).deposit(1000n * E18);

    await vault.connect(trader).openPosition(LONG, 100n * E18, 10n);
    await setPrice(100n * E18);

    await expect(vault.connect(trader).settlePosition(0))
      .to.emit(vault, "PositionSettled")
      .withArgs(0n, 100n * E18, 99n * E18);

    expect(await vault.equity()).to.equal(1001n * E18); // +1 fee
  });

  it("canonical price needs no settle tx (lazy settlement)", async function () {
    // Same numbers as "LONG settles at a higher price" above, but the oracle is
    // never checkpointed: the quotes are canonical by maturation alone.
    await setPriceNoSettle(100n * E18);
    await vault.connect(lp).deposit(1000n * E18);

    const before = await quote.balanceOf(trader.address);
    await expect(vault.connect(trader).openPosition(LONG, 100n * E18, 10n))
      .to.emit(vault, "PositionOpened");

    await setPriceNoSettle(200n * E18); // price doubles, still no settle tx
    await expect(vault.connect(trader).settlePosition(0))
      .to.emit(vault, "PositionSettled")
      .withArgs(0n, 200n * E18, 198n * E18);

    expect(await quote.balanceOf(trader.address)).to.equal(before + 98n * E18); // +198 payout -100 premium
    expect(await vault.pendingPayout()).to.equal(0n);
    expect(await vault.equity()).to.equal(902n * E18); // LP lost 98 net
  });

  it("SHORT profits when price falls", async function () {
    await setPrice(100n * E18);
    await vault.connect(lp).deposit(1000n * E18);

    await vault.connect(trader).openPosition(SHORT, 100n * E18, 10n);
    await setPrice(50n * E18); // down = (100-50)*99/100 = 49.5

    await expect(vault.connect(trader).settlePosition(0))
      .to.emit(vault, "PositionSettled")
      .withArgs(0n, 50n * E18, (1485n * E18) / 10n); // 99 + 49.5
  });

  it("cannot settle before expiry", async function () {
    await setPrice(100n * E18);
    await vault.connect(lp).deposit(1000n * E18);

    await vault.connect(trader).openPosition(LONG, 100n * E18, 100n);
    await expect(vault.connect(trader).settlePosition(0))
      .to.be.revertedWithCustomError(vault, "NotExpired");
  });

  it("rejects a position the pool cannot cover (solvency invariant)", async function () {
    await setPrice(100n * E18);
    // no LP capital: maxPayout 198 > balance 100
    await expect(vault.connect(trader).openPosition(LONG, 100n * E18, 10n))
      .to.be.revertedWithCustomError(vault, "Insolvent");
  });

  it("settles against the canonical price only", async function () {
    await vault.connect(lp).deposit(1000n * E18);
    await expect(vault.connect(trader).openPosition(LONG, 100n * E18, 10n))
      .to.be.revertedWithCustomError(vault, "PriceUnavailable");
  });

  it("LP can withdraw against conservative equity", async function () {
    await vault.connect(lp).deposit(1000n * E18);
    await vault.connect(lp).withdraw(1000n * E18);

    expect(await vault.totalShares()).to.equal(0n);
    expect(await vault.balance()).to.equal(0n);
    expect(await quote.balanceOf(lp.address)).to.equal(100_000n * E18);
  });

  // ==================================================================
  // M5 — hardening (tech-spec §14 / §1.4 risks)
  // ==================================================================

  describe("M5 — payoff boundaries", function () {
    async function payoutAt(side, entryPrice, settlePrice) {
      await setPrice(entryPrice);
      const id = await vault.positionCount();
      await vault.connect(trader).openPosition(side, 100n * E18, 10n);
      await setPrice(settlePrice);
      const payout = await vault.connect(keeper).settlePosition.staticCall(id);
      await vault.connect(keeper).settlePosition(id);
      return payout;
    }

    it("S = 2·S0 is the exact cap boundary (LONG 2N, SHORT 0)", async function () {
      await vault.connect(lp).deposit(1000n * E18);
      expect(await payoutAt(LONG, 100n * E18, 200n * E18)).to.equal(198n * E18); // 2N
      expect(await payoutAt(SHORT, 100n * E18, 200n * E18)).to.equal(0n);
    });

    it("S = 5·S0 stays capped (LONG 2N, SHORT 0)", async function () {
      await vault.connect(lp).deposit(1000n * E18);
      expect(await payoutAt(LONG, 100n * E18, 500n * E18)).to.equal(198n * E18);
      expect(await payoutAt(SHORT, 100n * E18, 500n * E18)).to.equal(0n);
    });

    it("extreme low S floors LONG to 1 wei / SHORT to 2N−1 wei (S→0 limit)", async function () {
      await vault.connect(lp).deposit(1000n * E18);
      // The spec §4.2 "S = 0" row is the continuous limit. In the integer
      // contract a zero canonical price can never be settled against
      // (settlePrice == 0 reverts PriceUnavailable) and flooring keeps the
      // payoff strictly inside [0, 2N]; S = 1 wei is the closest reachable point.
      expect(await payoutAt(LONG, 100n * E18, 1n)).to.equal(1n);
      expect(await payoutAt(SHORT, 100n * E18, 1n)).to.equal(198n * E18 - 1n);
    });

    it("a zero canonical price is rejected (never settles at S = 0)", async function () {
      await setPrice(100n * E18);
      await vault.connect(lp).deposit(1000n * E18);
      await vault.connect(trader).openPosition(LONG, 100n * E18, 10n);
      await setPrice(0n); // canonical price 0 exists, but is not settleable
      await expect(vault.connect(trader).settlePosition(0))
        .to.be.revertedWithCustomError(vault, "PriceUnavailable");
    });
  });

  it("second LP deposit mints at the changed equity", async function () {
    await setPrice(100n * E18);
    await vault.connect(lp).deposit(1000n * E18); // 1000 shares @ equity 1000

    await vault.connect(trader).openPosition(LONG, 100n * E18, 10n);
    await setPrice(100n * E18); // flat
    await vault.connect(trader).settlePosition(0);
    expect(await vault.equity()).to.equal(1001n * E18); // +1 fee

    // deposit 500.5 at equity 1001 -> shares = 500.5 * 1000 / 1001 = 500
    await vault.connect(lp2).deposit((5005n * E18) / 10n);
    expect(await vault.shares(lp2.address)).to.equal(500n * E18);
    expect(await vault.totalShares()).to.equal(1500n * E18);
    await assertInvariants();
  });

  it("deposit reverts at zero equity with existing shares (§6.3)", async function () {
    await setPrice(100n * E18);
    // Reserve the pool fully: LP 98 + trader D=100 → balance 198 == pendingPayout 198 → equity 0.
    await vault.connect(lp).deposit(98n * E18);
    await vault.connect(trader).openPosition(LONG, 100n * E18, 10n);
    expect(await vault.equity()).to.equal(0n);
    expect(await vault.totalShares()).to.equal(98n * E18);

    // A 1:1 mint here would donate most of the deposit to incumbent LPs, so it must revert.
    await expect(vault.connect(lp2).deposit(10n * E18))
      .to.be.revertedWithCustomError(vault, "DepositAtZeroEquity");
    await assertInvariants();
  });

  it("deposit-dilution window (§6.5): newcomer buys at the dipped equity", async function () {
    await setPrice(100n * E18);
    await vault.connect(lp).deposit(1000n * E18); // LP1: 1000 shares

    await vault.connect(trader).openPosition(LONG, 100n * E18, 10n);
    expect(await vault.equity()).to.equal(902n * E18); // worst-case dip

    await vault.connect(lp2).deposit(902n * E18); // LP2 mints 902 * 1000 / 902 = 1000
    expect(await vault.shares(lp2.address)).to.equal(1000n * E18);

    await setPrice(100n * E18); // flat
    await vault.connect(trader).settlePosition(0);
    expect(await vault.equity()).to.equal(1903n * E18);

    // spec §6.5 worked example: flat settle leaves LP1 951.5 / LP2 951.5
    expect(await vault.connect(lp).withdraw.staticCall(1000n * E18)).to.equal((9515n * E18) / 10n);
    await vault.connect(lp).withdraw(1000n * E18);
    expect(await vault.connect(lp2).withdraw.staticCall(1000n * E18)).to.equal((9515n * E18) / 10n);
    await vault.connect(lp2).withdraw(1000n * E18);

    // LP1 1000 → 951.5 (−48.5); LP2 902 → 951.5 (+49.5): the fee + recovery transfer
    expect(await quote.balanceOf(lp.address) - 100_000n * E18).to.equal((-485n * E18) / 10n);
    expect(await quote.balanceOf(lp2.address) - 100_000n * E18).to.equal((495n * E18) / 10n);
    await assertInvariants();
  });

  it("partial withdraw while positions are open never exceeds free capital", async function () {
    await setPrice(100n * E18);
    await vault.connect(lp).deposit(1000n * E18);
    await vault.connect(trader).openPosition(LONG, 100n * E18, 100n); // stays OPEN

    const equity = await vault.equity(); // 902
    const supply = await vault.totalShares(); // 1000
    const burn = 400n * E18;
    const expected = (burn * equity) / supply; // 360.8

    const amount = await vault.connect(lp).withdraw.staticCall(burn);
    expect(amount).to.equal(expected);
    // spec §6.4 assertion (vacuously true by construction): amount <= balance − pendingPayout
    const free = (await vault.balance()) - (await vault.pendingPayout());
    expect(amount <= free).to.equal(true, "amount <= balance - pendingPayout");

    await vault.connect(lp).withdraw(burn);
    expect(await vault.shares(lp.address)).to.equal(600n * E18);
    expect(await vault.totalShares()).to.equal(600n * E18);
    await assertInvariants();
  });

  it("settlement is permissionless: a third party settles, owner is paid", async function () {
    await setPrice(100n * E18);
    await vault.connect(lp).deposit(1000n * E18);
    await vault.connect(trader).openPosition(LONG, 100n * E18, 10n);
    await setPrice(150n * E18);

    const traderBefore = await quote.balanceOf(trader.address);
    const keeperBefore = await quote.balanceOf(keeper.address);
    await vault.connect(keeper).settlePosition(0); // not the position owner
    expect(await quote.balanceOf(trader.address)).to.equal(traderBefore + (1485n * E18) / 10n);
    expect(await quote.balanceOf(keeper.address)).to.equal(keeperBefore);
  });

  it("double settle reverts NotOpen", async function () {
    await setPrice(100n * E18);
    await vault.connect(lp).deposit(1000n * E18);
    await vault.connect(trader).openPosition(LONG, 100n * E18, 10n);
    await setPrice(100n * E18);
    await vault.connect(keeper).settlePosition(0);
    await expect(vault.connect(keeper).settlePosition(0)).to.be.revertedWithCustomError(vault, "NotOpen");
  });

  it("fee routing: equity delta == fee − pnl per scenario (§6.5)", async function () {
    await setPrice(100n * E18);
    await vault.connect(lp).deposit(10_000n * E18);

    const fee = 1n * E18;
    const notional = 99n * E18;
    const scenarios = [
      { side: LONG, settle: 200n * E18 }, // up, capped
      { side: LONG, settle: 100n * E18 }, // flat
      { side: LONG, settle: 50n * E18 }, // down
      { side: SHORT, settle: 50n * E18 }, // short profits
      { side: SHORT, settle: 200n * E18 }, // short loses, capped
    ];

    for (const sc of scenarios) {
      await setPrice(100n * E18);
      const equityBefore = await vault.equity();
      const id = await vault.positionCount();
      await vault.connect(trader).openPosition(sc.side, 100n * E18, 10n);
      await setPrice(sc.settle);
      const payout = await vault.connect(keeper).settlePosition.staticCall(id);
      await vault.connect(keeper).settlePosition(id);
      const equityAfter = await vault.equity();

      expect(payout >= 0n && payout <= 2n * notional).to.equal(true, "payout ∈ [0, 2N]");
      const pnl = payout - notional; // signed option P&L, ex-premium
      expect(equityAfter - equityBefore).to.equal(fee - pnl);
    }
    await assertInvariants();
  });

  it("invariants hold under a deterministic 50-op fuzz (§14)", async function () {
    await setPrice(100n * E18);
    await vault.connect(lp).deposit(500n * E18);

    let state = 0x9e3779b97f4a7c15n;
    const MASK = (1n << 64n) - 1n;
    const rand = () => (state = (state * 6364136223846793005n + 1442695040888963407n) & MASK);
    const randInt = (max) => Number(rand() % BigInt(max));

    // Only the vault's own expected failures are swallowed; anything else is a bug and
    // must fail the test (e.g. an unexpected ERC20 revert or a Panic). In this stack a
    // revert surfaces with the 4-byte custom-error selector in `err.data`, which we
    // decode against the vault ABI.
    const EXPECTED_REVERTS = new Set(["Insolvent", "NotExpired", "NotOpen", "PriceUnavailable", "DepositAtZeroEquity"]);
    const isExpectedRevert = (err) => {
      if (typeof err?.data !== "string") return false;
      try {
        const parsed = vault.interface.parseError(err.data);
        return !!parsed && EXPECTED_REVERTS.has(parsed.name);
      } catch {
        return false;
      }
    };

    let depositOk = 0;
    let openOk = 0;
    let settleOk = 0;
    let withdrawOk = 0;

    for (let i = 0; i < 50; i++) {
      const op = randInt(6);
      try {
        if (op === 0 || op === 1) {
          await vault.connect(lp).deposit(BigInt(randInt(50) + 1) * E18);
          depositOk++;
        } else if (op === 2 || op === 3) {
          await vault.connect(trader).openPosition(randInt(2), BigInt(randInt(80) + 1) * E18, randInt(12) + 1);
          openOk++;
        } else if (op === 4) {
          await mineBlocks(randInt(3) + 1);
          const n = Number(await vault.positionCount());
          if (n > 0) {
            await vault.connect(keeper).settlePosition(randInt(n));
            settleOk++;
          }
        } else {
          const sh = await vault.shares(lp.address);
          if (sh > 0n) {
            await vault.connect(lp).withdraw((rand() % sh) + 1n);
            withdrawOk++;
          }
        }
      } catch (err) {
        if (!isExpectedRevert(err)) throw err;
      }

      if (i % 8 === 0) {
        await setPrice(BigInt(randInt(200) + 1) * E18);
      }
      await assertInvariants();
    }

    // The fuzz is only meaningful if it actually exercised each operation class.
    expect(depositOk, "fuzz exercised deposit").to.be.greaterThan(0);
    expect(openOk, "fuzz exercised openPosition").to.be.greaterThan(0);
    expect(settleOk, "fuzz exercised settlePosition").to.be.greaterThan(0);
    expect(withdrawOk, "fuzz exercised withdraw").to.be.greaterThan(0);
  });

  it("overflow guard: checked math reverts instead of mispaying (§13.5)", async function () {
    // entry price = 1 wei
    await setPrice(1n);
    const big = 10n ** 40n;
    await quote.mint(lp.address, 10n * big);
    await quote.mint(trader.address, big);
    await vault.connect(lp).deposit(10n * big); // reserve the huge worst case
    await vault.connect(trader).openPosition(LONG, big, 10n); // D = 1e40

    // settle at an enormous price: (S − S0) × N overflows uint256 inside _payout
    await quote.mint(provider.address, big);
    await setPrice(big);

    await expect(vault.connect(keeper).settlePosition(0)).to.be.revertedWithPanic(0x11);
  });

  it("vault quote-token balance always equals the cached balance", async function () {
    await setPrice(100n * E18);
    await vault.connect(lp).deposit(1000n * E18);
    expect(await quote.balanceOf(vault.target)).to.equal(await vault.balance());

    await vault.connect(trader).openPosition(LONG, 100n * E18, 10n);
    expect(await quote.balanceOf(vault.target)).to.equal(await vault.balance());

    await setPrice(150n * E18);
    await vault.connect(keeper).settlePosition(0);
    expect(await quote.balanceOf(vault.target)).to.equal(await vault.balance());

    await vault.connect(lp).withdraw(500n * E18);
    expect(await quote.balanceOf(vault.target)).to.equal(await vault.balance());
    await assertInvariants();
  });
});
