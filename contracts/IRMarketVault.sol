// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IMonoracle} from "./IMonoracle.sol";

/**
 * @title IRMarketVault (MVP)
 * @notice Minimal LP pool over Monoracle. LPs deposit the quote token for pro-rata
 *         shares; traders pay a premium to open a capped-linear LONG/SHORT; positions
 *         settle against Monoracle's canonical price (`getLatestPrice`).
 * @dev    Simplified cut of `docs/design/lp-pool-tech-spec.md`: no adapter, no factory,
 *         no admission caps, no circuit breaker, no withdrawal queue. Equity is
 *         conservative (`balance - pendingPayout`) and every open enforces
 *         `pendingPayout <= balance`, so the pool can never be involuntarily insolvent.
 *         Price manipulation defence is out of scope here (see spec §8) — this is a
 *         demo of the payoff/settlement accounting only.
 *
 *         Accepted MVP limitations (impl-plan §6): settlement marks at call-time price
 *         (American option), a pathological overflow strands a position, and quote tokens
 *         sent directly to the vault are not counted and cannot be swept.
 */
contract IRMarketVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Side {
        LONG,
        SHORT
    }

    enum Status {
        OPEN,
        SETTLED
    }

    struct Position {
        address owner;
        Side side;
        uint256 deposit;      // gross premium paid, quote-native
        uint256 fee;          // deposit - notional
        uint256 notional;     // at-risk capital
        uint256 entryPrice;   // WAD 1e18
        uint256 maxPayout;    // <= 2 * notional
        uint64 expiryBlock;
        Status status;
    }

    uint256 public constant MAX_FEE_BPS = 10_000;
    uint256 public constant MAX_PROFIT_BPS = 10_000; // payout in [0, 2N]

    IMonoracle public immutable oracle;
    address public immutable baseToken;
    address public immutable quoteToken;
    uint256 public immutable feeBps;

    uint256 public balance;        // cached quote balance; direct token donations are NOT
                                   // counted and cannot be swept (see header @dev)
    uint256 public pendingPayout;  // worst-case obligation over OPEN positions
    uint256 public totalShares;    // LP shares outstanding

    mapping(address => uint256) public shares;
    Position[] private _positions;

    error InvalidConfig();
    error ZeroAmount();
    error ZeroTenor();
    error PriceUnavailable();
    error Insolvent();
    error DepositAtZeroEquity();
    error InsufficientShares();
    error NotOpen();
    error NotExpired();

    event Deposited(address indexed lp, uint256 amount, uint256 shares);
    event Withdrawn(address indexed lp, uint256 shares, uint256 amount);
    event PositionOpened(
        uint256 indexed positionId,
        address indexed trader,
        Side side,
        uint256 deposit,
        uint256 notional,
        uint256 entryPrice,
        uint64 expiryBlock
    );
    event PositionSettled(uint256 indexed positionId, uint256 settlePrice, uint256 payout);

    constructor(address oracle_, address baseToken_, address quoteToken_, uint256 feeBps_) {
        if (oracle_ == address(0) || baseToken_ == address(0) || quoteToken_ == address(0)) {
            revert InvalidConfig();
        }
        if (feeBps_ >= MAX_FEE_BPS) revert InvalidConfig();
        oracle = IMonoracle(oracle_);
        baseToken = baseToken_;
        quoteToken = quoteToken_;
        feeBps = feeBps_;
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function equity() public view returns (uint256) {
        return balance - pendingPayout;
    }

    function positionCount() external view returns (uint256) {
        return _positions.length;
    }

    function positions(uint256 positionId) external view returns (Position memory) {
        return _positions[positionId];
    }

    // ------------------------------------------------------------------
    // LP side
    // ------------------------------------------------------------------

    function deposit(uint256 amount) external nonReentrant returns (uint256 sharesMinted) {
        if (amount == 0) revert ZeroAmount();
        uint256 eq = equity();
        uint256 supply = totalShares;
        // With existing shares but zero equity (fully reserved or fully lost), a 1:1 mint
        // would silently donate most of `amount` to incumbent LPs — refuse instead.
        if (supply > 0 && eq == 0) revert DepositAtZeroEquity();
        sharesMinted = supply == 0 ? amount : (amount * supply) / eq;

        IERC20(quoteToken).safeTransferFrom(msg.sender, address(this), amount);
        balance += amount;
        totalShares = supply + sharesMinted;
        shares[msg.sender] += sharesMinted;

        emit Deposited(msg.sender, amount, sharesMinted);
    }

    function withdraw(uint256 shareAmount) external nonReentrant returns (uint256 amount) {
        if (shareAmount == 0) revert ZeroAmount();
        uint256 supply = totalShares;
        if (shareAmount > shares[msg.sender]) revert InsufficientShares();

        amount = (shareAmount * equity()) / supply;
        shares[msg.sender] -= shareAmount;
        totalShares = supply - shareAmount;
        balance -= amount;

        IERC20(quoteToken).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, shareAmount, amount);
    }

    // ------------------------------------------------------------------
    // Trader side
    // ------------------------------------------------------------------

    function openPosition(Side side, uint256 depositAmount, uint64 tenorBlocks)
        external
        nonReentrant
        returns (uint256 positionId)
    {
        if (depositAmount == 0) revert ZeroAmount();
        if (tenorBlocks == 0) revert ZeroTenor();

        (uint256 entryPrice, , bool exists) = oracle.getLatestPrice(baseToken, quoteToken);
        if (!exists || entryPrice == 0) revert PriceUnavailable();

        uint256 fee = (depositAmount * feeBps) / MAX_FEE_BPS;
        uint256 notional = depositAmount - fee;
        uint256 maxPayout = (notional * (MAX_FEE_BPS + MAX_PROFIT_BPS)) / MAX_FEE_BPS;

        IERC20(quoteToken).safeTransferFrom(msg.sender, address(this), depositAmount);
        balance += depositAmount;

        uint256 newPending = pendingPayout + maxPayout;
        if (newPending > balance) revert Insolvent();
        pendingPayout = newPending;

        positionId = _positions.length;
        _positions.push(
            Position({
                owner: msg.sender,
                side: side,
                deposit: depositAmount,
                fee: fee,
                notional: notional,
                entryPrice: entryPrice,
                maxPayout: maxPayout,
                expiryBlock: uint64(block.number) + tenorBlocks,
                status: Status.OPEN
            })
        );

        emit PositionOpened(
            positionId, msg.sender, side, depositAmount, notional, entryPrice, uint64(block.number) + tenorBlocks
        );
    }

    /// @dev Permissionless. Marks at the canonical price at *call* time, not at expiry, so a
    ///      position is effectively American — the holder may settle late when the price is
    ///      favourable. Accepted MVP risk (impl-plan §6); V1 pins settlement to the expiry
    ///      window (spec §9.3).
    function settlePosition(uint256 positionId) external nonReentrant returns (uint256 payout) {
        Position storage p = _positions[positionId];
        if (p.status != Status.OPEN) revert NotOpen();
        if (block.number < p.expiryBlock) revert NotExpired();

        (uint256 settlePrice, , bool exists) = oracle.getLatestPrice(baseToken, quoteToken);
        if (!exists || settlePrice == 0) revert PriceUnavailable();

        payout = _payout(p, settlePrice);

        p.status = Status.SETTLED;
        pendingPayout -= p.maxPayout;
        balance -= payout;

        IERC20(quoteToken).safeTransfer(p.owner, payout);
        emit PositionSettled(positionId, settlePrice, payout);
    }

    // ------------------------------------------------------------------
    // Payoff (spec §4.2): pnl = N * (S - S0)/S0 for LONG, capped to [-N, +N]
    // ------------------------------------------------------------------

    function _payout(Position storage p, uint256 settlePrice) internal view returns (uint256) {
        uint256 notional = p.notional;
        int256 pnl;

        if (settlePrice >= p.entryPrice) {
            uint256 up = ((settlePrice - p.entryPrice) * notional) / p.entryPrice;
            pnl = p.side == Side.LONG ? int256(up) : -int256(up);
        } else {
            uint256 down = ((p.entryPrice - settlePrice) * notional) / p.entryPrice;
            pnl = p.side == Side.LONG ? -int256(down) : int256(down);
        }

        int256 cap = int256((notional * MAX_PROFIT_BPS) / MAX_FEE_BPS);
        if (pnl > cap) pnl = cap;
        if (pnl < -int256(notional)) pnl = -int256(notional);

        return uint256(int256(notional) + pnl);
    }
}
