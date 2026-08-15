// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Monoracle
 * @notice Fully decentralized on-chain price oracle for Monad
 * @dev    Price integrity enforced by bilateral collateral + permissionless veto arbitrage.
 *         Verification window: 2 Monad slots (~600ms at 300ms block time).
 */
contract Monoracle is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============================================================
    // Enums & Structs
    // ============================================================

    enum QuoteStatus {
        ACTIVE,              // Submitted, in verification window
        VETOED_UNDERPRICED,  // Base asset quoted too low
        VETOED_OVERPRICED,   // Base asset quoted too high
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
        QuoteStatus status;     // Current state
    }

    // ============================================================
    // Constants
    // ============================================================

    /// @dev Fixed verification window: 2 Monad slots (~600ms at 300ms block time)
    uint32 public constant VERIFICATION_SLOTS = 2;

    // ============================================================
    // State Variables
    // ============================================================

    /// @dev Auto-incrementing quote ID counter. Starts at 1 so that
    ///      latestValidQuoteId[pair] == 0 means "no settled quote" (see getLatestPrice).
    uint256 public nextQuoteId = 1;

    /// @dev quoteId => Quote struct
    mapping(uint256 => Quote) public quotes;

    /// @dev Asset pair key => latest settled valid quote ID
    ///      key = keccak256(abi.encodePacked(baseToken, quoteToken))
    mapping(bytes32 => uint256) public latestValidQuoteId;

    // ============================================================
    // Custom Errors (gas-efficient on Monad)
    // ============================================================

    error ZeroBaseAmount();
    error InvalidToken();
    error IdenticalTokens();
    error QuoteAmountTooSmall();
    error QuoteDoesNotExist();
    error VerificationWindowExpired();
    error VerificationWindowActive();
    error QuoteNotActive();
    error NotQuoteProvider();
    error NotWithdrawable();

    // ============================================================
    // Events (Monad Streaming RPC compatible)
    // ============================================================

    event QuoteSubmitted(
        uint256 indexed quoteId,
        address indexed provider,
        address indexed baseToken,
        address quoteToken,
        uint256 baseAmount,
        uint256 quoteAmount,
        uint256 price,
        uint32 startSlot
    );

    event QuoteVetoedUnderpriced(
        uint256 indexed quoteId,
        address indexed verifier
    );

    event QuoteVetoedOverpriced(
        uint256 indexed quoteId,
        address indexed verifier
    );

    event QuoteSettledValid(
        uint256 indexed quoteId,
        uint256 price
    );

    event FundsWithdrawn(
        uint256 indexed quoteId,
        address indexed provider,
        uint256 baseAmount,
        uint256 quoteAmount
    );

    // ============================================================
    // Modifiers
    // ============================================================

    modifier quoteExists(uint256 quoteId) {
        if (quotes[quoteId].provider == address(0)) {
            revert QuoteDoesNotExist();
        }
        _;
    }

    modifier inVerificationWindow(uint256 quoteId) {
        Quote storage q = quotes[quoteId];
        if (block.number > uint256(q.startSlot) + VERIFICATION_SLOTS) {
            revert VerificationWindowExpired();
        }
        _;
    }

    modifier afterVerificationWindow(uint256 quoteId) {
        Quote storage q = quotes[quoteId];
        if (block.number <= uint256(q.startSlot) + VERIFICATION_SLOTS) {
            revert VerificationWindowActive();
        }
        _;
    }

    // ============================================================
    // Core Functions
    // ============================================================

    /**
     * @notice Submit a new price quotation with bilateral collateral.
     * @param  baseToken    Address of base asset ERC20 (e.g. SOL)
     * @param  quoteToken   Address of quote asset ERC20 (e.g. DAI)
     * @param  baseAmount   Amount of base token to deposit as collateral
     * @param  quoteAmount  Amount of quote token to deposit as collateral
     * @return quoteId      Unique ID of the created quote. Price is derived as
     *                      (quoteAmount * 1e18) / baseAmount internally.
     */
    function submitQuote(
        address baseToken,
        address quoteToken,
        uint256 baseAmount,
        uint256 quoteAmount
    ) external nonReentrant returns (uint256 quoteId) {
        if (baseAmount == 0) revert ZeroBaseAmount();
        if (quoteAmount == 0) revert QuoteAmountTooSmall();
        if (baseToken == address(0) || quoteToken == address(0)) revert InvalidToken();
        if (baseToken == quoteToken) revert IdenticalTokens();

        uint256 price = (quoteAmount * 1e18) / baseAmount;

        IERC20(baseToken).safeTransferFrom(msg.sender, address(this), baseAmount);
        IERC20(quoteToken).safeTransferFrom(msg.sender, address(this), quoteAmount);

        quoteId = nextQuoteId++;
        quotes[quoteId] = Quote({
            provider: msg.sender,
            baseToken: baseToken,
            quoteToken: quoteToken,
            baseAmount: baseAmount,
            quoteAmount: quoteAmount,
            price: price,
            startSlot: uint32(block.number),
            settledSlot: 0,
            status: QuoteStatus.ACTIVE
        });

        emit QuoteSubmitted(quoteId, msg.sender, baseToken, quoteToken, baseAmount, quoteAmount, price, uint32(block.number));
    }

    /**
     * @notice Veto an underpriced quote (base asset quoted below market).
     *         Verifier pays quoteAmount into contract, receives baseAmount.
     *         Provider forfeits base collateral, keeps doubled quote collateral.
     * @param  quoteId ID of the active quote
     */
    function vetoUnderpriced(uint256 quoteId)
        external
        nonReentrant
        quoteExists(quoteId)
        inVerificationWindow(quoteId)
    {
        Quote storage q = quotes[quoteId];
        if (q.status != QuoteStatus.ACTIVE) revert QuoteNotActive();

        IERC20(q.quoteToken).safeTransferFrom(msg.sender, address(this), q.quoteAmount);
        IERC20(q.baseToken).safeTransfer(msg.sender, q.baseAmount);

        q.status = QuoteStatus.VETOED_UNDERPRICED;

        emit QuoteVetoedUnderpriced(quoteId, msg.sender);
    }

    /**
     * @notice Veto an overpriced quote (base asset quoted above market).
     *         Verifier pays baseAmount into contract, receives quoteAmount.
     *         Provider forfeits quote collateral, keeps doubled base collateral.
     * @param  quoteId ID of the active quote
     */
    function vetoOverpriced(uint256 quoteId)
        external
        nonReentrant
        quoteExists(quoteId)
        inVerificationWindow(quoteId)
    {
        Quote storage q = quotes[quoteId];
        if (q.status != QuoteStatus.ACTIVE) revert QuoteNotActive();

        IERC20(q.baseToken).safeTransferFrom(msg.sender, address(this), q.baseAmount);
        IERC20(q.quoteToken).safeTransfer(msg.sender, q.quoteAmount);

        q.status = QuoteStatus.VETOED_OVERPRICED;

        emit QuoteVetoedOverpriced(quoteId, msg.sender);
    }

    /**
     * @notice Settle a quote that survived the full verification window.
     *         Updates the canonical price feed for the asset pair.
     * @param  quoteId ID of the active quote
     */
    function settleValidQuote(uint256 quoteId)
        external
        quoteExists(quoteId)
        afterVerificationWindow(quoteId)
    {
        Quote storage q = quotes[quoteId];
        if (q.status != QuoteStatus.ACTIVE) revert QuoteNotActive();

        q.status = QuoteStatus.SETTLED_VALID;
        q.settledSlot = uint32(block.number);

        bytes32 pairKey = _getPairKey(q.baseToken, q.quoteToken);
        latestValidQuoteId[pairKey] = quoteId;

        emit QuoteSettledValid(quoteId, q.price);
    }

    /**
     * @notice Provider withdraws funds after settlement or veto.
     *         - Valid quote:   withdraws original baseAmount + quoteAmount
     *         - Underpriced veto: withdraws 2x quoteAmount, 0 baseAmount
     *         - Overpriced veto:  withdraws 2x baseAmount, 0 quoteAmount
     * @param  quoteId ID of the quote
     */
    function withdrawProviderFunds(uint256 quoteId)
        external
        nonReentrant
        quoteExists(quoteId)
    {
        Quote storage q = quotes[quoteId];
        if (msg.sender != q.provider) revert NotQuoteProvider();

        uint256 withdrawBase;
        uint256 withdrawQuote;

        QuoteStatus currentStatus = q.status;

        if (currentStatus == QuoteStatus.SETTLED_VALID) {
            withdrawBase = q.baseAmount;
            withdrawQuote = q.quoteAmount;
        } else if (currentStatus == QuoteStatus.VETOED_UNDERPRICED) {
            withdrawBase = 0;
            withdrawQuote = q.quoteAmount * 2;
        } else if (currentStatus == QuoteStatus.VETOED_OVERPRICED) {
            withdrawBase = q.baseAmount * 2;
            withdrawQuote = 0;
        } else {
            revert NotWithdrawable();
        }

        q.status = QuoteStatus.SETTLED_WITHDRAWN;

        if (withdrawBase > 0) {
            IERC20(q.baseToken).safeTransfer(q.provider, withdrawBase);
        }
        if (withdrawQuote > 0) {
            IERC20(q.quoteToken).safeTransfer(q.provider, withdrawQuote);
        }

        emit FundsWithdrawn(quoteId, q.provider, withdrawBase, withdrawQuote);
    }

    // ============================================================
    // Read Interface (Price Consumers)
    // ============================================================

    /**
     * @notice Get the latest settled valid price for an asset pair.
     * @param  baseToken    Base asset address
     * @param  quoteToken   Quote asset address
     * @return price        Canonical price (quote per base, 1e18 fixed-point)
     * @return settledSlot  Block number when the price was settled
     * @return exists       True if a valid price exists for this pair
     */
    function getLatestPrice(address baseToken, address quoteToken)
        external
        view
        returns (uint256 price, uint32 settledSlot, bool exists)
    {
        bytes32 pairKey = _getPairKey(baseToken, quoteToken);
        uint256 quoteId = latestValidQuoteId[pairKey];
        if (quoteId == 0) return (0, 0, false);

        Quote storage q = quotes[quoteId];
        return (q.price, q.settledSlot, true);
    }

    // ============================================================
    // Internal Helpers
    // ============================================================

    function _getPairKey(address baseToken, address quoteToken)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(baseToken, quoteToken));
    }
}
