import { defineConfig } from "hardhat/config";

import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatMocha from "@nomicfoundation/hardhat-mocha";
import hardhatEthersChaiMatchers from "@nomicfoundation/hardhat-ethers-chai-matchers";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";

export default defineConfig({
  plugins: [
    hardhatEthers,
    hardhatMocha,
    hardhatEthersChaiMatchers,
    hardhatNetworkHelpers,
  ],
  solidity: "0.8.20",
  test: {
    mocha: {
      timeout: 120_000,
    },
  },
});