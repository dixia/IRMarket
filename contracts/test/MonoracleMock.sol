// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IMonoracle} from "../IMonoracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MonoracleMock is IMonoracle {
    using SafeERC20 for IERC20;

    uint256 public nextQuoteId_ = 1;

    struct QuoteData {
        address provider;
        address baseToken;
        address quoteToken;
        uint256 baseAmount;
        uint256 quoteAmount;
        uint256 price;
        uint32 startSlot;
        uint32 expiryBlock;
        uint32 settledSlot;
        QuoteStatus status;
    }

    mapping(uint256 => QuoteData) public quotes_;

    /// @dev pairKey => latest settled valid quote ID. Written only by settleValidQuote,
    ///      as the getLatestPrice fallback floor once MAX_PRICE_WALK is exhausted.
    mapping(bytes32 => uint256) public latestValidQuoteId_;

    /// @dev pairKey => newest quote id ever submitted for the pair (walk head).
    mapping(bytes32 => uint256) public latestQuoteId_;

    /// @dev quoteId => previous quote id in the pair's list (0 = list start).
    mapping(uint256 => uint256) public prevQuoteId_;

    // Reentrancy test hook: optional callback during veto
    address public callbackTarget;
    uint256 public callbackQuoteId;

    function setCallback(address target, uint256 quoteId) external {
        callbackTarget = target;
        callbackQuoteId = quoteId;
    }

    function _maybeCallback(uint256 quoteId) internal {
        if (callbackTarget != address(0) && callbackQuoteId == quoteId) {
            (bool ok, bytes memory data) = callbackTarget.call(abi.encodeWithSignature("onVeto()"));
            if (!ok) {
                if (data.length == 0) {
                    revert("callback failed");
                }
                assembly {
                    revert(add(data, 32), mload(data))
                }
            }
        }
    }

    /// @dev Upstream-consistent window constants (mirror ../monoracle Monoracle.sol).
    uint32 public constant VERIFICATION_SLOTS = 2;
    uint32 public constant MAX_VERIFICATION_SLOTS = 12000;

    /// @dev Max backward steps in getLatestPrice — bounds read gas under hostile
    ///      shapes (mirror upstream MAX_PRICE_WALK).
    uint256 public constant MAX_PRICE_WALK = 8;

    error ExpiryMustBeFuture();
    error ExpiryTooFar();
    error QuoteDoesNotExist();
    error QuoteNotActive();
    error VerificationWindowExpired();
    error VerificationWindowActive();
    error NotQuoteProvider();
    error NotWithdrawable();

    function submitQuote(
        address baseToken_,
        address quoteToken_,
        uint256 baseAmount_,
        uint256 quoteAmount_,
        uint32 expiryBlock_
    ) external returns (uint256) {
        if (expiryBlock_ <= uint32(block.number)) revert ExpiryMustBeFuture();
        if (uint256(expiryBlock_) > block.number + MAX_VERIFICATION_SLOTS) revert ExpiryTooFar();
        uint256 id = nextQuoteId_++;
        quotes_[id] = QuoteData({
            provider: msg.sender,
            baseToken: baseToken_,
            quoteToken: quoteToken_,
            baseAmount: baseAmount_,
            quoteAmount: quoteAmount_,
            price: baseAmount_ > 0 ? (quoteAmount_ * 10**18) / baseAmount_ : 0,
            startSlot: uint32(block.number),
            expiryBlock: expiryBlock_,
            settledSlot: 0,
            status: QuoteStatus.ACTIVE
        });
        IERC20(baseToken_).safeTransferFrom(msg.sender, address(this), baseAmount_);
        IERC20(quoteToken_).safeTransferFrom(msg.sender, address(this), quoteAmount_);

        // Lazy settlement: link the quote into the pair's backward list. getLatestPrice
        // walks it from the head, so the newest submission is always seen first.
        bytes32 pairKey = _getPairKey(baseToken_, quoteToken_);
        prevQuoteId_[id] = latestQuoteId_[pairKey];
        latestQuoteId_[pairKey] = id;

        emit QuoteSubmitted(id, msg.sender, baseToken_, quoteToken_, baseAmount_, quoteAmount_, (quoteAmount_ * 10**18) / baseAmount_, uint32(block.number), expiryBlock_);
        return id;
    }

    function vetoUnderpriced(uint256 quoteId) external {
        QuoteData storage q = quotes_[quoteId];
        if (q.provider == address(0)) revert QuoteDoesNotExist();
        if (q.status != QuoteStatus.ACTIVE) revert QuoteNotActive();
        if (block.number > q.expiryBlock) revert VerificationWindowExpired();

        // Long trade: verifier pays quoteAmount into contract, receives baseAmount from contract
        IERC20(q.quoteToken).safeTransferFrom(msg.sender, address(this), q.quoteAmount);
        _maybeCallback(quoteId);
        IERC20(q.baseToken).safeTransfer(msg.sender, q.baseAmount);

        q.status = QuoteStatus.VETOED_UNDERPRICED;
        emit QuoteVetoedUnderpriced(quoteId, msg.sender);
    }

    function vetoOverpriced(uint256 quoteId) external {
        QuoteData storage q = quotes_[quoteId];
        if (q.provider == address(0)) revert QuoteDoesNotExist();
        if (q.status != QuoteStatus.ACTIVE) revert QuoteNotActive();
        if (block.number > q.expiryBlock) revert VerificationWindowExpired();

        // Short trade: verifier pays baseAmount into contract, receives quoteAmount from contract
        IERC20(q.baseToken).safeTransferFrom(msg.sender, address(this), q.baseAmount);
        _maybeCallback(quoteId);
        IERC20(q.quoteToken).safeTransfer(msg.sender, q.quoteAmount);

        q.status = QuoteStatus.VETOED_OVERPRICED;
        emit QuoteVetoedOverpriced(quoteId, msg.sender);
    }

    /**
     * @notice Optional permissionless checkpoint for a quote that survived the
     *         verification window. It no longer gates the canonical price:
     *         getLatestPrice derives the price at read time from the pair's quote
     *         list. Calling this emits QuoteSettledValid and writes
     *         latestValidQuoteId_, which serves as the walk's fallback floor once
     *         MAX_PRICE_WALK steps are exhausted.
     */
    function settleValidQuote(uint256 quoteId) external {
        QuoteData storage q = quotes_[quoteId];
        if (q.provider == address(0)) revert QuoteDoesNotExist();
        if (q.status != QuoteStatus.ACTIVE) revert QuoteNotActive();
        if (block.number <= q.expiryBlock) revert VerificationWindowActive();

        q.status = QuoteStatus.SETTLED_VALID;
        q.settledSlot = uint32(block.number);

        bytes32 pairKey = _getPairKey(q.baseToken, q.quoteToken);
        latestValidQuoteId_[pairKey] = quoteId;

        emit QuoteSettledValid(quoteId, q.price);
    }

    function withdrawProviderFunds(uint256 quoteId) external {
        QuoteData storage q = quotes_[quoteId];
        if (q.provider != msg.sender) revert NotQuoteProvider();
        if (q.status == QuoteStatus.ACTIVE && block.number <= q.expiryBlock) revert VerificationWindowActive();
        if (q.status == QuoteStatus.SETTLED_WITHDRAWN) revert NotWithdrawable();

        uint256 withdrawBase;
        uint256 withdrawQuote;

        if (q.status == QuoteStatus.VETOED_UNDERPRICED) {
            withdrawBase = 0;
            withdrawQuote = q.quoteAmount * 2;
        } else if (q.status == QuoteStatus.VETOED_OVERPRICED) {
            withdrawBase = q.baseAmount * 2;
            withdrawQuote = 0;
        } else if (q.status == QuoteStatus.SETTLED_VALID) {
            withdrawBase = q.baseAmount;
            withdrawQuote = q.quoteAmount;
        } else if (q.status == QuoteStatus.ACTIVE) {
            // Implicit settlement: the window passed with no checkpoint tx, so the
            // matured quote pays out like a settled valid one (upstream parity).
            withdrawBase = q.baseAmount;
            withdrawQuote = q.quoteAmount;
            if (q.settledSlot == 0) q.settledSlot = q.expiryBlock; // stable value, not the withdraw block
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

    /**
     * @notice Canonical price read — walks the pair's quote list backward from the
     *         newest submission, up to MAX_PRICE_WALK steps, and returns the first
     *         quote that counts as canonical (matured ACTIVE, SETTLED_VALID, or
     *         SETTLED_WITHDRAWN with settledSlot set). If the cap is exhausted,
     *         falls back to the settleValidQuote checkpoint pointer when that quote
     *         is itself canonical.
     * @dev    Mirrors upstream Monoracle.getLatestPrice (lazy/implicit settlement:
     *         a quote is canonical once block.number > expiryBlock, no settle tx).
     *         settledSlot is the checkpoint block for explicitly settled quotes,
     *         otherwise expiryBlock (the implicit settle point).
     */
    function getLatestPrice(address baseToken_, address quoteToken_)
        external
        view
        returns (uint256 price, uint32 settledSlot, bool exists)
    {
        bytes32 pairKey = _getPairKey(baseToken_, quoteToken_);
        uint256 quoteId = latestQuoteId_[pairKey];

        for (uint256 i = 0; i < MAX_PRICE_WALK && quoteId != 0; ++i) {
            QuoteData storage q = quotes_[quoteId];
            if (_isCanonicalCandidate(q)) {
                return (q.price, q.settledSlot != 0 ? q.settledSlot : q.expiryBlock, true);
            }
            quoteId = prevQuoteId_[quoteId];
        }

        // Checkpoint floor: settleValidQuote's pointer is always a valid past price.
        quoteId = latestValidQuoteId_[pairKey];
        if (quoteId != 0 && _isCanonicalCandidate(quotes_[quoteId])) {
            QuoteData storage q = quotes_[quoteId];
            return (q.price, q.settledSlot != 0 ? q.settledSlot : q.expiryBlock, true);
        }
        return (0, 0, false);
    }

    function latestValidQuoteId(bytes32 pairHash) external view returns (uint256) {
        return latestValidQuoteId_[pairHash];
    }

    function nextQuoteId() external view returns (uint256) {
        return nextQuoteId_;
    }

    function quotes(uint256 quoteId) external view returns (Quote memory) {
        QuoteData storage q = quotes_[quoteId];
        if (q.provider == address(0)) revert QuoteDoesNotExist();
        return Quote({
            provider: q.provider,
            baseToken: q.baseToken,
            quoteToken: q.quoteToken,
            baseAmount: q.baseAmount,
            quoteAmount: q.quoteAmount,
            price: q.price,
            startSlot: q.startSlot,
            expiryBlock: q.expiryBlock,
            settledSlot: q.settledSlot,
            status: q.status
        });
    }

    function _getPairKey(address baseToken, address quoteToken)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(baseToken, quoteToken));
    }

    /// @dev True when a quote's price is canonical without an explicit settle tx
    ///      (mirror upstream _isCanonicalCandidate). Matured ACTIVE quotes are
    ///      implicitly settled; VETOED_* are never canonical.
    function _isCanonicalCandidate(QuoteData storage q) internal view returns (bool) {
        QuoteStatus s = q.status;
        if (s == QuoteStatus.ACTIVE) return block.number > uint256(q.expiryBlock);
        if (s == QuoteStatus.SETTLED_VALID) return true;
        if (s == QuoteStatus.SETTLED_WITHDRAWN) return q.settledSlot != 0;
        return false; // VETOED_UNDERPRICED / VETOED_OVERPRICED — never canonical
    }
}
