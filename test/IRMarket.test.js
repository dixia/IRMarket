/**
 * IRMarket — Hardhat test suite scaffold.
 * Filled in together with the product requirement analysis / tech spec.
 */
import { expect } from "chai";
import hre from "hardhat";

const { ethers } = await hre.network.create();

describe("IRMarket — scaffold", function () {
  it("deploys and reports version", async function () {
    const IRMarket = await ethers.getContractFactory("IRMarket");
    const market = await IRMarket.deploy();
    expect(await market.version()).to.equal("0.1.0-scaffold");
  });
});