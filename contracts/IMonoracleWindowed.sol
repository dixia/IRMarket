// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IMonoracleWindowed
/// @notice Minimal interface for the IRMarket fork of the Monoracle veto-arbitrage
///         oracle (contracts/MonoracleWindowed.sol). Exposes only what IRMarket touches.
interface IMonoracleWindowed {
    enum QuoteStatus {
        ACTIVE,              // Submitted, vetoable until expiryBlock
        VETOED_UNDERPRICED,  // Base asset quoted too low (verifier took base)
        VETOED_OVERPRICED,   // Base asset quoted too high (verifier took quote)
        SETTLED_VALID,       // Survived verification, canonical price
        SETTLED_WITHDRAWN    // Provider has withdrawn funds (terminal)
    }

    struct Quote {
        address provider;       // msg.sender at submission
        address baseToken;      // Base asset ERC20
        address quoteToken;     // Quote asset ERC20
        uint256 baseAmount;     // Collateral units of base token
        uint256 quoteAmount;    // Collateral units of quote token
        uint256 price;          // Exchange rate, 1e18 fixed-point
        uint32 startSlot;       // block.number at submission
        uint32 settledSlot;     // block.number when settled (0 if not)
        uint256 expiryBlock;    // vetoable until this block (inclusive)
        QuoteStatus status;     // Current state
    }

    /// @notice Public getter for the quote ledger (audit + window checks).
    function quotes(uint256 quoteId) external view returns (Quote memory q);

    /// @notice The LONG trade: verifier pays the quote leg, receives the base leg.
    function vetoUnderpriced(uint256 quoteId) external;

    /// @notice The SHORT trade: verifier pays the base leg, receives the quote leg.
    function vetoOverpriced(uint256 quoteId) external;

    /// @notice Canonical price read (quote per base, 1e18 fixed-point).
    function getLatestPrice(address baseToken, address quoteToken)
        external
        view
        returns (uint256 price, uint32 settledSlot, bool exists);

    // ============================================================
    // Events (trading ledger, Monad Streaming RPC compatible)
    // ============================================================

    event QuoteSubmitted(
        uint256 indexed quoteId,
        address indexed provider,
        address indexed baseToken,
        address quoteToken,
        uint256 baseAmount,
        uint256 quoteAmount,
        uint256 price,
        uint32 startSlot,
        uint256 expiryBlock
    );

    event QuoteVetoedUnderpriced(uint256 indexed quoteId, address indexed verifier);

    event QuoteVetoedOverpriced(uint256 indexed quoteId, address indexed verifier);

    event QuoteSettledValid(uint256 indexed quoteId, uint256 price);

    event FundsWithdrawn(
        uint256 indexed quoteId,
        address indexed provider,
        uint256 baseAmount,
        uint256 quoteAmount
    );
}