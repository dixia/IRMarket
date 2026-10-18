/**
 * MonoracleMock — Hardhat test suite.
 * Covers the IRMarket fork of the Monoracle veto-arbitrage oracle where the
 * verification window is per-quote (`expiryBlock`) instead of a fixed 2 slots.
 * Derived from upstream github.com/dixia/monoracle (Veto-Market PRD V0.8, D-13).
 * Mirrors upstream lazy/implicit settlement: a quote is canonical once
 * block.number > expiryBlock with NO settle transaction; getLatestPrice walks the
 * pair's quote list (latestQuoteId_ / prevQuoteId_, capped at MAX_PRICE_WALK) and
 * falls back to the settleValidQuote checkpoint pointer (latestValidQuoteId_).
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

describe("MonoracleMock — per-quote expiry window", function () {
  let oracle, base, quote, provider, verifier;

  beforeEach(async function () {
    const [p, v] = await ethers.getSigners();
    provider = p;
    verifier = v;

    const Oracle = await ethers.getContractFactory("MonoracleMock");
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

  async function submitQuote(expiryBlock, quoteAmount = 100n * E18) {
    return await oracle.connect(provider).submitQuote(
      base.target, quote.target,
      1n * E18,          // baseAmount  = 1 LLM
      quoteAmount,       // quoteAmount = price HKD per LLM (1e18 fixed-point)
      expiryBlock
    );
  }

  function pairKey() {
    return ethers.keccak256(
      ethers.solidityPacked(["address", "address"], [base.target, quote.target])
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

  it("allows veto exactly at expiryBlock (inclusive)", async function () {
    const block = BigInt(await currentBlock());
    const expiryBlock = block + 10n;
    await submitQuote(expiryBlock);

    const afterSubmit = BigInt(await currentBlock());
    const blocksToMine = Number(expiryBlock - 1n - afterSubmit);
    if (blocksToMine > 0) {
      await mineBlocks(blocksToMine);
    }

    const tx = await oracle.connect(verifier).vetoUnderpriced(1);
    await expect(tx).to.emit(oracle, "QuoteVetoedUnderpriced").withArgs(1n, verifier.address);
  });

  it("settles a valid quote and provider withdraws only own collateral", async function () {
    const block = await currentBlock();
    await submitQuote(block + 10);
    await mineBlocks(11);
    await oracle.settleValidQuote(1);
    await oracle.connect(provider).withdrawProviderFunds(1);

    expect(await base.balanceOf(provider.address)).to.equal(1000n * E18);
    expect(await quote.balanceOf(provider.address)).to.equal(100000n * E18);
  });

  it("reverts double withdrawal of provider funds", async function () {
    const block = await currentBlock();
    await submitQuote(block + 10);
    await mineBlocks(11);
    await oracle.settleValidQuote(1);
    await oracle.connect(provider).withdrawProviderFunds(1);

    await expect(oracle.connect(provider).withdrawProviderFunds(1))
      .to.be.revertedWithCustomError(oracle, "NotWithdrawable");
  });

  it("reverts withdrawProviderFunds by non-provider", async function () {
    const block = await currentBlock();
    await submitQuote(block + 10);
    await mineBlocks(11);
    await oracle.settleValidQuote(1);

    await expect(oracle.connect(verifier).withdrawProviderFunds(1))
      .to.be.revertedWithCustomError(oracle, "NotQuoteProvider");
  });

  it("newest matured quote is canonical with no settle tx (final quote = mark)", async function () {
    const block = await currentBlock();
    await submitQuote(block + 10, 100n * E18); // quote 1 @ 100 (round start)
    await submitQuote(block + 10, 200n * E18); // quote 2 @ 200 (round end / final quote)

    await mineBlocks(11); // both windows pass — zero settle calls

    const [price, settledSlot, exists] = await oracle.getLatestPrice(base.target, quote.target);
    expect(exists).to.equal(true);
    expect(price).to.equal(200n * E18); // the newest quote, not the first
    expect(settledSlot).to.equal(BigInt(block) + 10n); // expiryBlock backfill (D4)
  });

  it("a late checkpoint of an older quote does not overwrite the newer price", async function () {
    const block = await currentBlock();
    await submitQuote(block + 10, 100n * E18); // quote 1 @ 100 (older)
    await submitQuote(block + 10, 200n * E18); // quote 2 @ 200 (newer)

    await mineBlocks(11); // both matured, no settle yet

    // settleValidQuote stays as the optional checkpoint: it flips status, writes the
    // pointer and emits QuoteSettledValid — but the pointer no longer gates the price.
    await expect(oracle.settleValidQuote(1))
      .to.emit(oracle, "QuoteSettledValid").withArgs(1, 100n * E18);
    expect(await oracle.latestValidQuoteId(pairKey())).to.equal(1);

    const [price, , exists] = await oracle.getLatestPrice(base.target, quote.target);
    expect(exists).to.equal(true);
    expect(price).to.equal(200n * E18); // walk still returns the newest, not the last-settled
  });

  it("no canonical price before the window passes, canonical after — no settle tx", async function () {
    const block = await currentBlock();
    await submitQuote(block + 3); // quote 1 @ 100

    // inside the window: an immature ACTIVE quote is not canonical
    let [, , exists] = await oracle.getLatestPrice(base.target, quote.target);
    expect(exists).to.equal(false);

    await mineBlocks(4); // block.number > expiryBlock

    const [price, settledSlot, existsAfter] = await oracle.getLatestPrice(base.target, quote.target);
    expect(existsAfter).to.equal(true);
    expect(price).to.equal(100n * E18);
    expect(settledSlot).to.equal(BigInt(block) + 3n); // expiryBlock backfill (D4)
    expect((await oracle.quotes(1)).status).to.equal(0); // still ACTIVE — implicit settle
  });

  it("withdrawProviderFunds accepts a matured ACTIVE quote (implicit settlement)", async function () {
    const block = await currentBlock();
    await submitQuote(block + 10);
    await mineBlocks(11); // window passed, NO settle tx

    const tx = await oracle.connect(provider).withdrawProviderFunds(1);
    await expect(tx).to.emit(oracle, "FundsWithdrawn")
      .withArgs(1, provider.address, 1n * E18, 100n * E18);

    // payout = base + quote, settledSlot backfilled with expiryBlock (D4)
    expect(await base.balanceOf(provider.address)).to.equal(1000n * E18);
    expect(await quote.balanceOf(provider.address)).to.equal(100000n * E18);
    const q = await oracle.quotes(1);
    expect(q.status).to.equal(4); // SETTLED_WITHDRAWN
    expect(q.settledSlot).to.equal(BigInt(block) + 10n);

    // the quote remains canonical after withdrawal (D1 parity with SETTLED_VALID)
    const [price, settledSlot, exists] = await oracle.getLatestPrice(base.target, quote.target);
    expect(exists).to.equal(true);
    expect(price).to.equal(100n * E18);
    expect(settledSlot).to.equal(BigInt(block) + 10n);
  });

  it("withdrawProviderFunds still reverts inside the verification window", async function () {
    const block = await currentBlock();
    await submitQuote(block + 10);

    await expect(oracle.connect(provider).withdrawProviderFunds(1))
      .to.be.revertedWithCustomError(oracle, "VerificationWindowActive");
  });

  it("a vetoed quote is never canonical; the walk falls back to the older valid quote", async function () {
    const block = await currentBlock();
    await submitQuote(block + 10, 100n * E18); // quote 1 @ 100 (valid)
    await submitQuote(block + 10, 200n * E18); // quote 2 @ 200 (gets vetoed)

    await oracle.connect(verifier).vetoUnderpriced(2);
    await mineBlocks(11); // quote 1's window passes too

    const [price, , exists] = await oracle.getLatestPrice(base.target, quote.target);
    expect(exists).to.equal(true);
    expect(price).to.equal(100n * E18); // skipped the vetoed newest, fell back to quote 1
  });

  it("a vetoed-only pair has no canonical price", async function () {
    const block = await currentBlock();
    await submitQuote(block + 10);
    await oracle.connect(verifier).vetoUnderpriced(1);
    await mineBlocks(11);

    const [, , exists] = await oracle.getLatestPrice(base.target, quote.target);
    expect(exists).to.equal(false);
  });

  it("walk cap: hostile long-window quotes blank the price until a checkpoint floors it", async function () {
    const block = await currentBlock();
    await submitQuote(block + 3); // quote 1 @ 100, canonical once its window passes
    await mineBlocks(4);

    // MAX_PRICE_WALK long-window quotes parked in front of the canonical one
    const hostileExpiry = BigInt(await currentBlock()) + 12000n; // max window, stays immature
    for (let i = 0; i < Number(await oracle.MAX_PRICE_WALK()); i++) {
      await submitQuote(hostileExpiry, 100n * E18);
    }

    // cap exhausted and no checkpoint -> fail-closed
    let [, , exists] = await oracle.getLatestPrice(base.target, quote.target);
    expect(exists).to.equal(false);

    // checkpoint the old quote -> the floor fallback returns it
    const settled = await (await oracle.settleValidQuote(1)).wait();
    const [price, settledSlot, existsAfter] = await oracle.getLatestPrice(base.target, quote.target);
    expect(existsAfter).to.equal(true);
    expect(price).to.equal(100n * E18);
    expect(settledSlot).to.equal(BigInt(settled.blockNumber));
  });

  it("pair isolation: reversed token order walks its own list", async function () {
    const block = await currentBlock();
    await submitQuote(block + 10, 100n * E18); // pair (base, quote) @ 100
    await mineBlocks(11);

    // same tokens, reversed order = a distinct pair with no quotes
    let [, , existsReversed] = await oracle.getLatestPrice(quote.target, base.target);
    expect(existsReversed).to.equal(false);

    await oracle.connect(provider).submitQuote(
      quote.target, base.target, 1n * E18, 50n * E18, block + 20
    );
    await mineBlocks(11);

    const [fwd] = await oracle.getLatestPrice(base.target, quote.target);
    const [rev, , revExists] = await oracle.getLatestPrice(quote.target, base.target);
    expect(revExists).to.equal(true);
    expect(fwd).to.equal(100n * E18); // the forward pair is undisturbed
    expect(rev).to.equal(50n * E18);
  });
});
