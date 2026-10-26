// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IRMarketVault} from "./IRMarketVault.sol";

/**
 * @title IRMarketVaultFactory
 * @notice Permissionless per-pair LP vaults.
 *
 * The product is one vault per pair: LPs deposit only into the vault of the pair
 * they choose, so their counterparty risk is that pair only (architecture §7.3).
 * Before this factory, the operator deployed the single MVP vault by hand and the
 * web hard-coded its address — a pair without a deployed vault simply had no LP
 * page.
 *
 * Anyone can create a vault for any (base, quote) pair, and anyone can deposit
 * into any of them (`IRMarketVault.deposit` is already permissionless). Two rules
 * keep the risk model coherent:
 *
 *  * **one vault per pair** — a second vault on the same pair would dilute the
 *    anti-manipulation bond floor (LP-D12: the canonical price is global to the
 *    pair, but each vault sizes its bond against its own equity). The factory is
 *    the dedup point; `vaultFor` lets the UI ask before sending a tx.
 *  * **the oracle is bound at construction** — every vault this factory creates
 *    reads the same consumed Monoracle, so an upgrade means a new factory (and
 *    new vaults), never a re-point.
 *
 * The quote token is a parameter (USD and HKD are both live), so a pair can have
 * one vault per quote currency: (base, USD) and (base, HKD) are different pairs.
 *
 * The vault itself has no owner or admin — creating one grants no power over LP
 * funds — so permissionless creation is not a rug vector. `feeBps` is capped
 * here (10%) to keep a user-created vault inside a sane range.
 */
contract IRMarketVaultFactory {
    /// @notice Cap on a vault's premium fee, in basis points (10%).
    uint256 public constant MAX_FEE_BPS = 1_000;

    /// @notice The consumed Monoracle every vault reads. Immutable: a new oracle
    ///         means a new factory (and new vaults).
    address public immutable oracle;

    /// @dev keccak256(abi.encodePacked(base, quote)) => vault
    mapping(bytes32 => address) private _vaultFor;

    /// @notice All vaults, in creation order (UI enumeration; one entry per pair).
    address[] public vaults;

    /// @notice True for a vault this factory created.
    mapping(address => bool) public isVault;

    event VaultCreated(
        address indexed vault,
        address indexed baseToken,
        address indexed quoteToken,
        address creator,
        uint256 feeBps
    );

    error InvalidConfig();
    error VaultExists(address vault);

    constructor(address oracle_) {
        if (oracle_ == address(0)) revert InvalidConfig();
        oracle = oracle_;
    }

    // ------------------------------------------------------------------
    // Create
    // ------------------------------------------------------------------

    /**
     * @notice Create the vault for `(baseToken, quoteToken)`.
     * @dev Reverts when the pair already has one (`VaultExists` with its
     *      address) so callers can read `vaultFor` first. `feeBps` must be below
     *      `MAX_FEE_BPS`; the vault's constructor re-checks its own bounds.
     */
    function createVault(
        address baseToken,
        address quoteToken,
        uint256 feeBps
    ) external returns (address vault) {
        if (baseToken == address(0) || quoteToken == address(0) || baseToken == quoteToken) {
            revert InvalidConfig();
        }
        if (feeBps >= MAX_FEE_BPS) revert InvalidConfig();

        bytes32 key = pairKey(baseToken, quoteToken);
        address existing = _vaultFor[key];
        if (existing != address(0)) revert VaultExists(existing);

        vault = address(new IRMarketVault(oracle, baseToken, quoteToken, feeBps));
        _vaultFor[key] = vault;
        isVault[vault] = true;
        vaults.push(vault);

        emit VaultCreated(vault, baseToken, quoteToken, msg.sender, feeBps);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function pairKey(address baseToken, address quoteToken) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(baseToken, quoteToken));
    }

    /// @notice The vault for this pair, or `address(0)` when none exists yet.
    function vaultFor(address baseToken, address quoteToken) external view returns (address) {
        return _vaultFor[pairKey(baseToken, quoteToken)];
    }

    /// @notice Number of vaults created (index into `vaults`).
    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }
}
