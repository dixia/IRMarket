/**
 * gas.test.js — gas-limit regression guard.
 *
 * Why: Monad charges `gas_limit × price_per_gas`, NOT gasUsed. Every fixed gas limit
 * in the bot (`bot/verifier.py` GAS table) and in the frontend
 * (`web/src/lib/config.ts`, `web/src/hooks/useVaultTrade.ts`) is therefore real money,
 * and an inflated limit silently overcharges on every send. This suite measures the
 * actual `gasUsed` of each write path and fails if any configured limit is either
 *   (a) too TIGHT  — the tx would run out of gas and revert, or
 *   (b) too LOOSE  — the caller is overpaying for gas they will never use.
 *
 * The limits below are duplicated from the source of truth on purpose: this file is
 * the tripwire that catches the two drifting apart. If you change a limit in
 * verifier.py / config.ts, change it here too — and re-measure with
 * `npx hardhat run script/gas-report.js`.
 *
 * NOTE: these assertions run against MonoracleMock, which packs its QuoteData into
 * fewer slots than the upstream Monoracle, so the oracle paths measured here are a
 * LOWER bound. The bot's limits also carry live-testnet head-room on top of these.
 */
import { expect } from "chai";
import hre from "hardhat";

const { ethers } = await hre.network.create();

const E18 = 10n ** 18n;

// ---------------------------------------------------------------------------
// Configured limits (mirror of bot/verifier.py GAS_DEFAULTS)
// ---------------------------------------------------------------------------
const BOT_GAS = {
  approve: 56_691n,
  submit_quote: 366_000n,
  settle: 72_956n,
  withdraw: 150_000n,
  create_market: 218_789n,
};

// ---------------------------------------------------------------------------
// Configured limits (mirror of web/src/lib/config.ts + useVaultTrade.ts)
// ---------------------------------------------------------------------------
const WEB_GAS = {
  approve: 60_000n,
  veto: 160_000n,
  wrapper: 260_000n,
  vaultDeposit: 200_000n,
  vaultWithdraw: 120_000n,
  vaultOpen: 400_000n,
  vaultSettle: 150_000n,
};

/** Every limit must clear this ratio over the worst measured gasUsed, or a slightly
 *  larger calldata / a colder storage page reverts the tx. */
const MIN_HEADROOM = 120n; // percent
/** ...and stay under this ratio, or the caller is overpaying. */
const MAX_HEADROOM = 400n; // percent

/** @param receipt an ethers TransactionReceipt (or anything with a bigint gasUsed). */
function assertSane(label, receipt, limit) {
  const used = receipt.gasUsed;
  const ratio = (limit * 100n) / used;
  expect(ratio, `${label}: gasUsed ${used} vs limit ${limit} (${ratio}% head-room)`)
    .to.be.gte(MIN_HEADROOM)
    .and.lte(MAX_HEADROOM);
}

/** Same lower bound as `assertSane`, without the upper bound: for paths where the local
 *  mock's measured usage is NOT a proxy for the contract shape production actually runs
 *  (the upstream Monoracle's withdraw path takes ~2.5x more gas than the mock's). */
function assertSaneFloor(label, receipt, limit) {
  const used = receipt.gasUsed;
  const ratio = (limit * 100n) / used;
  expect(ratio, `${label}: gasUsed ${used} vs limit ${limit} (${ratio}% head-room)`)
    .to.be.gte(MIN_HEADROOM);
}

async function currentBlock() {
  return await ethers.provider.getBlockNumber();
}

async function mineBlocks(n) {
  for (let i = 0; i < n; i++) {
    await ethers.provider.send("evm_mine", []);
  }
}

describe("gas limits — regression guard (Monad bills the limit, not gasUsed)", function () {
  let oracle, base, quote, market, vault, mm, lp, trader, provider;
  let expiry;

  beforeEach(async function () {
    const [dep, l, t, p, m] = await ethers.getSigners();
    mm = m;
    lp = l;
    trader = t;
    provider = p;

    const Oracle = await ethers.getContractFactory("MonoracleMock");
    oracle = await Oracle.deploy();

    const Token = await ethers.getContractFactory("MockERC20");
    base = await Token.deploy("Liuliumei", "LLM", 18);
    quote = await Token.deploy("HKD", "HKD", 18);

    const IRMarket = await ethers.getContractFactory("IRMarket");
    market = await IRMarket.deploy(oracle.target);

    const Vault = await ethers.getContractFactory("IRMarketVault");
    vault = await Vault.deploy(oracle.target, base.target, quote.target, 100n);

    await base.mint(provider.address, 1000n * E18);
    await quote.mint(provider.address, 1_000_000n * E18);
    await base.mint(trader.address, 1000n * E18);
    await quote.mint(trader.address, 1_000_000n * E18);
    await quote.mint(lp.address, 1_000_000n * E18);

    await base.connect(provider).approve(oracle.target, ethers.MaxUint256);
    await quote.connect(provider).approve(oracle.target, ethers.MaxUint256);
    await base.connect(trader).approve(market.target, ethers.MaxUint256);
    await quote.connect(trader).approve(market.target, ethers.MaxUint256);
    await base.connect(trader).approve(oracle.target, ethers.MaxUint256);
    await quote.connect(trader).approve(oracle.target, ethers.MaxUint256);
    await quote.connect(trader).approve(vault.target, ethers.MaxUint256);
    await quote.connect(lp).approve(vault.target, ethers.MaxUint256);

    expiry = BigInt(await currentBlock()) + 600n;
  });

  it("createMarket: the two forceApprove calls must be guarded", async function () {
    // First call for the pair pays two cold approvals.
    const first = await (
      await market.createMarket(base.target, quote.target, mm.address, expiry, 100n)
    ).wait();
    // A repeat call for the SAME pair must NOT re-approve: the spender and amount are
    // unchanged, so re-approving is pure waste (~40k gas) on every round roll.
    const repeat = await (
      await market.createMarket(base.target, quote.target, mm.address, expiry, 100n)
    ).wait();

    assertSane("createMarket (first)", first, BOT_GAS.create_market);
    // The repeat is the steady-state path the bot hits once per pair per round.
    assertSane("createMarket (repeat, guarded)", repeat, BOT_GAS.create_market);

    // The guard must actually save gas, and the oracle must still hold the allowance.
    expect(repeat.gasUsed).to.be.lt(first.gasUsed);
    expect(await base.allowance(market.target, oracle.target)).to.equal(ethers.MaxUint256);
    expect(await quote.allowance(market.target, oracle.target)).to.equal(ethers.MaxUint256);
  });

  it("erc20.approve fits the bot and web limits", async function () {
    const fresh = await (await ethers.getContractFactory("MockERC20")).deploy("A", "A", 18);
    const receipt = await (
      await fresh.connect(trader).approve(oracle.target, ethers.MaxUint256)
    ).wait();
    assertSane("approve", receipt, BOT_GAS.approve);
    assertSane("approve (web)", receipt, WEB_GAS.approve);
  });

  it("submitQuote fits the bot limit", async function () {
    await market.createMarket(base.target, quote.target, mm.address, expiry, 100n);
    const receipt = await (
      await oracle.connect(provider).submitQuote(base.target, quote.target, E18, 100n * E18, expiry)
    ).wait();
    assertSane("submitQuote", receipt, BOT_GAS.submit_quote);
  });

  it("settleValidQuote + withdrawProviderFunds fit the bot limits", async function () {
    await market.createMarket(base.target, quote.target, mm.address, expiry, 100n);
    const submitted = await (
      await oracle.connect(provider).submitQuote(base.target, quote.target, E18, 100n * E18, expiry)
    ).wait();
    const quoteId = submitted.logs
      .map(l => { try { return oracle.interface.parseLog(l); } catch { return null; } })
      .find(l => l && l.name === "QuoteSubmitted").args[0];

    await mineBlocks(Number(expiry - BigInt(await currentBlock())) + 1);

    const settled = await (await oracle.settleValidQuote(quoteId)).wait();
    assertSane("settleValidQuote", settled, BOT_GAS.settle);

    const withdrawn = await (
      await oracle.connect(provider).withdrawProviderFunds(quoteId)
    ).wait();
    assertSane("withdrawProviderFunds (settled)", withdrawn, BOT_GAS.withdraw);
  });

  it("withdrawProviderFunds alone (no settle) fits the bot limit", async function () {
    // Lazy settlement: a matured ACTIVE quote is withdrawable with no settleValidQuote
    // tx (upstream parity — see MonoracleMock.test.js implicit-settlement cases). The
    // bot's sweep can therefore skip the optional checkpoint entirely.
    await market.createMarket(base.target, quote.target, mm.address, expiry, 100n);
    const submitted = await (
      await oracle.connect(provider).submitQuote(base.target, quote.target, E18, 100n * E18, expiry)
    ).wait();
    const quoteId = submitted.logs
      .map(l => { try { return oracle.interface.parseLog(l); } catch { return null; } })
      .find(l => l && l.name === "QuoteSubmitted").args[0];

    await mineBlocks(Number(expiry - BigInt(await currentBlock())) + 1);

    const withdrawn = await (
      await oracle.connect(provider).withdrawProviderFunds(quoteId)
    ).wait();
    assertSane("withdrawProviderFunds (implicit settle)", withdrawn, BOT_GAS.withdraw);
  });

  it("direct oracle vetoes fit the web close limit", async function () {
    await market.createMarket(base.target, quote.target, mm.address, expiry, 100n);

    const longReceipt = await (
      await oracle.connect(provider).submitQuote(base.target, quote.target, E18, 100n * E18, expiry)
    ).wait();
    const longId = longReceipt.logs
      .map(l => { try { return oracle.interface.parseLog(l); } catch { return null; } })
      .find(l => l && l.name === "QuoteSubmitted").args[0];
    const vetoLong = await (await oracle.connect(trader).vetoUnderpriced(longId)).wait();
    assertSane("vetoUnderpriced (web close)", vetoLong, WEB_GAS.veto);
    const withdrawLong = await (
      await oracle.connect(provider).withdrawProviderFunds(longId)
    ).wait();
    // The cap is enforced on the SETTLED variant above, which is the largest of the two
    // usages this same call takes locally. The vetoed variant cannot carry it: placing
    // the max on the smaller number is what produced a false 412% alarm when the bot's
    // withdraw limit was raised for the LIVE upstream oracle — locally we can only ever
    // measure the mock's shape, and the mock's vetoed variant is by far the cheaper one.
    assertSaneFloor("withdrawProviderFunds (vetoed)", withdrawLong, BOT_GAS.withdraw);

    const shortReceipt = await (
      await oracle.connect(provider).submitQuote(base.target, quote.target, E18, 100n * E18, expiry)
    ).wait();
    const shortId = shortReceipt.logs
      .map(l => { try { return oracle.interface.parseLog(l); } catch { return null; } })
      .find(l => l && l.name === "QuoteSubmitted").args[0];
    const vetoShort = await (await oracle.connect(trader).vetoOverpriced(shortId)).wait();
    assertSane("vetoOverpriced (web close)", vetoShort, WEB_GAS.veto);
  });

  it("openLong / openShort fit the web wrapper limit", async function () {
    await market.createMarket(base.target, quote.target, mm.address, expiry, 100n);
    const marketId = 1n;

    const openReceipt = async (side) => {
      const submitted = await (
        await oracle.connect(provider).submitQuote(base.target, quote.target, E18, 100n * E18, expiry)
      ).wait();
      const quoteId = submitted.logs
        .map(l => { try { return oracle.interface.parseLog(l); } catch { return null; } })
        .find(l => l && l.name === "QuoteSubmitted").args[0];
      return side === "long"
        ? await (await market.connect(trader).openLong(marketId, quoteId)).wait()
        : await (await market.connect(trader).openShort(marketId, quoteId)).wait();
    };

    assertSane("openLong (web wrapper)", await openReceipt("long"), WEB_GAS.wrapper);
    assertSane("openShort (web wrapper)", await openReceipt("short"), WEB_GAS.wrapper);
  });

  it("vault writes fit the web vault limits", async function () {
    // Seed a canonical price so openPosition has something to mark against.
    const submitted = await (
      await oracle.connect(provider).submitQuote(base.target, quote.target, E18, 100n * E18, expiry)
    ).wait();
    const quoteId = submitted.logs
      .map(l => { try { return oracle.interface.parseLog(l); } catch { return null; } })
      .find(l => l && l.name === "QuoteSubmitted").args[0];
    await mineBlocks(Number(expiry - BigInt(await currentBlock())) + 1);
    await (await oracle.settleValidQuote(quoteId)).wait();

    assertSane("vault.deposit",
      await (await vault.connect(lp).deposit(1000n * E18)).wait(), WEB_GAS.vaultDeposit);

    assertSane("vault.openPosition",
      await (await vault.connect(trader).openPosition(0, 100n * E18, 50n)).wait(), WEB_GAS.vaultOpen);

    const positionId = await vault.positionCount() - 1n;
    await mineBlocks(55);
    assertSane("vault.settlePosition",
      await (await vault.connect(trader).settlePosition(positionId)).wait(), WEB_GAS.vaultSettle);

    assertSane("vault.withdraw",
      await (await vault.connect(lp).withdraw(500n * E18)).wait(), WEB_GAS.vaultWithdraw);
  });
});
