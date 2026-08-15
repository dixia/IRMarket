// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IMonoracleWindowed} from "./IMonoracleWindowed.sol";

/**
 * @title IRMarket
 * @notice Thin market factory + fee wrapper over MonoracleWindowed (Veto-Market, PRD V0.8,
 *         tech-spec V0.9).
 * @dev    IRMarket does NOT price, match, settle or hold pools. Trading IS the Monoracle
 *         veto: 看涨 = vetoUnderpriced (pay quote HKD, receive base LLM), 看跌 =
 *         vetoOverpriced (pay base LLM, receive quote HKD). This contract only
 *         (a) registers markets (pair + tenor + fee config) and
 *         (b) wraps veto entries with an explicit 1% fee in the quote token (D-11/D-16).
 *
 *         Fee accounting (fee is ALWAYS in the quote token / HKD):
 *           LONG : fee = quote.quoteAmount * feeBps / 10000 ; user pays quoteAmount + fee
 *           SHORT: fee = quote.quoteAmount * feeBps / 10000 ; user pays baseAmount, receives
 *                  quoteAmount - fee
 *         The fee is forwarded to `market.marketMaker` in the same transaction.
 */
contract IRMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============================================================
    // Enums & Structs
    // ============================================================

    enum Side {
        LONG,               // vetoUnderpriced  (pay quote, get base)
        SHORT               // vetoOverpriced  (pay base, get quote)
    }

    struct Market {
        address baseToken;      // e.g. LLM
        address quoteToken;     // e.g. HKD
        address marketMaker;    // fee recipient (bot)
        uint256 feeBps;         // 1% = 100
        uint256 expiryBlock;    // advisory; bot sets quote.expiryBlock = this value (D-13)
        uint256 createdAtBlock;
    }

    // ============================================================
    // Constants
    // ============================================================

    uint256 public constant MAX_FEE_BPS = 10000;

    // ============================================================
    // State Variables
    // ============================================================

    /// @dev The trading venue. Ownerless/adminless (no kill switch).
    IMonoracleWindowed public immutable oracle;

    /// @dev Auto-incrementing market ID. Starts at 1 so that markets[0] is the empty
    ///      struct (mirrors Monoracle's nextQuoteId). No pair dedup (D-14): the same
    ///      underlying may list several markets with different expiries/fees; each round
    ///      = a new marketId.
    uint256 public nextMarketId = 1;

    /// @dev marketId => Market
    mapping(uint256 => Market) public markets;

    // ============================================================
    // Custom Errors
    // ============================================================

    error MarketDoesNotExist();
    error InvalidToken();
    error IdenticalTokens();
    error FeeTooHigh();
    error ExpiryMustBeFuture();
    error QuotePairMismatch();
    error QuoteNotActive();
    error QuoteWindowExpired();

    // ============================================================
    // Events (Monad Streaming RPC compatible)
    // ============================================================

    event MarketCreated(
        uint256 indexed marketId,
        address indexed baseToken,
        address indexed quoteToken,
        address marketMaker,
        uint256 expiryBlock,
        uint256 feeBps
    );

    event VetoWrapped(
        uint256 indexed quoteId,
        uint256 indexed marketId,
        address indexed trader,
        Side side,
        uint256 swapIn,     // what the trader paid (quote leg for LONG, base leg for SHORT)
        uint256 swapOut,    // what the trader received (base for LONG, quote-fee for SHORT)
        uint256 fee         // fee in quote token (HKD)
    );

    // ============================================================
    // Constructor
    // ============================================================

    constructor(address oracle_) {
        if (oracle_ == address(0)) revert InvalidToken();
        oracle = IMonoracleWindowed(oracle_);
    }

    // ============================================================
    // Market Factory (D-07/D-14)
    // ============================================================

    /**
     * @notice Register a market = an option round over a (base, quote) pair.
     * @dev    Opens to anyone. Grants the oracle max allowance for both tokens so the
     *         wrapper can veto on the caller's behalf. No tokens move here.
     * @param  baseToken    Base asset ERC20 (e.g. LLM)
     * @param  quoteToken   Quote asset ERC20 (e.g. HKD)
     * @param  marketMaker  Recipient of the wrapper fee (typically the bot)
     * @param  expiryBlock  Round expiry; bot sets quote.expiryBlock to this (advisory here)
     * @param  feeBps       Fee in basis points, applied on quote.quoteAmount, < 10000
     * @return marketId     Unique market id
     */
    function createMarket(
        address baseToken,
        address quoteToken,
        address marketMaker,
        uint256 expiryBlock,
        uint256 feeBps
    ) external returns (uint256 marketId) {
        if (baseToken == address(0) || quoteToken == address(0)) revert InvalidToken();
        if (baseToken == quoteToken) revert IdenticalTokens();
        if (feeBps >= MAX_FEE_BPS) revert FeeTooHigh();
        if (expiryBlock <= block.number) revert ExpiryMustBeFuture();

        marketId = nextMarketId++;
        markets[marketId] = Market({
            baseToken: baseToken,
            quoteToken: quoteToken,
            marketMaker: marketMaker,
            feeBps: feeBps,
            expiryBlock: expiryBlock,
            createdAtBlock: block.number
        });

        // grant the oracle allowance so the wrapper can veto with this pair's tokens
        IERC20(baseToken).forceApprove(address(oracle), type(uint256).max);
        IERC20(quoteToken).forceApprove(address(oracle), type(uint256).max);

        emit MarketCreated(marketId, baseToken, quoteToken, marketMaker, expiryBlock, feeBps);
    }

    // ============================================================
    // Fee Wrapper — Trade Entries (D-11/D-16)
    // ============================================================

    /**
     * @notice 看涨 / LONG — vetoUnderpriced wrapped with an explicit HKD fee.
     *         User pays `quoteAmount + fee` HKD, receives `baseAmount` LLM.
     * @param  marketId Market whose MM receives the fee
     * @param  quoteId  ACTIVE quote to veto (any provider, D-15)
     */
    function openLong(uint256 marketId, uint256 quoteId) external nonReentrant {
        Market storage m = markets[marketId];
        if (m.baseToken == address(0)) revert MarketDoesNotExist();

        IMonoracleWindowed.Quote memory q = _checkTradeable(m, quoteId);

        uint256 fee = (q.quoteAmount * m.feeBps) / MAX_FEE_BPS;

        // pull gross pin-in (quoteAmount + fee) in HKD
        IERC20(m.quoteToken).safeTransferFrom(msg.sender, address(this), q.quoteAmount + fee);

        // fee -> MM, before the veto
        if (fee > 0) {
            IERC20(m.quoteToken).safeTransfer(m.marketMaker, fee);
        }

        // veto: oracle pulls quoteAmount HKD from this wrapper, sends baseAmount LLM to it
        oracle.vetoUnderpriced(quoteId);

        // base LLM -> trader
        IERC20(m.baseToken).safeTransfer(msg.sender, q.baseAmount);

        emit VetoWrapped(quoteId, marketId, msg.sender, Side.LONG, q.quoteAmount, q.baseAmount, fee);
    }

    /**
     * @notice 看跌 / SHORT — vetoOverpriced wrapped with an explicit HKD fee.
     *         User pays `baseAmount` LLM, receives `quoteAmount - fee` HKD.
     * @param  marketId Market whose MM receives the fee
     * @param  quoteId  ACTIVE quote to veto (any provider, D-15)
     */
    function openShort(uint256 marketId, uint256 quoteId) external nonReentrant {
        Market storage m = markets[marketId];
        if (m.baseToken == address(0)) revert MarketDoesNotExist();

        IMonoracleWindowed.Quote memory q = _checkTradeable(m, quoteId);

        uint256 fee = (q.quoteAmount * m.feeBps) / MAX_FEE_BPS;

        // pull base leg LLM from trader
        IERC20(m.baseToken).safeTransferFrom(msg.sender, address(this), q.baseAmount);

        // veto: oracle pulls baseAmount LLM from this wrapper, sends quoteAmount HKD to it
        oracle.vetoOverpriced(quoteId);

        // forward HKD: fee -> MM, remainder -> trader
        if (fee > 0) {
            IERC20(m.quoteToken).safeTransfer(m.marketMaker, fee);
        }
        IERC20(m.quoteToken).safeTransfer(msg.sender, q.quoteAmount - fee);

        emit VetoWrapped(quoteId, marketId, msg.sender, Side.SHORT, q.baseAmount, q.quoteAmount - fee, fee);
    }

    // ============================================================
    // Reads
    // ============================================================

    function version() external pure returns (string memory) {
        return "0.9.0-vetomarket";
    }

    // ============================================================
    // Internal Helpers
    // ============================================================

    /// @dev Validates a quote is tradeable against this market and returns it.
    ///      Oracle's own modifiers are the backstop; these pre-checks give friendlier errors.
    function _checkTradeable(Market storage m, uint256 quoteId)
        internal
        view
        returns (IMonoracleWindowed.Quote memory q)
    {
        q = oracle.quotes(quoteId);
        if (q.baseToken != m.baseToken || q.quoteToken != m.quoteToken) revert QuotePairMismatch();
        if (q.status != IMonoracleWindowed.QuoteStatus.ACTIVE) revert QuoteNotActive();
        if (block.number > q.expiryBlock) revert QuoteWindowExpired();
    }
}