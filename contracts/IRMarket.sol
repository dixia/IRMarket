// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title IRMarket — Exotic Option Market on Monad
/// @dev Placeholder scaffold. Product requirement analysis pending.
///      Will build an exotic option market on any priced asset (e.g. A-share stocks,
///      Labubu), with settlement enforced by the Monoracle veto-arbitrage primitive
///      (bilateral collateral + permissionless on-chain arbitrage — no off-chain feeds).
contract IRMarket is ReentrancyGuard {
    // TODO: option market design once product requirement analysis lands.
    // - option types / payoff shapes (binary, exotic)
    // - writers, takers, bilateral / asymmetric collateral
    // - settlement price via Monoracle primitive (any priced asset)
    // - veto-arbitrage enforcement window
    // - payout & withdrawal paths
    function version() external pure returns (string memory) {
        return "0.1.0-scaffold";
    }
}