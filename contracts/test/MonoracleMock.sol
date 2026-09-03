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
    mapping(bytes32 => uint256) public latestValidQuoteId_;

    error ExpiryMustBeFuture();
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
        IERC20(q.quoteToken).safeTransfer(msg.sender, q.quoteAmount);

        q.status = QuoteStatus.VETOED_OVERPRICED;
        emit QuoteVetoedOverpriced(quoteId, msg.sender);
    }

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
        if (q.status == QuoteStatus.ACTIVE) revert VerificationWindowActive();
        if (q.status == QuoteStatus.SETTLED_VALID) revert NotWithdrawable();

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

    function getLatestPrice(address baseToken_, address quoteToken_)
        external
        view
        returns (uint256 price, uint32 settledSlot, bool exists)
    {
        bytes32 pairKey = _getPairKey(baseToken_, quoteToken_);
        uint256 quoteId = latestValidQuoteId_[pairKey];
        if (quoteId == 0) return (0, 0, false);

        QuoteData storage q = quotes_[quoteId];
        return (q.price, q.settledSlot, true);
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
}
