/**
 * IRMarket — Hardhat test suite.
 * Covers the thin factory + fee wrapper over MonoracleWindowed (Veto-Market, V0.9):
 *   - market registry (no pair dedup, D-14) + validation
 *   - openLong / openShort fee wrapper (1% in HKD, D-11/D-16)
 *   - oracle passthrough & window pre-checks
 *   - zero-sum invariant (D-10) between trader and provider
 */
import { expect } from "chai";
import hre from "hardhat";

const { ethers } = await hre.network.create();

const E18 = 10n ** 18n;
const MAX_FEE_BPS = 10000n;

async function currentBlock() {
  return await ethers.provider.getBlockNumber();
}

async function mineBlocks(n) {
  for (let i = 0; i < n; i++) {
    await ethers.provider.send("evm_mine", []);
  }
}

describe("IRMarket — market registry (D-07/D-14)", function () {
  let oracle, base, quote, market, mm, creator;
  let expiry;

  beforeEach(async function () {
    const [c, m] = await ethers.getSigners();
    creator = c;
    mm = m;

    const Oracle = await ethers.getContractFactory("MonoracleWindowed");
    oracle = await Oracle.deploy();

    const Token = await ethers.getContractFactory("MockERC20");
    base = await Token.deploy("Liuliumei", "LLM", 18);
    quote = await Token.deploy("HKD", "HKD", 18);

    const IRMarket = await ethers.getContractFactory("IRMarket");
    market = await IRMarket.deploy(oracle.target);

    expiry = BigInt(await currentBlock()) + 600n; // demo 3 min ≈ 600 blocks
    await market.connect(creator).createMarket(
      base.target, quote.target, mm.address, expiry, 100n // feeBps = 1%
    );
  });

  it("creates a market and grants the oracle max allowance", async function () {
    const m = await market.markets(1);
    expect(m.baseToken).to.equal(base.target);
    expect(m.quoteToken).to.equal(quote.target);
    expect(m.marketMaker).to.equal(mm.address);
    expect(m.feeBps).to.equal(100n);
    expect(m.expiryBlock).to.equal(expiry);
    expect(m.createdAtBlock).to.be.gt(0);

    // wrapper must be able to veto on behalf of traders
    expect(await base.allowance(market.target, oracle.target)).to.equal(ethers.MaxUint256);
    expect(await quote.allowance(market.target, oracle.target)).to.equal(ethers.MaxUint256);

    await expect(
      market.connect(creator).createMarket(base.target, quote.target, mm.address, expiry, 100n)
    ).to.emit(market, "MarketCreated");
  });

  it("allows multiple markets for the same pair (no dedup, D-14)", async function () {
    await market.connect(creator).createMarket(base.target, quote.target, mm.address, expiry, 50n);
    await market.connect(creator).createMarket(base.target, quote.target, mm.address, expiry + 100n, 100n);

    expect(await market.nextMarketId()).to.equal(4n);
    expect((await market.markets(1))[0]).to.equal(base.target);
    expect((await market.markets(2))[0]).to.equal(base.target);
    expect((await market.markets(3))[0]).to.equal(base.target);
  });

  it("validates inputs: fees, expiry, tokens", async function () {
    await expect(
      market.createMarket(base.target, quote.target, mm.address, expiry, MAX_FEE_BPS)
    ).to.be.revertedWithCustomError(market, "FeeTooHigh");

    const past = (await currentBlock()) - 1;
    await expect(
      market.createMarket(base.target, quote.target, mm.address, past, 100n)
    ).to.be.revertedWithCustomError(market, "ExpiryMustBeFuture");

    await expect(
      market.createMarket(ethers.ZeroAddress, quote.target, mm.address, expiry, 100n)
    ).to.be.revertedWithCustomError(market, "InvalidToken");

    await expect(
      market.createMarket(base.target, base.target, mm.address, expiry, 100n)
    ).to.be.revertedWithCustomError(market, "IdenticalTokens");
  });

  it("rejects trading on a missing market", async function () {
    await expect(market.openLong(0, 1)).to.be.revertedWithCustomError(market, "MarketDoesNotExist");
  });
});

describe("IRMarket — fee wrapper (D-11/D-16)", function () {
  let oracle, base, quote, market, mm, provider, trader;
  let expiry;

  beforeEach(async function () {
    const [c, p, t, m] = await ethers.getSigners();
    mm = m;
    provider = p;
    trader = t;

    const Oracle = await ethers.getContractFactory("MonoracleWindowed");
    oracle = await Oracle.deploy();

    const Token = await ethers.getContractFactory("MockERC20");
    base = await Token.deploy("Liuliumei", "LLM", 18);
    quote = await Token.deploy("HKD", "HKD", 18);

    // fund provider (quote maker, bilateral collateral) and trader
    await base.mint(provider.address, 1000n * E18);
    await quote.mint(provider.address, 1000000n * E18);
    await base.mint(trader.address, 100n * E18);
    await quote.mint(trader.address, 100000n * E18);

    const IRMarket = await ethers.getContractFactory("IRMarket");
    market = await IRMarket.deploy(oracle.target);

    await base.connect(provider).approve(oracle.target, ethers.MaxUint256);
    await quote.connect(provider).approve(oracle.target, ethers.MaxUint256);
    await base.connect(trader).approve(market.target, ethers.MaxUint256);
    await quote.connect(trader).approve(market.target, ethers.MaxUint256);

    expiry = (await currentBlock()) + 600;
    await market.createMarket(base.target, quote.target, mm.address, expiry, 100n); // 1%
  });

  async function submitQuote(baseAmount = 1n * E18, quoteAmount = 100n * E18) {
    await oracle.connect(provider).submitQuote(base.target, quote.target, baseAmount, quoteAmount, expiry);
  }

  it("openLong: pulls quoteAmount + fee (HKD), forwards base LLM, pays MM the fee", async function () {
    await submitQuote();

    const traderHKD0 = await quote.balanceOf(trader.address);
    const traderLLM0 = await base.balanceOf(trader.address);
    const mmHKD0 = await quote.balanceOf(mm.address);
    const mmLLM0 = await base.balanceOf(mm.address);

    const fee = (100n * E18 * 100n) / MAX_FEE_BPS; // 1 HKD

    const tx = await market.connect(trader).openLong(1, 1);

    // trader: net HKD = -(100 + 1), net LLM = +1
    expect(await quote.balanceOf(trader.address)).to.equal(traderHKD0 - 101n * E18);
    expect(await base.balanceOf(trader.address)).to.equal(traderLLM0 + 1n * E18);

    // MM: received fee in HKD only
    expect(await quote.balanceOf(mm.address)).to.equal(mmHKD0 + fee);
    expect(await base.balanceOf(mm.address)).to.equal(mmLLM0);

    // oracle quote now vetoed
    expect((await oracle.quotes(1)).status).to.equal(1); // VETOED_UNDERPRICED

    await expect(tx).to.emit(market, "VetoWrapped")
      .withArgs(1n, 1n, trader.address, 0, 100n * E18, 1n * E18, fee);
  });

  it("openLong: fee = 0 passes through gross amount", async function () {
    // second market, no fee
    await market.createMarket(base.target, quote.target, mm.address, expiry, 0n);

    await submitQuote(); // quote 1
    await oracle.connect(provider).submitQuote(base.target, quote.target, 2n * E18, 200n * E18, expiry); // quote 2

    const traderHKD0 = await quote.balanceOf(trader.address);
    const mmHKD0 = await quote.balanceOf(mm.address);

    await market.connect(trader).openLong(2, 2);

    expect(await quote.balanceOf(trader.address)).to.equal(traderHKD0 - 200n * E18); // no fee
    expect(await quote.balanceOf(mm.address)).to.equal(mmHKD0); // MM got nothing

    await expect(
      market.connect(trader).openLong(2, 2)
    ).to.be.revertedWithCustomError(market, "QuoteNotActive"); // already vetoed
  });

  it("openShort: pulls base LLM, forwards quoteAmount - fee (HKD), pays MM the fee", async function () {
    await submitQuote();

    const traderHKD0 = await quote.balanceOf(trader.address);
    const traderLLM0 = await base.balanceOf(trader.address);
    const mmHKD0 = await quote.balanceOf(mm.address);
    const mmLLM0 = await base.balanceOf(mm.address);

    const fee = (100n * E18 * 100n) / MAX_FEE_BPS; // 1 HKD

    const tx = await market.connect(trader).openShort(1, 1);

    // trader: net HKD = +(100-1), net LLM = -1
    expect(await quote.balanceOf(trader.address)).to.equal(traderHKD0 + 99n * E18);
    expect(await base.balanceOf(trader.address)).to.equal(traderLLM0 - 1n * E18);

    // MM: 1 HKD fee
    expect(await quote.balanceOf(mm.address)).to.equal(mmHKD0 + fee);
    expect(await base.balanceOf(mm.address)).to.equal(mmLLM0);

    expect((await oracle.quotes(1)).status).to.equal(2); // VETOED_OVERPRICED

    await expect(tx).to.emit(market, "VetoWrapped")
      .withArgs(1n, 1n, trader.address, 1, 1n * E18, 99n * E18, fee);
  });

  it("rejects a quote from a different pair", async function () {
    await submitQuote();

    const Token = await ethers.getContractFactory("MockERC20");
    const other = await Token.deploy("Other", "OTH", 18);
    await other.mint(provider.address, 1000n * E18);
    await other.connect(provider).approve(oracle.target, ethers.MaxUint256);
    await oracle.connect(provider).submitQuote(other.target, quote.target, 1n * E18, 100n * E18, expiry);

    await expect(market.connect(trader).openLong(1, 2))
      .to.be.revertedWithCustomError(market, "QuotePairMismatch");
  });

  it("reverts openLong past the quote expiry window", async function () {
    await oracle.connect(provider).submitQuote(
      base.target, quote.target, 1n * E18, 100n * E18, (await currentBlock()) + 2
    );
    await mineBlocks(3);

    await expect(market.connect(trader).openLong(1, 1))
      .to.be.revertedWithCustomError(market, "QuoteWindowExpired");
  });

  it("passes through unsafe conditions: allowance, already-vetoed, reentrancy guard", async function () {
    await submitQuote();

    // trader without market allowance -> safeTransferFrom bubbles ERC20InsufficientAllowance
    const [alt] = await ethers.getSigners();
    await quote.mint(alt.address, 1000n * E18);
    await expect(market.connect(alt).openLong(1, 1))
      .to.be.revertedWithCustomError(quote, "ERC20InsufficientAllowance");

    // double veto (already vetoed by direct call) -> QuoteNotActive pre-check
    await quote.connect(trader).approve(oracle.target, ethers.MaxUint256);
    await oracle.connect(trader).vetoUnderpriced(1); // trader already approved oracle
    await expect(market.connect(trader).openShort(1, 1))
      .to.be.revertedWithCustomError(market, "QuoteNotActive");
  });
});

describe("IRMarket — zero-sum invariant (D-10)", function () {
  it("trader profit mirrors provider loss on a vetoed quote", async function () {
    const [c, p, t, m] = await ethers.getSigners();

    const Oracle = await ethers.getContractFactory("MonoracleWindowed");
    const oracle = await Oracle.deploy();

    const Token = await ethers.getContractFactory("MockERC20");
    const base = await Token.deploy("Liuliumei", "LLM", 18);
    const quote = await Token.deploy("HKD", "HKD", 18);

    const IRMarket = await ethers.getContractFactory("IRMarket");
    const market = await IRMarket.deploy(oracle.target);

    const expiry = (await currentBlock()) + 600;
    await market.createMarket(base.target, quote.target, m.address, expiry, 0n); // fee-free for the invariant test

    // fair market price T = 120 HKD/LLM; provider quotes P = 100 (underpriced)
    const T = 120n * E18;
    await base.mint(p.address, 100n * E18);
    await quote.mint(p.address, 100000n * E18);
    await base.mint(t.address, 100n * E18);
    await quote.mint(t.address, 100000n * E18);

    await base.connect(p).approve(oracle.target, ethers.MaxUint256);
    await quote.connect(p).approve(oracle.target, ethers.MaxUint256);
    await base.connect(t).approve(market.target, ethers.MaxUint256);
    await quote.connect(t).approve(market.target, ethers.MaxUint256);

    const pLLM0 = await base.balanceOf(p.address);
    const pHKD0 = await quote.balanceOf(p.address);
    const tLLM0 = await base.balanceOf(t.address);
    const tHKD0 = await quote.balanceOf(t.address);

    // quote: 1 LLM collateral vs 100 HKD collateral (price = 100)
    await oracle.connect(p).submitQuote(base.target, quote.target, 1n * E18, 100n * E18, expiry);

    // trader goes LONG (vetoUnderpriced) through the wrapper, fee-free
    await market.connect(t).openLong(1, 1);

    // provider withdraws after the veto: loses the base, keeps 2x quote
    await oracle.connect(p).withdrawProviderFunds(1);

    // value both sides at the fair price T (HKD-denominated)
    const pValue0 = pHKD0 + (pLLM0 * T) / E18;
    const pValue1 = (await quote.balanceOf(p.address)) + ((await base.balanceOf(p.address)) * T) / E18;
    const tValue0 = tHKD0 + (tLLM0 * T) / E18;
    const tValue1 = (await quote.balanceOf(t.address)) + ((await base.balanceOf(t.address)) * T) / E18;

    const traderGain = tValue1 - tValue0;
    const providerLoss = pValue0 - pValue1;

    // trader +1 LLM worth 120 vs paid 100 => +20; provider mirrors -20
    expect(traderGain).to.equal(20n * E18);
    expect(providerLoss).to.equal(20n * E18);
    expect(traderGain).to.equal(providerLoss); // zero-sum
  });
});