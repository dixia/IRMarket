"""IRMarket market-maker & settlement bot (Monad testnet).

Implements bot/prd.md FR-BOT-001..004 on the V0.9 Veto-Market design
(docs/sc-tech-spec.md §5.1/§8.2):

  - Quoting loop (FR-BOT-001): keep one ACTIVE quote per round at the tracked fair
    price (per-quote expiryBlock = the market's expiryBlock, D-13). Re-quote
    (restock) immediately whenever our quote is vetoed.
  - Settlement quote (FR-BOT-002): SETTLEMENT_QUOTE_LEAD_BLOCKS before expiry,
    read the fair price once and submit (a) a final TRADING quote (expiry E) and
    (b) the final SETTLEMENT quote (expiry E + SETTLEMENT_WINDOW_BLOCKS). (b)
    settles LAST as the round mark (终价, D-06); its wider expiry is what keeps a
    delayed inclusion from reverting `ExpiryMustBeFuture` (dixia/IRMarket#22).
  - Auto-settle (FR-BOT-003): inside the settlement window [E, E+G], settle ALL
    ACTIVE trading quotes of the round oldest-first, once; after E+G settle the
    settlement quote LAST (= canonical price), then withdraw our funds.
    Optionally create the next round's market and keep quoting (AUTO_CREATE_MARKET).
  - Veto watch (FR-BOT-004): detect vetoes on our quotes, withdraw the 2x
    other-side return, log provider P&L.

The bot is the market maker / provider: bilateral collateral quotes back every
trade, zero-sum (D-10); the 1% wrapper fee lands at market.marketMaker in HKD.
"""

import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv
from eth_abi import decode
from web3 import Web3

try:  # script dir on sys.path when run as `python bot/verifier.py`
    from price_feed import FeedOutageError, build_feed
except ImportError:  # imported as a package (bot.verifier) rather than a script
    import sys

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from price_feed import FeedOutageError, build_feed

# Load bot/.env by EXPLICIT PATH, not via a bare load_dotenv().
#
# Bare load_dotenv() delegates to find_dotenv(), which normally walks up from this
# file's directory and finds bot/.env. But find_dotenv() abandons that strategy and
# falls back to os.getcwd() whenever _is_interactive(), _is_debugger()
# (sys.gettrace() is not None — i.e. ANY debugger), or sys.frozen is true. With a CWD
# that is not bot/ there is no .env to find, every var silently stays unset, and the
# bot dies with "RPC unreachable: https://testnet-rpc.monad.xyz" (the default) — which
# is exactly what happens when you run this file from VS Code / PyCharm's debugger.
#
# An explicit path is immune to CWD, debugger and REPL. override=False is kept, so
# variables already in the environment still win (e.g. $env:MARKET_ID=n overrides
# bot/.env).
#
# BOT_ENV_FILE selects a different env file (e.g. bot/.env.fuji for the second
# systemd unit on the ops box). Unset -> bot/.env, so existing deployments and
# scripts/ops/run_testnet_live.sh (which already exports BOT_ENV_FILE) behave as before.
_ENV_OVERRIDE = os.getenv("BOT_ENV_FILE")
load_dotenv(Path(_ENV_OVERRIDE) if _ENV_OVERRIDE else Path(__file__).resolve().parent / ".env")

log = logging.getLogger("irmarket-bot")

E18 = 10**18

# QuoteStatus enum (Monoracle)
ACTIVE = 0
VETOED_UNDERPRICED = 1
VETOED_OVERPRICED = 2
SETTLED_VALID = 3
SETTLED_WITHDRAWN = 4

# Upstream Monoracle caps the veto window; a quote whose expiry exceeds block + this reverts
# `ExpiryTooFar`. Mirror ../monoracle Monoracle.sol (`MAX_VERIFICATION_SLOTS`).
MAX_VERIFICATION_SLOTS = 12000
# Adaptive loop period (plan §4.5). While ANY driven pair sits inside its near-expiry
# band (E-LOOKBACK .. E+3 blocks) the drivers poll every NEAR_EXPIRY_POLL_SECONDS instead of
# QUOTE_INTERVAL_SECONDS: the final-quotes read fires at `lead` = 3 blocks (~0.93 s)
# before E, and a 5 s loop would step over that window ~85% of the time. The band ends
# at E+3 because inside the settlement window the only timed action (the late
# settlement quote, gated at E+G-2) tolerates a 5 s granularity.
# LOOKBACK must exceed ONE FULL LOOP PERIOD in blocks, or the bot can step straight
# over the band and miss the at-lead submission: measured on the AWS box the loop
# period is ~13-20 s (QuickNode serves ~1.5 s per RPC call, and a step makes 5-10
# calls), i.e. 42-65 blocks - hence 65, not a small constant.
NEAR_EXPIRY_LOOKBACK_BLOCKS = 65
NEAR_EXPIRY_LOOKAHEAD_BLOCKS = 3
NEAR_EXPIRY_POLL_SECONDS = 0.4
# Multicall3 (n3) `aggregate3` — the minimum the bot needs to batch its per-step
# reads. Canonical deployment: 0xcA11bde05977b3631167028862bE2a173976CA11 (Monad
# testnet, same address web/src/lib/wagmi.ts uses).
MULTICALL3_ABI = [
    {
        "inputs": [
            {
                "components": [
                    {"name": "target", "type": "address"},
                    {"name": "allowFailure", "type": "bool"},
                    {"name": "callData", "type": "bytes"},
                ],
                "name": "calls",
                "type": "tuple[]",
            }
        ],
        "name": "aggregate3",
        "outputs": [
            {
                "components": [
                    {"name": "success", "type": "bool"},
                    {"name": "returnData", "type": "bytes"},
                ],
                "name": "returnData",
                "type": "tuple[]",
            }
        ],
        "stateMutability": "view",
        "type": "function",
    }
]

# Fixed gas limits — Monad bills the gas LIMIT, not gas used (sc-tech-spec §7), so an
# inflated limit burns MON on every single send. These are **measured gasUsed + 5%**,
# re-measured on the live stack 2026-10-21 with `eth_estimateGas` on the exact calldata
# of real bot transactions (historical block where needed):
#
#   op             live cold   mock first    adopted
#   approve            33,586       47,242      56,691
#   submit_quote      287,219      292,944     315,413
#   settle             48,192       65,429      72,956
#   withdraw          123,206      123,206     150,000
#   create_market     172,678      198,542     218,789
#
# "live cold" = eth_estimateGas on the real oracle/wrapper (the production path);
# "mock/first" = the local Hardhat gas test and the first-of-round cold SSTOREs
# (fresh allowance slot, first settle per pair writing latestValidQuoteId). Adopted =
# the larger of live x1.05 and first-call x1.05, so both the production cost and
# test/gas.test.js's 120% headroom tripwire are satisfied. A test run with the bare
# live values reverted createMarket and one submitQuote out of gas — the tripwire
# was right.
#
# Re-measure with `npx hardhat run script/gas-report.js` (local) or eth_estimateGas
# (live) before changing any of these. test/gas.test.js fails if a limit drops below
# what the contracts actually need.
#
# WARNING: on Monad eth_getTransactionReceipt.gasUsed equals the gas limit you sent,
# so the bot's own "ok (gas N)" log line is NOT a usage measurement — never tune this
# table from it.
#
# Each entry is overridable with GAS_<OP>_WEI (e.g. GAS_SUBMIT_QUOTE_WEI=500000) so a
# limit can be bumped in production without a code change.
GAS_DEFAULTS = {
    "approve": 56_691,
    "submit_quote": 315_413,
    "settle": 72_956,
    "withdraw": 150_000,
    "create_market": 218_789,
}


def _load_gas_table() -> dict[str, int]:
    table: dict[str, int] = {}
    for op, default in GAS_DEFAULTS.items():
        env_name = f"GAS_{op.upper()}_WEI"
        raw = os.getenv(env_name)
        if raw is None:
            table[op] = default
            continue
        try:
            value = int(raw)
        except ValueError:
            raise RuntimeError(f"{env_name} must be an integer gas limit, got {raw!r}")
        if value < 21_000:
            raise RuntimeError(f"{env_name}={value} is below the 21,000 intrinsic tx cost")
        table[op] = value
    return table


GAS = _load_gas_table()


def _load_abi(rel_path: str) -> list[dict]:
    import json
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    with open(root / rel_path, encoding="utf8") as f:
        data = json.load(f)
    return data["abi"] if isinstance(data, dict) and "abi" in data else data


class PairConfig:
    """One tradeable pair. Fair price is 1e18 fixed-point.

    Built either from a multi-asset `ASSETS_FILE` entry or from the legacy
    `MONITORED_PAIRS`+`MARKET_ID` env vars. Carries only pair-specific fields;
    chain-level resources live in `BotContext`."""

    def __init__(
        self,
        base_token: str,
        quote_token: str,
        fair_price: int,
        market_id: int,
        symbol: Optional[str] = None,
        expiry_block: Optional[int] = None,
        price_source: Optional[str] = None,
        price_symbol: Optional[str] = None,
        asset_class: Optional[str] = None,
        fx_quote_per_usd: Optional[float] = None,
    ) -> None:
        self.base_token = base_token
        self.quote_token = quote_token
        self.fair_price = int(fair_price)
        self.market_id = int(market_id)
        self.symbol = symbol or base_token[:10]
        self.expiry_block = int(expiry_block) if expiry_block is not None else None
        # Real-price-feed descriptors (docs/design/bot-real-price-feed-spec.md §6.1).
        # Absent/None => the legacy synthetic walk (build_feed handles it).
        self.price_source = price_source
        self.price_symbol = price_symbol
        self.asset_class = asset_class
        self.fx_quote_per_usd = fx_quote_per_usd


class BotContext:
    """Chain-level resources shared by every pair's bot instance: the provider,
    wallet, oracle/market contracts, and the wallet's nonce cursor.

    Sharing the nonce cursor keeps the sequential per-pair sends from racing
    each other when several pairs are driven in one process."""

    def __init__(self, shared: Optional[dict] = None) -> None:
        shared = shared or {}
        rpc = os.getenv("RPC_HTTP_URL", "https://testnet-rpc.monad.xyz")
        # Per-request timeout so a stalled connection raises (and is retried by the
        # loop) rather than hanging the bot forever.
        self.w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 15}))
        # The endpoint drops TLS connections intermittently (SSLEOFError, ~15% of
        # calls), so a single is_connected() probe is unreliable — retry before
        # declaring the RPC dead.
        for attempt in range(5):
            if self.w3.is_connected():
                break
            log.warning("RPC not ready (attempt %d/5): %s", attempt + 1, rpc)
            time.sleep(2)
        else:
            raise RuntimeError(f"RPC unreachable after retries: {rpc}")

        # web3 v7's ValidationMiddleware re-resolves the chain id (TWO `eth_chainid`
        # calls) for every single `eth_call`, just to validate tx params this bot never
        # sets. Measured on the production endpoint: 1,198,195 `eth_chainid` out of
        # 2,344,000 requests in 8 days, and the count decomposes exactly as
        # 2 x (web3 eth_call) + 1 x (signed tx) — i.e. >50% of the RPC bill produced
        # nothing. The bot is single-chain, so keep the middleware's only useful check
        # here, once at boot, and drop the per-call overhead.
        try:
            self.w3.middleware_onion.remove("validation")
        except Exception as e:  # middleware renamed/removed in a future web3
            log.warning(
                "could not drop web3's validation middleware (%s) — every eth_call "
                "will cost 2 extra eth_chainid", e,
            )
        self.chain_id = int(shared.get("chainId") or os.getenv("CHAIN_ID", "10143"))
        actual_chain_id = self.w3.eth.chain_id
        if actual_chain_id != self.chain_id:
            raise RuntimeError(
                f"RPC chain id {actual_chain_id} != expected {self.chain_id} ({rpc})"
            )

        self.pk = os.environ["PRIVATE_KEY"]
        self.account = self.w3.eth.account.from_key(self.pk)
        self.address = self.account.address

        # Assets file (when present) is authoritative for the shared addresses;
        # env vars are the fallback so the legacy single-pair setup keeps working.
        oracle_addr = shared.get("oracle") or os.getenv("ORACLE_ADDRESS")
        market_addr = shared.get("market") or os.getenv("MARKET_ADDRESS")
        if not oracle_addr or not market_addr:
            raise RuntimeError("ORACLE_ADDRESS and MARKET_ADDRESS must be set")
        self.oracle_addr = Web3.to_checksum_address(oracle_addr)
        self.market_addr = Web3.to_checksum_address(market_addr)
        self.oracle = self.w3.eth.contract(
            address=self.oracle_addr, abi=_load_abi("abi/Monoracle.abi.json")
        )
        self.market = self.w3.eth.contract(
            address=self.market_addr,
            abi=_load_abi("artifacts/contracts/IRMarket.sol/IRMarket.json"),
        )
        # Multicall3 (n3) at the canonical address on Monad testnet — the same one
        # web/src/lib/wagmi.ts points at. Used to batch the per-step reads; when it
        # is absent (or the call fails) every reader falls back to plain eth_calls.
        self.multicall3 = self.w3.eth.contract(
            address=Web3.to_checksum_address(
                os.getenv("MULTICALL3_ADDRESS", "0xcA11bde05977b3631167028862bE2a173976CA11")
            ),
            abi=MULTICALL3_ABI,
        )

        self.nonce: Optional[int] = None


def _resolve_assets_path(explicit: Optional[str] = None) -> Path:
    """Resolve ASSETS_FILE relative to the repo root (not the cwd); absolute
    paths are honoured as-is."""
    rel = explicit or os.getenv("ASSETS_FILE") or "deployment-assets.json"
    p = Path(rel)
    if not p.is_absolute():
        p = Path(__file__).resolve().parent.parent / p
    return p


def load_asset_configs(explicit: Optional[str] = None) -> Optional[tuple[dict, list[PairConfig]]]:
    """Parse the multi-asset file. Returns `(shared, pairs)`, or `None` when the
    file is absent/empty so the caller can fall back to the single-pair env.

    Pure parsing — never touches the chain, so it is safe to unit-exercise."""
    import json

    fp = _resolve_assets_path(explicit)
    if not fp.is_file():
        return None
    with open(fp, encoding="utf8") as f:
        data = json.load(f)
    assets = data.get("assets") if isinstance(data, dict) else None
    if not assets:
        return None

    shared = {
        "network": data.get("network"),
        "chainId": data.get("chainId"),
        "oracle": data.get("oracle"),
        "market": data.get("market"),
        "quoteToken": data.get("quoteToken"),
    }
    shared_quote = shared.get("quoteToken")
    pairs: list[PairConfig] = []
    for i, a in enumerate(assets):
        quote_token = a.get("quoteToken") or shared_quote
        if not a.get("baseToken") or not quote_token or a.get("fairPrice") is None:
            raise ValueError(f"assets[{i}] missing baseToken/quoteToken/fairPrice")
        pairs.append(
            PairConfig(
                base_token=a["baseToken"],
                quote_token=quote_token,
                fair_price=int(a["fairPrice"]),
                market_id=int(a.get("marketId", "0")),
                symbol=a.get("symbol"),
                expiry_block=a.get("expiryBlock"),
                price_source=a.get("priceSource"),
                price_symbol=a.get("priceSymbol"),
                asset_class=a.get("assetClass"),
                fx_quote_per_usd=a.get("fxQuotePerUsd"),
            )
        )
    return shared, pairs


def load_env_pair() -> PairConfig:
    """Legacy single-pair config: `MONITORED_PAIRS=BASE,QUOTE,FAIR_PRICE` (1e18)
    plus `MARKET_ID`."""
    parts = os.environ["MONITORED_PAIRS"].split(",")
    return PairConfig(
        base_token=parts[0].strip(),
        quote_token=parts[1].strip(),
        fair_price=int(parts[2].strip()),
        market_id=int(os.getenv("MARKET_ID", "0")),
        symbol=os.getenv("ASSET_SYMBOL"),
    )


def resolve_pairs(explicit: Optional[str] = None) -> tuple[dict, list[PairConfig]]:
    """Pick multi-asset vs legacy single-pair config.

    Multi-asset (assets file) wins when ASSETS_FILE is set and the file lists at
    least one asset. If ASSETS_FILE is set but the file is missing/empty, fail
    loudly: silently falling back to `load_env_pair()` surfaced a missing file as
    a confusing `KeyError: 'MONITORED_PAIRS'`."""
    loaded = load_asset_configs(explicit)
    if loaded is not None:
        return loaded
    configured = explicit or os.getenv("ASSETS_FILE")
    if configured:
        raise RuntimeError(
            f"ASSETS_FILE='{configured}' not found (or empty) at "
            f"{_resolve_assets_path(explicit)} — create it, or unset ASSETS_FILE "
            f"to use the legacy MONITORED_PAIRS config"
        )
    return {}, [load_env_pair()]


class MarketMakerBot:
    """Market maker for ONE pair. Chain resources come from a shared
    `BotContext`; pair-specific state (tokens, market id, own quotes, withdrawn
    set, settlement-quote id) stays on the instance so pairs never interfere.

    Backward compatible: with no args it reads the legacy single-pair env."""

    def __init__(
        self, pair: Optional[PairConfig] = None, context: Optional[BotContext] = None
    ) -> None:
        self.ctx = context if context is not None else BotContext()
        self.w3 = self.ctx.w3
        self.pk = self.ctx.pk
        self.account = self.ctx.account
        self.address = self.ctx.address
        self.oracle_addr = self.ctx.oracle_addr
        self.market_addr = self.ctx.market_addr
        self.oracle = self.ctx.oracle
        self.market = self.ctx.market

        if pair is None:
            pair = load_env_pair()
        self.pair = pair
        self.symbol = pair.symbol
        self.base_token = Web3.to_checksum_address(pair.base_token)
        self.quote_token = Web3.to_checksum_address(pair.quote_token)
        self.feed = build_feed(pair, logger=log)
        self.expiry_hint = pair.expiry_block

        self.market_id = pair.market_id
        # 3 = ~0.93 s of budget at ~310 ms blocks. `lead` controls price FRESHNESS
        # only — the price is frozen at the decision block, and the safety net against
        # a delayed inclusion is the settlement window below (the settlement quote may
        # land anywhere in [E, E+G]), so the lead no longer has to cover the observed
        # delivery distribution (3/7/28 blocks, dixia/IRMarket#22).
        self.lead_blocks = int(os.getenv("SETTLEMENT_QUOTE_LEAD_BLOCKS", "3"))
        # Settlement window G (blocks): the final settlement quote's expiryBlock is
        # E + G, so a tx included any block in [E, E+G] is accepted — a delayed send
        # can no longer revert `ExpiryMustBeFuture`. Default 60 ≈ 18.6 s covers the
        # observed inclusion outliers (28 blocks) plus an RPC hiccup and one retry
        # cycle. G delays only the confirmation and the provider's collateral return:
        # the final TRADING quote (expiry E) settles ~1 block after E and already
        # carries the round mark.
        self.settlement_window_blocks = int(os.getenv("SETTLEMENT_WINDOW_BLOCKS", "60"))
        self.round_blocks = int(os.getenv("ROUND_BLOCKS", "6000"))  # ~30 min @300ms
        self.auto_create = os.getenv("AUTO_CREATE_MARKET", "1") == "1"
        # Demo: re-quote every loop (even with an active quote) so the canonical price
        # keeps moving; off by default (production holds one active quote per round).
        self.requote = os.getenv("REQUOTE_EVERY_LOOP", "0") == "1"
        self.poll_seconds = float(os.getenv("QUOTE_INTERVAL_SECONDS", "5"))

        base_amount = int(os.getenv("QUOTE_BASE_AMOUNT", str(1 * E18)))
        self.quote_base = base_amount
        self.gas_price_cap = int(os.getenv("GAS_PRICE_CAP_WEI", "0"))  # 0 = use chain

        self._nonce = None  # property → the shared BotContext nonce cursor
        # Id of THIS round's final settlement quote (expiry E + settlement_window_blocks),
        # or None while it has not been submitted. Replaces the old boolean
        # `_final_submitted`: `is None` is the "not submitted yet" gate (step, restart
        # recovery) and the id itself is the handle `settle_settlement_quote` needs.
        self._settlement_quote_id: Optional[int] = None
        # The trading-quote (expiry E) settle/withdraw pass runs ONCE per round — the
        # settlement window spans G blocks and the loop revisits it, and settling twice
        # would burn gas (and re-log) for nothing. Reset by roll_round.
        self._round_swept = False
        # Head / expiry remembered by the last step(); the drivers derive their adaptive
        # sleep from these, so a fast poll near expiry costs no extra RPC per loop.
        self._last_head: Optional[int] = None
        self._last_expiry: Optional[int] = None
        #
        # Bounded quote bookkeeping (replaces the old ever-growing `_own_quotes`):
        #
        #   _own_current  our own ids for the CURRENT round, status ACTIVE — drives the
        #                 restock decision and is cleared when the round rolls. ≤ a few.
        #                 NEVER holds the E+G settlement quote (see submit_quote's
        #                 `track_own` and the recover-scan): only settle_settlement_quote
        #                 may touch it, and only after the settlement window.
        #   _pending_own  our own ids still owed an action (endpoint-reached: vetoed, or
        #                 settled but not yet withdrawn), ANY round. An entry is dropped
        #                 the moment its withdraw succeeds, so the set only ever holds
        #                 unresolved leftovers — not a lifetime ledger.
        #
        # The old layout made the per-step cost O(all our own ids) and each round roll
        # O(the whole ledger): both grow without bound, and since the oracle is SHARED
        # across pairs/processes, the sweep alone was ~2 min of RPC per step for a
        # 3.4-min round — the bot then spent the round chasing its own steps, which is
        # where the near-expiry quotes that revert `ExpiryMustBeFuture` came from.
        self._own_current: set[int] = set()
        self._pending_own: set[int] = set()
        self._booted = False  # the startup recover-scan runs once, inside step()
        # Per-step read cache. Only consulted by readers that do NOT gate a send: a
        # written decision must always use a fresh `_quote`, because a cached status that
        # just changed on-chain could tip us into paying for a tx that then reverts
        # (Monad bills the gas LIMIT, not what a tx used).
        self._read_cache: dict[int, dict] = {}
        self._read_count = 0  # per-step quote/market reads, logged at DEBUG (see step)
        self._batch_warned = False  # one loud warning if Multicall3 batching is broken

    @property
    def _nonce(self) -> Optional[int]:
        return self.ctx.nonce

    @_nonce.setter
    def _nonce(self, value: Optional[int]) -> None:
        self.ctx.nonce = value

    # ---------------------------------------------------------------- helpers

    def _sync_nonce(self) -> int:
        self._nonce = self.w3.eth.get_transaction_count(self.address, "pending")
        return self._nonce

    def _gas_price(self) -> int:
        price = self.w3.eth.gas_price
        if self.gas_price_cap and price > self.gas_price_cap:
            return self.gas_price_cap
        return price

    def _send(
        self,
        fn: Any,
        gas: int,
        label: str,
        decision_block: Optional[int] = None,
        decision_ts: Optional[float] = None,
    ) -> Any:
        """Sign + send a tx with manual nonce tracking; retry on nonce races.

        Emits one DEBUG `[latency]` line per attempt with the three checkpoints the
        delivery-latency probe needs:
          - decision: the head read (`decision_block`) + wall clock used to decide
          - sent:     wall clock, and the head, right after send_raw_transaction returns
          - receipt:  wall clock + the block that actually included the tx

        `dt_send_s` isolates the bot's own processing from the network's inclusion
        delay (`post_send_gap_blocks`); `incl_gap_blocks` is the sum of the two.
        """
        for _ in range(5):
            if self._nonce is None:
                self._sync_nonce()
            tx = fn.build_transaction(
                {
                    "from": self.address,
                    "nonce": self._nonce,
                    "gas": gas,
                    "gasPrice": self._gas_price(),
                    # Pin it: without this web3's TRANSACTION_DEFAULTS fills chainId in
                    # by spending one more `eth_chainid` per send.
                    "chainId": self.ctx.chain_id,
                }
            )
            signed = self.w3.eth.account.sign_transaction(tx, self.pk)
            try:
                h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
            except Exception as e:  # web3 v7 raises Web3RPCError for nonce races
                if "nonce" in str(e).lower():
                    self._sync_nonce()
                    continue
                raise
            t_sent = time.time()
            try:
                head_at_send = self.w3.eth.block_number
            except Exception:
                head_at_send = None
            receipt = self.w3.eth.wait_for_transaction_receipt(h, timeout=120)
            t_recv = time.time()
            self._log_latency(
                label, h.hex(), decision_block, decision_ts, head_at_send, t_sent, receipt, t_recv
            )
            if receipt.status != 1:
                # A mined-but-reverted tx still consumed the account nonce. Advance the
                # cursor so the next send does not reuse it (that would pay for a second
                # failed attempt before the nonce-race recovery kicks in).
                self._nonce += 1
                raise RuntimeError(f"{label}: tx reverted {h.hex()}")
            self._nonce += 1
            log.info("%s ok (gas %s) %s", label, receipt.gasUsed, h.hex())
            return receipt
        raise RuntimeError(f"{label}: nonce sync exhausted")

    def _log_latency(
        self,
        label: str,
        tx_hash: str,
        decision_block: Optional[int],
        decision_ts: Optional[float],
        head_at_send: Optional[int],
        t_sent: float,
        receipt: Any,
        t_recv: float,
    ) -> None:
        """One greppable DEBUG `[latency] ...` line per send (inclusion-delay probe)."""
        recv_block = receipt["blockNumber"]
        parts = [
            f"label={label!r}",
            f"tx={tx_hash}",
            f"decision_block={decision_block}",
            f"decision_ts={decision_ts:.3f}" if decision_ts is not None else "decision_ts=?",
            f"sent_ts={t_sent:.3f}",
            f"head_at_send={head_at_send}",
            f"receipt_block={recv_block}",
            f"receipt_ts={t_recv:.3f}",
        ]
        if decision_ts is not None:
            parts.append(f"dt_send_s={t_sent - decision_ts:.3f}")
        if decision_block is not None and recv_block is not None:
            parts.append(f"incl_gap_blocks={recv_block - decision_block}")
        if head_at_send is not None and recv_block is not None:
            parts.append(f"post_send_gap_blocks={recv_block - head_at_send}")
        parts.append(f"wait_s={t_recv - t_sent:.3f}")
        log.debug("[latency] %s", " ".join(parts))

    def _market(self) -> tuple:
        return self.market.functions.markets(self.market_id).call()

    # Field order comes from the upstream Monoracle ABI (abi/Monoracle.abi.json, generated by
    # script/sync-oracle-abi.js): provider, baseToken, quoteToken, baseAmount, quoteAmount,
    # price, startSlot, expiryBlock, settledSlot, status. Index by NAME so a field-order change
    # cannot silently shift `expiryBlock` (the old fork ordered startSlot/settledSlot/expiryBlock).
    _QUOTE_FIELDS = (
        "provider", "baseToken", "quoteToken", "baseAmount", "quoteAmount",
        "price", "startSlot", "expiryBlock", "settledSlot", "status",
    )

    def _quote(self, qid: int) -> dict:
        self._read_count += 1
        return dict(zip(self._QUOTE_FIELDS, self.oracle.functions.quotes(qid).call()))

    def _quote_cached(self, qid: int) -> dict:
        """`_quote` for readers that do NOT decide a send. Anything that will lead to a
        transaction (a settle, a withdraw) must call `_quote` directly so the decision is
        made on the balance actually on-chain, never on a cached status."""
        if qid not in self._read_cache:
            self._read_cache[qid] = self._quote(qid)
        return self._read_cache[qid]

    def _read_snapshot(self) -> Optional[tuple]:
        """Batch this pair's per-step reads into ONE Multicall3 `aggregate3` call:
        `markets(marketId)` plus `quotes(qid)` for every tracked own id
        (`_own_current | _pending_own`). Fills `_read_cache` with the quote structs so
        `_active_own_quote` and `watch_vetoes` read from the same snapshot instead of
        one `eth_call` each.

        Why: on the ops box one RPC round-trip costs ~1.5 s and a step made 10+
        sequential calls, so a single loop iteration spanned ~50 blocks — wider than
        the whole near-expiry band, which is why the at-lead final quotes kept being
        submitted after expiry. One batched call + `eth_blockNumber` brings a step to
        ~2-3 s (~8-10 blocks), inside the band.

        Returns the market tuple, or None when the batch is unavailable (n3 not
        deployed, RPC error) so the caller falls back to the sequential reads — the
        bot then behaves exactly as before.

        Snapshot freshness: every value is read at the current block, so a decision
        taken from it is as fresh as a single `eth_call`; the cache is cleared at the
        top of each step, so nothing survives across steps. Send-gating readers
        (`settle_round`, `settle_settlement_quote`) still use fresh `_quote` reads.
        """
        ids = sorted(self._own_current | self._pending_own)
        market_types = [o["type"] for o in self._market_abi()["outputs"]]
        quote_types = [o["type"] for o in self._quote_abi()["outputs"]]
        calls = [
            (self.market_addr, False, self.market.encode_abi("markets", [self.market_id]))
        ]
        calls += [
            (self.oracle_addr, False, self.oracle.encode_abi("quotes", [qid]))
            for qid in ids
        ]
        try:
            results = self.ctx.multicall3.functions.aggregate3(calls).call()
        except Exception as e:
            # Loud once: a silent fallback triples the per-step read cost (the
            # production endpoint showed ~3.3 eth_call per head read, i.e. this path).
            if not self._batch_warned:
                self._batch_warned = True
                log.warning(
                    "[%s] Multicall3 snapshot unavailable (%s) — falling back to "
                    "sequential reads (~3x RPC per step); check MULTICALL3_ADDRESS",
                    self.symbol, e,
                )
            log.debug("[%s] snapshot batch unavailable (%s) — falling back to reads", self.symbol, e)
            return None
        self._read_count += 1  # one RPC call, however many logical reads it carried
        if len(results) != len(calls) or not results[0][0]:
            raise RuntimeError("snapshot batch: markets() call failed")
        market = tuple(decode(market_types, results[0][1]))
        for i, qid in enumerate(ids, start=1):
            success, data = results[i]
            if not success:
                continue  # id not in the ledger — a plain miss, not a batch failure
            self._read_cache[qid] = dict(zip(self._QUOTE_FIELDS, decode(quote_types, data)))
        return market

    def _market_abi(self) -> dict:
        """ABI element of the wrapper's `markets(uint256)` getter."""
        return self.market.get_function_by_name("markets").abi

    def _quote_abi(self) -> dict:
        """ABI element of the oracle's `quotes(uint256)` getter (10 flat outputs)."""
        return self.oracle.get_function_by_name("quotes").abi

    # ---------------------------------------------------------------- actions

    def ensure_approvals(self) -> None:
        """Approve the ORACLE to pull both collateral legs from the bot wallet."""
        erc20_abi = [
            {"constant": False, "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}], "name": "approve", "outputs": [{"name": "", "type": "bool"}], "type": "function"},
            {"constant": True, "inputs": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}], "name": "allowance", "outputs": [{"name": "", "type": "uint256"}], "type": "function"},
        ]
        for token in (self.base_token, self.quote_token):
            tok = self.w3.eth.contract(address=token, abi=erc20_abi)
            allowance = tok.functions.allowance(self.address, self.oracle_addr).call()
            if allowance >= (2**256 - 1) // 2:
                continue
            log.info("approving oracle for %s...", token)
            self._send(tok.functions.approve(self.oracle_addr, 2**256 - 1), GAS["approve"], "approve")

    def _rescan_own_quotes(self, round_expiry: int) -> None:
        """Startup recovery: re-hydrate `_own_current` / `_pending_own` /
        `_settlement_quote_id` after a restart.

        Scans the ledger BACKWARD (no `eth_getLogs` — the public RPC rejects wide ranges)
        and stops early: after 20 consecutive strangers or at the first quote whose
        expiry precedes the current round, because nothing older can be ours for this
        round either. Only called once per process — forward progress relies on the
        receipt id, not on rescanning.

        The final settlement quote (expiry E + settlement_window_blocks) is the NEWEST
        own quote of the round, so the backward scan meets it before the round's
        E-quotes. It is classified on its own — `_settlement_quote_id`, never
        `_own_current`/`_pending_own` — so the trading-quote pass can never settle it
        early; only `settle_settlement_quote` may, and only after the window. It does
        not disturb termination: its expiry is > round_expiry, so the early stop still
        fires at the first quote of an older round, and the 20-strangers stop is
        untouched (it is ours, so it resets that counter like any own quote).

        The oracle is shared across pairs/processes, so reads are filtered by our tokens;
        each instance never acts on another pair's quotes."""
        next_id = self.oracle.functions.nextQuoteId().call()
        consecutive_strangers = 0
        for qid in range(next_id - 1, 0, -1):
            q = self._quote(qid)
            if q["expiryBlock"] < round_expiry:
                break  # nothing older can belong to this round — stop scanning
            if q["provider"].lower() == self.address.lower():
                consecutive_strangers = 0
                if q["baseToken"].lower() != self.base_token.lower() or q["quoteToken"].lower() != self.quote_token.lower():
                    continue
                if q["expiryBlock"] == round_expiry + self.settlement_window_blocks:
                    # The final settlement quote. The scan is descending, so the first
                    # match is the newest — keep that one and suppress re-submission.
                    # (Assumes ROUND_BLOCKS != settlement_window_blocks, so the NEXT
                    # round's trading quotes never expire at exactly E+G.)
                    if self._settlement_quote_id is None:
                        self._settlement_quote_id = qid
                        log.info(
                            "[%s] recover-scan: settlement quote id=%s (expiry E+%s) — no re-submit",
                            self.symbol, qid, self.settlement_window_blocks,
                        )
                    continue
                if q["status"] == ACTIVE:
                    self._own_current.add(qid)
                elif q["status"] in (SETTLED_VALID, VETOED_UNDERPRICED, VETOED_OVERPRICED):
                    self._pending_own.add(qid)
                else:
                    log.debug(
                        "[%s] q%s already withdrawn — nothing to recover", self.symbol, qid,
                    )
            else:
                consecutive_strangers += 1
                if consecutive_strangers >= 20:
                    break

    def _active_own_quote(self, round_expiry: int) -> Optional[int]:
        """Our newest ACTIVE quote for THIS round (expiryBlock == market expiry), if any.

        Bounded: only `_own_current` — the lifetime of an entry is exactly one round, so
        this is a couple of reads, not an O(all history) sweep. Reads may use the cache:
        a wrong "still ACTIVE" only costs a step of restock, it cannot send anything."""
        active = None
        for qid in self._own_current:
            q = self._quote_cached(qid)
            if q["expiryBlock"] != round_expiry:
                continue  # belongs to a different round
            if q["status"] == ACTIVE:
                active = qid if active is None or qid > active else active
        return active

    def submit_quote(
        self,
        expiry_block: int,
        label: str,
        fair: Optional[int] = None,
        track_own: bool = True,
    ) -> Optional[int]:
        """Submit one collateralized quote.

        `fair` lets a caller price several quotes from ONE feed read: the final trading
        quote and the settlement quote must carry the same price, so that a settlement
        quote vetoed during the window leaves the canonical mark on an identical price.
        `track_own=False` keeps the id out of `_own_current` — used for the E+G
        settlement quote, which only `settle_settlement_quote` may act on."""
        decision_ts = time.time()  # checkpoint 0: head read (for the [latency] line)
        block = self.w3.eth.block_number
        max_expiry = block + MAX_VERIFICATION_SLOTS
        if expiry_block > max_expiry:
            raise RuntimeError(
                f"[{self.symbol}] expiry {expiry_block} > block+{MAX_VERIFICATION_SLOTS} "
                f"({max_expiry}); upstream Monoracle would revert ExpiryTooFar"
            )
        if fair is None:
            try:
                fair = self.feed.get(block)
            except FeedOutageError as e:
                # Outage policy=halt: a possibly-15x-off seed mark is instantly veto-
                # arbitrated. Refuse to quote; the loop retries next tick.
                log.error("[%s] %s — NOT quoting this tick", self.symbol, e)
                return None
        quote_amount = self.quote_base * fair // E18
        qid_before = self.oracle.functions.nextQuoteId().call()
        receipt = self._send(
            self.oracle.functions.submitQuote(
                self.base_token, self.quote_token, self.quote_base, quote_amount, expiry_block
            ),
            GAS["submit_quote"],
            label,
            decision_block=block,
            decision_ts=decision_ts,
        )
        # Parse the event from logs emitted by the oracle only (avoids web3's
        # "MismatchedABI" warnings for ERC20 Transfer logs in the same tx).
        candidate = self._oracle_event_id(receipt, "QuoteSubmitted")
        if candidate is None:
            candidate = qid_before
        # Verify the candidate really is ours before it becomes bookkeeping: a fallback
        # id can be off by one when another provider's quote punched in before ours
        # landed, and acting on a stranger's id would be a real hazard. Checking is one
        # fresh read; only the fallback path can misfire, and it only everundershoots —
        # so the correction walks FORWARD, at most 3 ids.
        qid = self._resolve_own_quote(candidate, expiry_block)
        if track_own:
            self._own_current.add(qid)
        log.info(
            "[%s] quoted id=%s base=%s quote=%s price=%s (fair=%s)",
            self.symbol, qid, self.quote_base / E18, quote_amount / E18,
            quote_amount * E18 // self.quote_base, fair,
        )
        return qid

    def _oracle_event_id(self, receipt, event_name: str) -> Optional[int]:
        """Extract the first `quoteId` arg of an oracle event from a receipt, decoding
        only logs that originated from the oracle contract."""
        from eth_abi import decode
        from eth_utils import event_signature_to_log_topic

        event_def = getattr(self.oracle.events, event_name).abi
        sig = event_def["anonymous"] if "anonymous" in event_def else False
        topic0 = event_signature_to_log_topic(
            f"{event_name}({','.join(i['type'] for i in event_def['inputs'])})"
        )
        for lg in receipt.logs:
            if lg["address"].lower() != self.oracle_addr.lower():
                continue
            if not lg["topics"] or lg["topics"][0].hex() != topic0.hex():
                continue
            # quoteId is the first (indexed) arg → topics[1]
            return int(lg["topics"][1].hex(), 16)
        return None

    def _resolve_own_quote(self, candidate: int, expiry_block: int) -> int:
        """Fresh reads only: this gates a send, so the cached path is off-limits here.

        Returns the qid once our pair+provider+expiry match, walking forward at most 3
        ids; a missing id reads as "not ours" and just keeps walking. Falls back to the
        candidate so a transient chain that already cleaned the ledger cannot wedge the
        step."""
        for qid in range(candidate, candidate + 4):
            try:
                q = self._quote(qid)
            except Exception:
                continue  # id not (yet) in the ledger — a valid "not ours"
            if (
                q["provider"].lower() == self.address.lower()
                and q["baseToken"].lower() == self.base_token.lower()
                and q["quoteToken"].lower() == self.quote_token.lower()
                and q["expiryBlock"] == expiry_block
            ):
                return qid
        log.warning(
            "[%s] submit: candidate id %s is not ours after 4 reads — keeping it anyway",
            self.symbol, candidate,
        )
        return candidate

    def watch_vetoes(self, decision_block: Optional[int] = None) -> None:
        """FR-BOT-004: withdraw the 2x return on our vetoed quotes, log P&L.

        Bounded: only `_own_current | _pending_own`. An id is removed the moment its
        withdraw succeeds, so the sweep's size is exactly "what is still owed" and stops
        growing with round history. Also withdraws a SETTLED_VALID id whose withdraw
        didn't land when it was settled — a pure cleanup, because withdrawing does not
        touch `latestValidQuoteId`, so it cannot rewind the canonical mark.

        Reads come from the step's snapshot (`_quote_cached`, same-block) instead of a
        per-id `eth_call`: statuses only move forward (ACTIVE -> vetoed/settled ->
        withdrawn) and only we can withdraw, so a same-block snapshot can at worst make
        us miss an action this step, never perform a wrong one — the next step catches
        it. On the fallback path (no batch) `_quote_cached` simply reads each id.

        `decision_block` is the head read taken by `step()`: reuse it instead of paying
        one more `eth_blockNumber` on every step, and skip outright when nothing is owed.
        """
        ids = sorted(self._own_current | self._pending_own)
        if not ids:
            return  # nothing to watch — no head read, no reads at all
        if decision_block is None:
            decision_block = self.w3.eth.block_number
        decision_ts = time.time()
        for qid in ids:
            q = self._quote_cached(qid)
            if q["status"] == SETTLED_VALID:
                # a settle that landed without its withdraw (crash, RPC blip) — a pure
                # cleanup: withdrawing never touches `latestValidQuoteId`, so this cannot
                # rewind the canonical mark.
                self._send(
                    self.oracle.functions.withdrawProviderFunds(qid), GAS["withdraw"], f"withdraw q{qid}",
                    decision_block=decision_block, decision_ts=decision_ts,
                )
                self._own_current.discard(qid)
                self._pending_own.discard(qid)
                log.info("[%s] cleanup: settled-but-unwithdrawn q%s recovered", self.symbol, qid)
                continue
            if q["status"] not in (VETOED_UNDERPRICED, VETOED_OVERPRICED):
                continue
            base_amt, quote_amt = q["baseAmount"], q["quoteAmount"]
            try:
                fair = self.feed.get(decision_block)
            except FeedOutageError as e:
                # Feed outage: withdrawal itself does not depend on the mark,
                # withdraw anyway but report PnL as unavailable (no seed guess).
                log.error("[%s] %s — PnL unavailable for q%s (withdrawing anyway)", self.symbol, e, qid)
                fair = None
            if q["status"] == VETOED_UNDERPRICED:
                # we keep 2x quote, lose base
                side = "UNDERPRICED (trader went LONG)"
            else:
                # we keep 2x base, lose quote
                side = "OVERPRICED (trader went SHORT)"
            if fair is None:
                pnl_hkd = None
            elif q["status"] == VETOED_UNDERPRICED:
                pnl_hkd = quote_amt - base_amt * fair // E18
            else:
                pnl_hkd = base_amt * fair // E18 - quote_amt
            self._send(
                self.oracle.functions.withdrawProviderFunds(qid), GAS["withdraw"], f"withdraw q{qid}",
                decision_block=decision_block, decision_ts=decision_ts,
            )
            self._own_current.discard(qid)
            self._pending_own.discard(qid)
            log.warning(
                "[%s] VETO q%s %s | pnl≈%s HKD (base %s, quote %s, fair %s)",
                self.symbol, qid, side,
                "N/A" if pnl_hkd is None else pnl_hkd / E18,
                base_amt / E18, quote_amt / E18,
                "N/A" if fair is None else fair,
            )

    def settle_round(self, round_expiry: int, decision_block: Optional[int] = None) -> None:
        """After expiry: settle OUR OWN ACTIVE quotes for THIS round, oldest-first — the
        last one settled is our highest id, so it becomes the canonical mark (D-06/终价).
        Then withdraw everything still owed.

        Bounded two ways:
          * only OUR ids (`_own_current | _pending_own`) — the old `range(1, nextQuoteId)`
            sweep walked the whole LEDGER (~150 ids and growing, since the oracle is
            shared across pairs/processes), which is what made a step take minutes;
          * quoting-match is preserved exactly (expiryBlock == round_expiry), so a stale
            run still cannot touch the live round's quotes, and an active quote from an
            older round is NOT settled late (a late settle rewrites
            `latestValidQuoteId`, i.e. it would rewind the mark) — it is left for whoever
            settles it permissionlessly, as before.

        The same filter excludes THIS round's final settlement quote (expiry E+G ≠ E),
        and it is never in the id sets either — `settle_settlement_quote` owns it and
        runs it after this pass, LAST, so it is the canonical mark."""
        settled_ids = []
        if decision_block is None:
            decision_block = self.w3.eth.block_number
        decision_ts = time.time()
        for qid in sorted(self._own_current | self._pending_own):
            q = self._quote(qid)  # fresh read: every branch here gates a send
            if q["expiryBlock"] != round_expiry:
                # belongs to a different round. A still-ACTIVE one is NOT settled late:
                # any settle rewrites `latestValidQuoteId`, so a late settle would rewind
                # the new round's canonical mark. It stays for whoever settles it
                # permissionlessly; watch_vetoes still owns the pending (withdrawable)
                # leftovers of older rounds.
                continue
            if q["status"] == ACTIVE:
                self._send(
                    self.oracle.functions.settleValidQuote(qid), GAS["settle"], f"settle q{qid}",
                    decision_block=decision_block, decision_ts=decision_ts,
                )
                settled_ids.append(qid)
                # the settle just made it withdrawable — withdraw in the same pass rather
                # than re-reading, but keep the id in the sets until BOTH sends succeeded:
                # if the withdraw tx fails, the next step's own settle_round (id still
                # stored) runs the elif branch, so no escrow is ever stranded.
                self._send(
                    self.oracle.functions.withdrawProviderFunds(qid), GAS["withdraw"], f"withdraw q{qid}",
                    decision_block=decision_block, decision_ts=decision_ts,
                )
            elif q["status"] in (SETTLED_VALID, VETOED_UNDERPRICED, VETOED_OVERPRICED):
                self._send(
                    self.oracle.functions.withdrawProviderFunds(qid), GAS["withdraw"], f"withdraw q{qid}",
                    decision_block=decision_block, decision_ts=decision_ts,
                )
            self._own_current.discard(qid)
            self._pending_own.discard(qid)
        price = self.oracle.functions.getLatestPrice(self.base_token, self.quote_token).call()
        log.info(
            "[%s] round settled: canonical price=%s (settled %s of our own quotes)",
            self.symbol, price[0], len(settled_ids),
        )

    def settle_settlement_quote(
        self, round_expiry: int, decision_block: Optional[int] = None
    ) -> None:
        """Settle THIS round's final settlement quote (expiry E+G) — the sibling of
        `settle_round`, and it MUST run after it: `latestValidQuoteId` is last-write-
        wins, so the settlement quote settles LAST and its price is the canonical mark.

        Called only from the finalize phase (head > E+G). Fresh read first — every
        branch gates a send — and a single head read is shared by both sends, exactly
        like `settle_round`. Branches:
          * ACTIVE, window closed → settle, then withdraw in the same pass.
          * VETOED_* → withdraw only: the canonical mark falls back to the final
            trading quote, which carries the same price (same feed read at E-lead).
            Logged loudly (plan §11 risk 1).
          * SETTLED_VALID → withdraw only (crash between the settle and its withdraw).
          * anything else (already withdrawn, or ACTIVE with the window still open) →
            no send; the id is dropped so a later round starts clean.
        """
        qid = self._settlement_quote_id
        if qid is None:
            return  # never submitted (or already handled) — nothing owed
        window_end = round_expiry + self.settlement_window_blocks
        if decision_block is None:
            decision_block = self.w3.eth.block_number
        decision_ts = time.time()
        q = self._quote(qid)  # fresh read: every branch here gates a send
        if q["status"] == ACTIVE and decision_block <= window_end:
            return  # window still open — settling now would revert; retry next step
        if q["status"] == ACTIVE:
            self._send(
                self.oracle.functions.settleValidQuote(qid), GAS["settle"], f"settle q{qid} (settlement quote)",
                decision_block=decision_block, decision_ts=decision_ts,
            )
            self._send(
                self.oracle.functions.withdrawProviderFunds(qid), GAS["withdraw"], f"withdraw q{qid}",
                decision_block=decision_block, decision_ts=decision_ts,
            )
        elif q["status"] in (SETTLED_VALID, VETOED_UNDERPRICED, VETOED_OVERPRICED):
            if q["status"] != SETTLED_VALID:
                log.warning(
                    "[%s] settlement quote q%s VETOED — canonical mark falls back to the final trading quote",
                    self.symbol, qid,
                )
            self._send(
                self.oracle.functions.withdrawProviderFunds(qid), GAS["withdraw"], f"withdraw q{qid}",
                decision_block=decision_block, decision_ts=decision_ts,
            )
        else:
            return  # already withdrawn — nothing to send
        self._own_current.discard(qid)
        self._pending_own.discard(qid)
        self._settlement_quote_id = None
        price = self.oracle.functions.getLatestPrice(self.base_token, self.quote_token).call()
        log.info(
            "[%s] settlement quote q%s closed: canonical price=%s", self.symbol, qid, price[0],
        )

    def roll_round(self, current_expiry: int) -> int:
        """Create the next round's market (bot as marketMaker) and continue quoting."""
        if not self.auto_create:
            log.warning(
                "[%s] round %s expired — AUTO_CREATE_MARKET off, exiting round",
                self.symbol, self.market_id,
            )
            return self.market_id
        decision_ts = time.time()  # checkpoint 0: head read (for the [latency] line)
        block = self.w3.eth.block_number
        new_expiry = block + self.round_blocks
        fee_bps = int(os.getenv("FEE_BPS", "100"))
        receipt = self._send(
            self.market.functions.createMarket(
                self.base_token, self.quote_token, self.address, new_expiry, fee_bps
            ),
            GAS["create_market"],
            "createMarket (next round)",
            decision_block=block,
            decision_ts=decision_ts,
        )
        mid = self._market_created_id(receipt)
        if mid is None:
            raise RuntimeError("createMarket: MarketCreated event not found")
        log.warning(
            "[%s] NEXT ROUND: marketId=%s expiryBlock=%s (was %s) — update web/.env.local NEXT_PUBLIC_DEMO_MARKET_ID=%s",
            self.symbol, mid, new_expiry, current_expiry, mid,
        )
        self.market_id = mid
        # Per-round state reset for the new round: the settlement quote id and the
        # E-quote sweep flag belong to the round that just closed.
        self._settlement_quote_id = None
        self._round_swept = False
        return mid

    def _market_created_id(self, receipt) -> Optional[int]:
        """Extract the indexed marketId from MarketCreated (topic1), oracle-free."""
        from eth_utils import event_signature_to_log_topic

        topic0 = event_signature_to_log_topic(
            "MarketCreated(uint256,address,address,address,uint256,uint256)"
        )
        for lg in receipt.logs:
            if lg["address"].lower() != self.market_addr.lower():
                continue
            if not lg["topics"] or lg["topics"][0].hex() != topic0.hex():
                continue
            return int(lg["topics"][1].hex(), 16)
        return None

    # ---------------------------------------------------------------- main loop

    def step(self) -> None:
        """One iteration of the quoting loop for THIS pair (no sleep). Split out
        from `run` so the multi-pair driver can advance every pair in turn.

        Three phases, keyed off the market expiry E and the settlement window G
        (plan §3):
          NORMAL            head < E           veto watch; restock (expiry E) while
                                                E-head > lead; at E-head <= lead read
                                                the price ONCE and submit the final
                                                trading quote (expiry E, only if no
                                                active one) plus the final settlement
                                                quote (expiry E+G). No restock after.
          SETTLEMENT WINDOW E <= head <= E+G   veto watch; settle/withdraw the round's
                                                E-quotes ONCE (only once head > E —
                                                settling at head == E reverts
                                                VerificationWindowActive); late-submit the
                                                settlement quote if it was never sent and
                                                the window is not about to close. No
                                                restock with expiry E (it would revert
                                                ExpiryMustBeFuture), no roll.
          FINALIZE          head > E+G         E-quote pass if not yet done, then settle
                                                the E+G quote LAST (canonical mark),
                                                withdraw it, roll the next round.

        No per-step rescan: forward progress is driven by the receipt id
        (`_resolve_own_quote` verifies it once per submit); the bounded recover-scan runs
        exactly once per process, on the first step."""
        self._read_cache.clear()
        self._read_count = 0
        snapshot = self._read_snapshot()
        if snapshot is None:  # batch unavailable — sequential reads, as before
            market = self._market()
        else:
            market = snapshot
        base_t, quote_t, _mm, fee_bps, expiry, _created = market
        if base_t.lower() != self.base_token.lower() or quote_t.lower() != self.quote_token.lower():
            raise RuntimeError(f"[{self.symbol}] market {self.market_id} pair mismatch")
        block = self.w3.eth.block_number
        # Remembered for the drivers' adaptive loop period — a fast poll near expiry
        # must not cost an extra RPC per loop.
        self._last_head = block
        self._last_expiry = expiry

        if not self._booted:
            self._rescan_own_quotes(expiry)
            self._booted = True
            log.debug(
                "[%s] recover-scan: %s current / %s pending after %s reads",
                self.symbol, len(self._own_current), len(self._pending_own), self._read_count,
            )

        log.debug("[%s] block=%s expiry=%s (%s left)", self.symbol, block, expiry, expiry - block)

        window_end = expiry + self.settlement_window_blocks

        if block >= expiry:
            # ---- settlement window / finalize ----------------------------------------
            # NOTE: `>=` is deliberate — at head == E a restock with expiry E would
            # revert ExpiryMustBeFuture, so the boundary belongs to the window phase.
            # This also covers a stale marketId after a restart mid/late round: the
            # round's quotes are settled and a fresh market is rolled instead of crashing.
            self.watch_vetoes(block)
            # The sweep needs head > E: settleValidQuote reverts VerificationWindowActive
            # while block.number <= expiryBlock, and Monad bills the gas LIMIT of a
            # reverted tx. At head == E this step therefore only watches vetoes (and may
            # late-submit); the sweep runs on the next step, one block later.
            if not self._round_swept and block > expiry:
                self.settle_round(expiry, block)
                self._round_swept = True
            if block > window_end:
                self.settle_settlement_quote(expiry, block)  # LAST settle = canonical mark
                self.roll_round(expiry)
                self._own_current.clear()
                return
            if self._settlement_quote_id is None and block < window_end - 2:
                # Restart / missed step inside the window: submit the settlement quote
                # now (the -2 keeps its inclusion inside the window even if this send
                # is slow). The E-quotes are already settled, so it still settles last.
                self._settlement_quote_id = self.submit_quote(
                    window_end, "final settlement quote (late)"
                )
        else:
            # ---- normal quoting (head < E) -------------------------------------------
            self.watch_vetoes(block)
            active = self._active_own_quote(expiry)

            if expiry - block <= self.lead_blocks and self._settlement_quote_id is None:
                # Final quotes (D-06/FR-BOT-002): ONE feed read prices both, so a
                # settlement quote vetoed during the window falls back to an identical
                # canonical price. The settlement quote's expiry is E+G, so a delayed
                # inclusion can no longer revert ExpiryMustBeFuture (#22).
                try:
                    fair = self.feed.get(block)
                except FeedOutageError as e:
                    # Same contract as submit_quote: refuse to quote this tick
                    # (the loop retries) instead of surfacing as a generic
                    # "step failed" warning.
                    log.error("[%s] %s — NOT quoting this tick", self.symbol, e)
                    return
                if active is None:
                    self.submit_quote(expiry, "final trading quote", fair=fair)
                self._settlement_quote_id = self.submit_quote(
                    window_end, "final settlement quote", fair=fair, track_own=False
                )
            elif active is None or self.requote:
                self.submit_quote(expiry, "restock quote")

        log.debug(
            "[%s] step: %s RPC reads%s | tracked %s current + %s pending",
            self.symbol, self._read_count,
            " (batched)" if snapshot is not None else "",
            len(self._own_current), len(self._pending_own),
        )

    def _near_expiry(self) -> bool:
        """True while the head remembered by the last step() sits inside this pair's
        near-expiry band (E-10 .. E+3). The drivers use it to shorten their sleep so
        the final-quotes read (lead = 3 blocks ≈ 0.93 s) is not stepped over. Reads
        only values step() already fetched — zero extra RPC per loop."""
        if self._last_head is None or self._last_expiry is None:
            return False
        return (
            self._last_expiry - NEAR_EXPIRY_LOOKBACK_BLOCKS
            <= self._last_head
            <= self._last_expiry + NEAR_EXPIRY_LOOKAHEAD_BLOCKS
        )

    def run(self, once: bool = False) -> None:
        self._sync_nonce()
        self.ensure_approvals()

        while True:
            try:
                self.step()
            except Exception as e:  # transient RPC/proxy resets must not kill the bot
                log.warning("[%s] step failed (will retry): %s", self.symbol, e)
            if once:
                return
            time.sleep(NEAR_EXPIRY_POLL_SECONDS if self._near_expiry() else self.poll_seconds)


def run_all(bots: list[MarketMakerBot], once: bool = False) -> None:
    """Multi-pair driver: approve once per pair, then advance every pair one step
    per loop. Sends are serial (blocking receipts) and share the wallet nonce, so
    pairs cannot race each other. Per-pair failures are logged and retried.

    The loop period is adaptive: while ANY driven pair is inside its near-expiry
    band the sleep shortens, because one pair's near-expiry read must not wait for
    another pair's 5 s poll."""
    for b in bots:
        b.ensure_approvals()
    while True:
        for b in bots:
            try:
                b.step()
            except Exception as e:  # transient RPC/proxy resets must not kill the bot
                log.warning("[%s] step failed (will retry): %s", b.symbol, e)
        if once:
            return
        hot = any(b._near_expiry() for b in bots)
        time.sleep(NEAR_EXPIRY_POLL_SECONDS if hot else bots[0].poll_seconds)


def main() -> None:
    import sys

    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    # LOG_LEVEL=DEBUG exists for the `[latency]` / `step: N quote reads` probes. The
    # transport loggers are far chattier than the bot itself, so keep them quiet —
    # otherwise one RPC call costs a dozen lines and the log is unusable.
    if os.getenv("LOG_LEVEL", "INFO").upper() == "DEBUG":
        for noisy in ("web3", "urllib3"):
            logging.getLogger(noisy).setLevel(logging.WARNING)
    shared, pairs = resolve_pairs()
    context = BotContext(shared)
    bots = [MarketMakerBot(pair=p, context=context) for p in pairs]
    log.info(
        "market-maker bot %s | config=%s | %d pair(s): %s",
        context.address,
        "assets-file" if shared else "env",
        len(bots),
        ", ".join(f"{b.symbol}#{b.market_id}" for b in bots),
    )
    for b in bots:
        log.info(
            "[%s] marketId=%s pair %s/%s expiryHint=%s",
            b.symbol, b.market_id, b.base_token, b.quote_token, b.expiry_hint,
        )
    # Surface the table on every start: Monad charges the limit, so this line IS the
    # bot's per-send cost and should be re-checked whenever a limit looks suspicious.
    log.info(
        "gas limits (Monad bills the limit, not gasUsed): %s",
        " ".join(f"{k}={v:,}" for k, v in GAS.items()),
    )
    run_all(bots, once="--once" in sys.argv)


if __name__ == "__main__":
    main()
