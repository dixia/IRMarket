/**
 * MonoracleWindowed — Hardhat test suite.
 * Covers the IRMarket fork of the Monoracle veto-arbitrage oracle where the
 * verification window is per-quote (`expiryBlock`) instead of a fixed 2 slots.
 * Derived from upstream github.com/dixia/monoracle (Veto-Market PRD V0.8, D-13).
 */
import { expect } from "chai";
import hre from "hardhat";

const { ethers } = await hre.network.create();

const E18 = 10n ** 18n;

async function mineBlocks(n) {
  for (let i = 0; i < n; i++) {
    await ethers.provider.send("evm_mine", []);
  }
}

async function currentBlock() {
  return await ethers.provider.getBlockNumber();
}

describe("MonoracleWindowed — per-quote expiry window", function () {
  let oracle, base, quote, provider, verifier;

  beforeEach(async function () {
    const [p, v] = await ethers.getSigners();
    provider = p;
    verifier = v;

    const Oracle = await ethers.getContractFactory("MonoracleWindowed");
    oracle = await Oracle.deploy();

    const Token = await ethers.getContractFactory("MockERC20");
    base = await Token.deploy("Liuliumei", "LLM", 18);
    quote = await Token.deploy("HKD", "HKD", 18);

    await base.mint(provider.address, 1000n * E18);
    await quote.mint(provider.address, 100000n * E18);
    await base.mint(verifier.address, 1000n * E18);
    await quote.mint(verifier.address, 100000n * E18);

    await base.connect(provider).approve(oracle.target, ethers.MaxUint256);
    await quote.connect(provider).approve(oracle.target, ethers.MaxUint256);
    await base.connect(verifier).approve(oracle.target, ethers.MaxUint256);
    await quote.connect(verifier).approve(oracle.target, ethers.MaxUint256);
  });

  async function submitQuote(expiryBlock) {
    return await oracle.connect(provider).submitQuote(
      base.target, quote.target,
      1n * E18,          // baseAmount  = 1 LLM
      100n * E18,        // quoteAmount = 100 HKD => price = 100 HKD / LLM
      expiryBlock
    );
  }

  it("derives price and rejects past expiries", async function () {
    const block = await currentBlock();
    await expect(submitQuote(block)).to.be.revertedWithCustomError(oracle, "ExpiryMustBeFuture");

    const tx = await submitQuote(block + 100);
    const q = await oracle.quotes(1);
    expect(q.price).to.equal(100n * E18);
    expect(q.expiryBlock).to.equal(BigInt(block) + 100n);
    expect(q.status).to.equal(0); // ACTIVE
    await expect(tx).to.emit(oracle, "QuoteSubmitted").withArgs(1, provider.address, base.target, quote.target, 1n * E18, 100n * E18, 100n * E18, await currentBlock(), BigInt(block) + 100n);
  });

  it("allows veto at any time inside the window (the long trade)", async function () {
    const block = await currentBlock();
    await submitQuote(block + 100);
    await mineBlocks(50); // mid-window (far beyond the upstream 2-slot limit)

    const tx = await oracle.connect(verifier).vetoUnderpriced(1);
    await expect(tx).to.emit(oracle, "QuoteVetoedUnderpriced").withArgs(1, verifier.address);

    // verifier paid 100 HKD, received 1 LLM
    expect(await base.balanceOf(verifier.address)).to.equal(1001n * E18);
    expect(await quote.balanceOf(verifier.address)).to.equal(99900n * E18);

    // provider withdraws 2x quote, 0 base
    const q = await oracle.quotes(1);
    expect(q.status).to.equal(1); // VETOED_UNDERPRICED
    await oracle.connect(provider).withdrawProviderFunds(1);
    expect(await quote.balanceOf(provider.address)).to.equal(100000n * E18 + 100n * E18);
    expect(await base.balanceOf(provider.address)).to.equal(999n * E18);
  });

  it("allows the short trade via vetoOverpriced", async function () {
    const block = await currentBlock();
    await submitQuote(block + 100);

    await oracle.connect(verifier).vetoOverpriced(1);
    // verifier paid 1 LLM, received 100 HKD
    expect(await base.balanceOf(verifier.address)).to.equal(999n * E18);
    expect(await quote.balanceOf(verifier.address)).to.equal(100100n * E18);

    // provider withdraws 2x base, 0 quote
    await oracle.connect(provider).withdrawProviderFunds(1);
    expect(await base.balanceOf(provider.address)).to.equal(1001n * E18);
    expect(await quote.balanceOf(provider.address)).to.equal(99900n * E18);
  });

  it("reverts veto after expiry and settle before expiry", async function () {
    const block = await currentBlock();
    await submitQuote(block + 3);
    await mineBlocks(1); // still inside window

    await expect(oracle.settleValidQuote(1)).to.be.revertedWithCustomError(oracle, "VerificationWindowActive");

    await mineBlocks(3); // now past expiry
    await expect(oracle.connect(verifier).vetoUnderpriced(1)).to.be.revertedWithCustomError(oracle, "VerificationWindowExpired");
  });

  it("settles after expiry and feeds getLatestPrice", async function () {
    const block = await currentBlock();
    await submitQuote(block + 2);

    const [, , existsBefore] = await oracle.getLatestPrice(base.target, quote.target);
    expect(existsBefore).to.equal(false);

    await mineBlocks(3);
    await oracle.settleValidQuote(1);

    const [price, , exists] = await oracle.getLatestPrice(base.target, quote.target);
    expect(exists).to.equal(true);
    expect(price).to.equal(100n * E18);
  });

  it("last-settled quote wins the canonical price (final quote = mark)", async function () {
    const block = await currentBlock();
    await submitQuote(block + 10);       // quote 1 @ 100 (round start, survives)
    await submitQuote(block + 10);       // quote 2 @ 100 (round end / final quote)

    await mineBlocks(11);

    // settle in order: older first, final quote LAST (B12)
    await oracle.settleValidQuote(1);
    await oracle.settleValidQuote(2);

    const [, , exists] = await oracle.getLatestPrice(base.target, quote.target);
    expect(exists).to.equal(true);
    expect(await oracle.latestValidQuoteId(ethers.keccak256(
      ethers.solidityPacked(["address", "address"], [base.target, quote.target])
    ))).to.equal(2);
  });
});
