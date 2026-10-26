/**
 * IRMarketVaultFactory — Hardhat tests.
 *
 * The factory is the dedup point for per-pair vaults (LP-D12) and the way a
 * pair gets an LP page without an operator deploy. Tests pin: permissionless
 * creation, one vault per (base, quote), the fee cap, the views the web reads,
 * and that a factory-created vault actually works (deposit -> shares).
 */
import { expect } from "chai";
import hre from "hardhat";

const { ethers } = await hre.network.create();

const E18 = 10n ** 18n;

describe("IRMarketVaultFactory", function () {
  let oracle, usd, hkd, factory, creator, lp, other;

  beforeEach(async function () {
    [creator, lp, other] = await ethers.getSigners();

    oracle = await (await ethers.getContractFactory("MonoracleMock")).deploy();
    const Token = await ethers.getContractFactory("MockERC20");
    usd = await Token.deploy("USD", "USD", 18);
    hkd = await Token.deploy("HKD", "HKD", 18);
    factory = await (await ethers.getContractFactory("IRMarketVaultFactory")).deploy(oracle.target);
  });

  it("binds the consumed oracle immutably", async function () {
    expect(await factory.oracle()).to.equal(oracle.target);
  });

  it("lets ANYONE create a vault for a pair", async function () {
    const rx = await factory.connect(other).createVault(hkd.target, usd.target, 100n);
    await expect(rx).to.emit(factory, "VaultCreated");

    const vaultAddr = await factory.vaultFor(hkd.target, usd.target);
    expect(vaultAddr).to.not.equal(ethers.ZeroAddress);
    expect(await factory.isVault(vaultAddr)).to.equal(true);
    expect(await factory.vaultCount()).to.equal(1n);
    expect(await factory.vaults(0)).to.equal(vaultAddr);

    const vault = await ethers.getContractAt("IRMarketVault", vaultAddr);
    expect(await vault.oracle()).to.equal(oracle.target);
    expect(await vault.priceBase()).to.equal(hkd.target);
    expect(await vault.settlementToken()).to.equal(usd.target);
    expect(await vault.feeBps()).to.equal(100n);
  });

  it("keeps ONE vault per (base, quote) — the LP-D12 dedup point", async function () {
    await factory.createVault(hkd.target, usd.target, 100n);
    const existing = await factory.vaultFor(hkd.target, usd.target);
    await expect(factory.connect(other).createVault(hkd.target, usd.target, 50n))
      .to.be.revertedWithCustomError(factory, "VaultExists")
      .withArgs(existing);
  });

  it("treats (base, USD) and (base, HKD) as different pairs", async function () {
    // a USD-quoted market and an HKD-quoted market are different products, so
    // they get different vaults even when the base token is the same
    await factory.createVault(usd.target, usd.target === hkd.target ? usd.target : hkd.target, 100n);
    await factory.createVault(hkd.target, usd.target, 100n);
    expect(await factory.vaultCount()).to.equal(2n);
  });

  it("caps the fee at 10%", async function () {
    await expect(factory.createVault(hkd.target, usd.target, 1_000n))
      .to.be.revertedWithCustomError(factory, "InvalidConfig");
    await factory.createVault(hkd.target, usd.target, 999n); // just inside
  });

  it("rejects zero / identical tokens and a zero oracle", async function () {
    await expect(factory.createVault(ethers.ZeroAddress, usd.target, 100n))
      .to.be.revertedWithCustomError(factory, "InvalidConfig");
    await expect(factory.createVault(hkd.target, ethers.ZeroAddress, 100n))
      .to.be.revertedWithCustomError(factory, "InvalidConfig");
    await expect(factory.createVault(hkd.target, hkd.target, 100n))
      .to.be.revertedWithCustomError(factory, "InvalidConfig");
    const F = await ethers.getContractFactory("IRMarketVaultFactory");
    await expect(F.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "InvalidConfig");
  });

  it("returns 0 from vaultFor for a pair without a vault", async function () {
    expect(await factory.vaultFor(usd.target, hkd.target)).to.equal(ethers.ZeroAddress);
  });

  it("a factory-created vault accepts deposits from anyone", async function () {
    await factory.createVault(hkd.target, usd.target, 100n);
    const vault = await ethers.getContractAt(
      "IRMarketVault",
      await factory.vaultFor(hkd.target, usd.target)
    );

    await usd.mint(lp.address, 10_000n * E18);
    await usd.connect(lp).approve(vault.target, ethers.MaxUint256);
    await vault.connect(lp).deposit(5_000n * E18);

    expect(await vault.balance()).to.equal(5_000n * E18);
    expect(await vault.totalShares()).to.equal(5_000n * E18);
    expect(await vault.shares(lp.address)).to.equal(5_000n * E18);

    // …and a second LP can join at the same price
    await usd.mint(other.address, 1_000n * E18);
    await usd.connect(other).approve(vault.target, ethers.MaxUint256);
    await vault.connect(other).deposit(1_000n * E18);
    expect(await vault.totalShares()).to.equal(6_000n * E18);
    expect(await vault.shares(other.address)).to.equal(1_000n * E18);
  });
});
