"""IRMarket market-maker & settlement bot (Monad testnet).

Implements bot/prd.md FR-BOT-001..004 on the V0.9 Veto-Market design
(docs/sc-tech-spec.md §5.1/§8.2):

  - Quoting loop (FR-BOT-001): keep one ACTIVE quote per round at the tracked fair
    price (per-quote expiryBlock = the market's expiryBlock, D-13). Re-quote
    (restock) immediately whenever our quote is vetoed.
  - Settlement quote (FR-BOT-002): SETTLEMENT_QUOTE_LEAD_BLOCKS before expiry,
    read the fair price once and submit (a) a final TRADING quote (expiry E) and
    (b) the final SETTLEMENT quote (expiry E + SETTLEMENT_WINDOW_BLOCKS). (b) is
    submitted last, so it is the newest quote and therefore the round mark under
    lazy settlement (终价, D-06); its wider expiry is what keeps a delayed inclusion
    from reverting `ExpiryMustBeFuture` (dixia/IRMarket#22).
  - Auto-settle (FR-BOT-003): inside the settlement window [E, E+G] WITHDRAW the
    round's own quotes once (no settle tx — under lazy settlement the mark is
    fixed at read time and the withdraw backfills settledSlot, so the checkpoint
    would be ~73k gas of pure overhead per quote); after E+G checkpoint the
    settlement quote (that ONE checkpoint writes latestValidQuoteId, the walk's
    fallback floor) and withdraw it.
    Optionally create the next round's market and keep quoting (AUTO_CREATE_MARKET).
  - Veto watch (FR-BOT-004): detect vetoes on our quotes, withdraw the 2x
    other-side return, log provider P&L.

The bot is the market maker / provider: bilateral collateral quotes back every
trade, zero-sum (D-10); the 1% wrapper fee lands at market.marketMaker in HKD.
"""

import json
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


class SendBackoff(RuntimeError):
    """A send is skipped because the same call keeps reverting (see _send).

    Monad bills the gas LIMIT of a mined tx, so a revert-retry loop is a paid
    no-op: the Oct 21-22 incident burned ~270 MON that way (~21k reverted
    `withdrawProviderFunds` txs against the pre-lazy oracle). After
    REVERT_BACKOFF_AFTER consecutive reverts the call is skipped for an
    exponentially growing window instead of being retried every loop."""


class InsufficientBalance(RuntimeError):
    """A send is skipped because the wallet cannot fund it (see _send)."""


class LabelPoisoned(RuntimeError):
    """A call label is parked by the circuit breaker (see _send / _trip_breaker)."""


class BudgetExceeded(RuntimeError):
    """The rolling gas budget is spent, so nothing is sent (see _send)."""


class PreflightRevert(RuntimeError):
    """The transaction would revert, so it was not broadcast (see _send)."""

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
#   submit_quote      348,058      288,190     366,000  (lazy-settlement oracle, 2026-10-24)
#   settle             48,192       65,429      72,956
#   withdraw          123,206      123,206     150,000
#   create_market     172,678      198,542     218,789
#
# "live cold" = eth_estimateGas on the real oracle/wrapper (the production path);
# "mock/first" = the local Hardhat gas test and the first-of-round cold SSTOREs
# (fresh allowance slot, first settle per pair writing the checkpoint pointer). Adopted =
# the larger of live x1.05 and first-call x1.05, so both the production cost and
# test/gas.test.js's 120% headroom tripwire are satisfied. A test run with the bare
# live values reverted createMarket and one submitQuote out of gas — the tripwire
# was right.
#
# 2026-10-24 lazy-settlement cutover: the pre-lazy 346,000 submit_quote limit is NOT
# enough on the implicit-settlement oracle — every restock reverted out of gas at
# exactly the limit (eth_estimateGas measured 348,058 on the live stack, i.e. the old
# limit was ~0.6% short). The default is now 366,000 (live x1.05), so a fresh bot/.env
# needs no GAS_SUBMIT_QUOTE_WEI override.
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
    "submit_quote": 366_000,
    "settle": 72_956,
    "withdraw": 150_000,
    "create_market": 218_789,
}

# --- send guards (P0 of the #33 gas audit) ----------------------------------
# Monad bills the gas LIMIT of a mined tx, so a revert-retry loop is a paid
# no-op: that is what burned ~270 MON on 2026-10-21/22 (~21k reverted
# `withdrawProviderFunds` txs against the pre-lazy oracle, 0.0132 MON each).
# A label that reverts REVERT_BACKOFF_AFTER times in a row is skipped for an
# exponentially growing window, and a send the wallet cannot fund is skipped
# with a loud (throttled) warning instead of failing at the RPC every loop.
REVERT_BACKOFF_AFTER = int(os.getenv("REVERT_BACKOFF_AFTER", "2"))
REVERT_BACKOFF_BASE_S = float(os.getenv("REVERT_BACKOFF_BASE_S", "5"))
REVERT_BACKOFF_MAX_S = float(os.getenv("REVERT_BACKOFF_MAX_S", "300"))
MIN_BALANCE_TX_MULT = float(os.getenv("MIN_BALANCE_TX_MULT", "3"))
LOW_BALANCE_WARN_EVERY_S = float(os.getenv("LOW_BALANCE_WARN_EVERY_S", "300"))

# --- circuit breaker + spend budget -----------------------------------------
# The backoff above caps a revert loop at one attempt per REVERT_BACKOFF_MAX_S,
# which still leaks ~0.16 MON/h per stuck label (~1.1 MON/h with all 7 pairs
# stuck). These two hard stops close that:
#   * a label that keeps reverting past MAX_CONSECUTIVE_REVERTS is POISONED —
#     no more sends for POISON_COOLDOWN_S, logged once at ERROR;
#   * every send is charged to a rolling budget (gas x price, exact on Monad)
#     and nothing is sent once MAX_MON_PER_HOUR / MAX_MON_PER_DAY is spent, so
#     an unknown failure mode can only burn what the budget allows.
# Both live on the shared BotContext and are persisted to GUARD_STATE_FILE
# (empty string = don't persist) so a systemd restart cannot reset them — a
# crash loop is exactly the case that must not retry a doomed call every boot.
MAX_CONSECUTIVE_REVERTS = int(os.getenv("MAX_CONSECUTIVE_REVERTS", "5"))
POISON_COOLDOWN_S = float(os.getenv("POISON_COOLDOWN_S", "1800"))
MAX_MON_PER_HOUR = float(os.getenv("MAX_MON_PER_HOUR", "3"))
MAX_MON_PER_DAY = float(os.getenv("MAX_MON_PER_DAY", "20"))
SPEND_LOG_EVERY_S = float(os.getenv("SPEND_LOG_EVERY_S", "600"))
GUARD_STATE_FILE = os.getenv("GUARD_STATE_FILE", "bot/.guard-state.json")

# Pre-flight simulation: `eth_call` the exact transaction before broadcasting it.
# A permanent failure (the 2026-10-21 class: a withdraw the oracle can never
# accept) then costs one free RPC instead of a paid revert. It is skipped in the
# near-expiry band, where the extra round trip could push the final quote past
# its expiry window — that path is latency-critical and already guarded by the
# retry/backoff machinery.
PREFLIGHT_SIMULATE = os.getenv("PREFLIGHT_SIMULATE", "1") == "1"
PREFLIGHT_WARN_EVERY_S = float(os.getenv("PREFLIGHT_WARN_EVERY_S", "300"))


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

        # Wallet balance cache (TTL). `MarketMakerBot._send` consults it before
        # every send, so a shared TTL turns that into one RPC per `ttl` for the
        # whole process instead of one per send.
        self._balance_ts = 0.0
        self._balance_wei = 0
        # Spend ledger (ts, wei) over the last 24 h + circuit-breaker state. Both
        # are process-global because all pairs share one wallet, and both are
        # restored from GUARD_STATE_FILE so a restart cannot reset a stop.
        self._spend: list[tuple[float, int]] = []
        self._poisoned: dict[str, float] = {}
        self._load_guard_state()

    def balance_wei(self, ttl: float = 30.0) -> int:
        """Wallet balance, cached for `ttl` seconds across every pair's bot."""
        now = time.time()
        if self._balance_wei and now - self._balance_ts < ttl:
            return self._balance_wei
        self._balance_wei = self.w3.eth.get_balance(self.address)
        self._balance_ts = now
        return self._balance_wei

    # ------------------------------------------------ spend budget + breaker
    # Shared by every pair's bot (one wallet, one budget). Persisted so a
    # restart cannot wipe a stop that already tripped.

    def _load_guard_state(self) -> None:
        path = GUARD_STATE_FILE
        if not path:
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            return
        except Exception as e:  # corrupt file must never block the bot
            log.warning("guard state %s unreadable (%s) — starting clean", path, e)
            return
        now = time.time()
        self._spend = [
            (float(ts), int(wei))
            for ts, wei in data.get("spend", [])
            if now - float(ts) < 86400  # older than the day window: irrelevant
        ]
        self._poisoned = {
            str(label): float(until)
            for label, until in data.get("poisoned", {}).items()
            if float(until) > now
        }
        if self._spend or self._poisoned:
            log.info(
                "guard state restored: %d spend marks, %d poisoned label(s) (%s)",
                len(self._spend), len(self._poisoned), path,
            )

    def _save_guard_state(self) -> None:
        path = GUARD_STATE_FILE
        if not path:
            return
        try:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            tmp = f"{path}.tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "spend": [[ts, wei] for ts, wei in self._spend],
                        "poisoned": self._poisoned,
                    },
                    f,
                )
            os.replace(tmp, path)  # atomic: a crash mid-write cannot corrupt it
        except Exception as e:  # never let bookkeeping kill a send
            log.warning("could not persist guard state to %s: %s", path, e)

    def record_spend(self, wei: int) -> None:
        """Charge one tx to the rolling 24 h ledger (Monad bills the gas limit)."""
        if wei <= 0:
            return
        self._spend.append((time.time(), int(wei)))
        cutoff = time.time() - 86400
        self._spend = [(ts, w) for ts, w in self._spend if ts >= cutoff]
        self._save_guard_state()

    def spend_since(self, seconds: float) -> int:
        cutoff = time.time() - seconds
        return sum(w for ts, w in self._spend if ts >= cutoff)

    def is_poisoned(self, label: str) -> bool:
        until = self._poisoned.get(label)
        if until is None:
            return False
        if until <= time.time():
            self._poisoned.pop(label, None)
            self._save_guard_state()
            return False
        return True

    def poisoned_until(self, label: str) -> float:
        return self._poisoned.get(label, 0.0)

    def poison(self, label: str, seconds: float) -> float:
        until = time.time() + seconds
        self._poisoned[label] = until
        self._save_guard_state()
        return until


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
    pairs = _apply_skip_symbols(pairs)
    return shared, pairs


def _skip_symbols() -> set[str]:
    """Registry symbols this bot must not quote (`BOT_SKIP_SYMBOLS`, CSV)."""
    raw = os.getenv("BOT_SKIP_SYMBOLS", "")
    return {s.strip().upper() for s in raw.split(",") if s.strip()}


def _apply_skip_symbols(pairs: list["PairConfig"]) -> list["PairConfig"]:
    """Drop pairs whose registry symbol is in `BOT_SKIP_SYMBOLS`.

    Keeps the on-chain market and the registry intact — this only stops THIS bot
    from quoting it (e.g. retire NVDA from the demo set without a redeploy)."""
    skip = _skip_symbols()
    if not skip:
        return pairs
    kept = [p for p in pairs if (p.symbol or "").upper() not in skip]
    skipped = sorted((p.symbol or "") for p in pairs if (p.symbol or "").upper() in skip)
    if skipped:
        log.info("BOT_SKIP_SYMBOLS: not quoting %s", ", ".join(skipped))
    return kept


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
    pair = load_env_pair()
    if not _apply_skip_symbols([pair]):
        raise RuntimeError(
            f"BOT_SKIP_SYMBOLS excludes the only configured pair ({pair.symbol or pair.base_token})"
        )
    return {}, [pair]


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
        # Send guards (see _send / _note_revert): per-label revert backoff state and
        # the throttle for the low-balance warning.
        self._revert_state: dict[str, dict[str, Any]] = {}
        self._low_balance_warned = 0.0
        self._budget_warned = 0.0
        self._preflight_warned = 0.0
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

        Four guards keep a failing send from burning the wallet (Monad bills the gas
        LIMIT of a mined tx, so a mined revert costs the full limit):

          * **circuit breaker** — a label parked by `_note_revert` is not sent at
            all until its cool-down expires (`LabelPoisoned`).
          * **revert backoff** — a label that reverts REVERT_BACKOFF_AFTER times
            in a row is skipped for an exponentially growing window
            (5 s -> 300 s cap) instead of being retried every loop. This is what
            the Oct 21-22 incident needed: ~21k reverted `withdrawProviderFunds`
            txs, ~270 MON, all of them no-ops.
          * **spend budget** — every tx is charged to a rolling ledger; once
            MAX_MON_PER_HOUR / MAX_MON_PER_DAY is spent nothing is sent
            (`BudgetExceeded`), so an unknown failure mode can only burn the cap.
          * **balance floor** — if the wallet cannot fund MIN_BALANCE_TX_MULT x
            this tx, the send is skipped and a (throttled) warning names the
            address to fund, instead of failing at the RPC once per loop.

        Emits one DEBUG `[latency]` line per attempt with the three checkpoints the
        delivery-latency probe needs:
          - decision: the head read (`decision_block`) + wall clock used to decide
          - sent:     wall clock, and the head, right after send_raw_transaction returns
          - receipt:  wall clock + the block that actually included the tx

        `dt_send_s` isolates the bot's own processing from the network's inclusion
        delay (`post_send_gap_blocks`); `incl_gap_blocks` is the sum of the two.
        """
        # --- guard 0: circuit breaker ------------------------------------------
        if self.ctx.is_poisoned(label):
            raise LabelPoisoned(
                f"{label}: parked by the circuit breaker for another "
                f"{self.ctx.poisoned_until(label) - time.time():.0f}s "
                f"(reverted {MAX_CONSECUTIVE_REVERTS}+ times — not retryable)"
            )

        # --- guard 1: revert backoff -------------------------------------------
        state = self._revert_state.get(label)
        if state is not None and time.time() < state["until"]:
            raise SendBackoff(
                f"{label}: {state['fails']} consecutive reverts, "
                f"{state['until'] - time.time():.0f}s of backoff left "
                f"(~{state['wasted'] / E18:.4f} MON already burned on this call)"
            )

        price = self._gas_price()

        # --- guard 2: rolling spend budget -------------------------------------
        cost = int(gas * price)
        spent_h = self.ctx.spend_since(3600)
        spent_d = self.ctx.spend_since(86400)
        if (
            spent_h + cost > int(MAX_MON_PER_HOUR * E18)
            or spent_d + cost > int(MAX_MON_PER_DAY * E18)
        ):
            now = time.time()
            if now - self._budget_warned >= SPEND_LOG_EVERY_S:
                self._budget_warned = now
                log.error(
                    "%s: BUDGET EXCEEDED — spent %.2f MON in the last hour and %.2f MON "
                    "in the last day (caps %.1f/h, %.1f/day); NOT sending. "
                    "The bot resumes when the window rolls or the caps are raised.",
                    label, spent_h / E18, spent_d / E18, MAX_MON_PER_HOUR, MAX_MON_PER_DAY,
                )
            raise BudgetExceeded(
                f"{label}: budget exceeded (hour {spent_h / E18:.2f} + {cost / E18:.4f} MON)"
            )

        # --- guard 3: balance floor --------------------------------------------
        required = int(cost * MIN_BALANCE_TX_MULT)
        balance = self.ctx.balance_wei()
        if balance < required:
            now = time.time()
            if now - self._low_balance_warned >= LOW_BALANCE_WARN_EVERY_S:
                self._low_balance_warned = now
                log.warning(
                    "%s: wallet %s holds %.4f MON, this tx needs ~%.4f MON "
                    "(x%s head-room) — skipping until it is funded",
                    label, self.address, balance / E18, required / E18, MIN_BALANCE_TX_MULT,
                )
            raise InsufficientBalance(f"{label}: balance {balance} < required {required}")

        # --- guard 4: pre-flight simulation ------------------------------------
        if PREFLIGHT_SIMULATE and not self._near_expiry():
            try:
                fn.call({"from": self.address, "gas": gas, "gasPrice": price})
            except Exception as e:  # a revert here is caught for free
                reason = getattr(e, "message", None) or str(e)
                now = time.time()
                if now - self._preflight_warned >= PREFLIGHT_WARN_EVERY_S:
                    self._preflight_warned = now
                    log.warning(
                        "%s: pre-flight simulation reverted (%s) — NOT sending; "
                        "this would have been a paid revert", label, reason,
                    )
                else:
                    log.debug("%s: pre-flight still reverting (%s)", label, reason)
                raise PreflightRevert(f"{label}: simulation reverted: {reason}") from e

        for _ in range(5):
            if self._nonce is None:
                self._sync_nonce()
            tx = fn.build_transaction(
                {
                    "from": self.address,
                    "nonce": self._nonce,
                    "gas": gas,
                    "gasPrice": price,
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
                self.ctx.record_spend(cost)  # a revert is a paid no-op — charge it
                self._note_revert(label, cost, h.hex())
                raise RuntimeError(f"{label}: tx reverted {h.hex()}")
            self._nonce += 1
            self.ctx.record_spend(cost)
            self._revert_state.pop(label, None)  # healthy again — clear the backoff
            log.info("%s ok (gas %s) %s", label, receipt.gasUsed, h.hex())
            return receipt
        raise RuntimeError(f"{label}: nonce sync exhausted")

    def _note_revert(self, label: str, cost: int, tx_hash: str) -> None:
        """Record a reverted send, back off, and trip the breaker once it repeats.

        Logs the MON already spent on this label so a loop is visible in the log
        instead of only on the balance curve."""
        state = self._revert_state.setdefault(label, {"fails": 0, "wasted": 0, "until": 0.0})
        state["fails"] += 1
        state["wasted"] += cost
        if state["fails"] >= MAX_CONSECUTIVE_REVERTS:
            # The backoff alone still leaks one attempt per REVERT_BACKOFF_MAX_S;
            # stop paying for a call that clearly cannot succeed.
            until = self.ctx.poison(label, POISON_COOLDOWN_S)
            state["until"] = until
            log.error(
                "%s: reverted (tx %s) %d times in a row — CIRCUIT BREAKER: no sends for "
                "%.0f min (~%.4f MON spent on this call). Fix the cause; the backoff "
                "alone would keep paying one attempt per %ss.",
                label, tx_hash, state["fails"], POISON_COOLDOWN_S / 60,
                state["wasted"] / E18, REVERT_BACKOFF_MAX_S,
            )
            # The breaker supersedes the backoff: drop the episode so the label
            # starts clean if it is ever resumed (after the cool-down).
            self._revert_state.pop(label, None)
            return
        if state["fails"] < REVERT_BACKOFF_AFTER:
            log.warning(
                "%s: reverted (tx %s) — attempt %d, ~%.4f MON spent on this call so far",
                label, tx_hash, state["fails"], state["wasted"] / E18,
            )
            return
        backoff = min(
            REVERT_BACKOFF_BASE_S * (2 ** (state["fails"] - REVERT_BACKOFF_AFTER)),
            REVERT_BACKOFF_MAX_S,
        )
        state["until"] = time.time() + backoff
        log.warning(
            "%s: reverted (tx %s) — attempt %d, ~%.4f MON spent on this call; "
            "backing off %.0fs (fix the cause, this is not retryable)",
            label, tx_hash, state["fails"], state["wasted"] / E18, backoff,
        )

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
        didn't land when it was settled — a pure cleanup: under lazy settlement the mark
        is derived from status + block height, so withdrawing cannot un-canonicalize it.

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
                # cleanup: withdrawing never changes the read-time canonical mark.
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
        """After expiry: withdraw OUR OWN quotes for THIS round. No settle tx.

        Under upstream lazy settlement the canonical price is ALREADY fixed the
        instant block.number passes expiryBlock — getLatestPrice derives it at
        read time (walks the pair's list, cap 8, with the settleValidQuote
        pointer as a floor), with NO settle tx. So this pass deliberately does
        NOT checkpoint:

          * the checkpoint is not what makes a quote canonical (the maturity
            block does), and it can no longer fix or rewind the mark;
          * `withdrawProviderFunds` on a matured ACTIVE quote pays exactly what
            a settled quote pays and backfills `settledSlot = expiryBlock`
            (Monoracle.sol), so the quote stays a canonical candidate in the
            walk — the checkpoint buys nothing the withdraw does not already;
          * Monad bills the gas LIMIT, so the checkpoint cost ~73k gas per quote
            per round for zero benefit: ~0.05 MON/round across 7 pairs.

        The ONE checkpoint that still matters is the round's settlement quote in
        `settle_settlement_quote`: it writes `latestValidQuoteId[pair]`, the
        walk's fallback floor for the (rare) round that piles up more than
        MAX_PRICE_WALK = 8 non-canonical quotes — every user trade vetoes one and
        a vetoed quote never becomes canonical.

        That also retires the old oldest-first settle ordering (we used to settle
        the highest id last so it became the mark) and the "never settle an older
        round late" workaround: nothing here can move the price at all.

        Bounded two ways:
          * only OUR ids (`_own_current | _pending_own`) — the old `range(1, nextQuoteId)`
            sweep walked the whole LEDGER (~150 ids and growing, since the oracle is
            shared across pairs/processes), which is what made a step take minutes;
          * quoting-match is preserved exactly (expiryBlock == round_expiry), so a stale
            run still cannot touch the live round's quotes (per-round attribution,
            AGENTS.md). A leftover ACTIVE quote from a different round is simply skipped.

        The same filter excludes THIS round's final settlement quote (expiry E+G ≠ E),
        and it is never in the id sets either — `settle_settlement_quote` owns it and
        checkpoints it after this pass."""
        withdrawn_ids = []
        if decision_block is None:
            decision_block = self.w3.eth.block_number
        decision_ts = time.time()
        # sorted only for stable logs/iteration; settle order is irrelevant to the mark now
        for qid in sorted(self._own_current | self._pending_own):
            q = self._quote(qid)  # fresh read: every branch here gates a send
            if q["expiryBlock"] != round_expiry:
                # belongs to a different round — per-round attribution: settle_round only
                # handles the round it is called for, so a stale run cannot checkpoint the
                # live round's quotes. watch_vetoes still owns the pending (withdrawable)
                # leftovers of older rounds.
                continue
            if q["status"] == ACTIVE:
                # The window has passed, so the quote is withdrawable under implicit
                # settlement (block.number > expiryBlock — a settle tx is NOT what
                # unlocks it, and the withdraw backfills settledSlot so the quote stays
                # a canonical candidate). Withdraw in the same pass rather than
                # re-reading, but keep the id in the sets until the send succeeded: if
                # the withdraw tx fails, the next step's own settle_round (id still
                # stored) runs the elif branch, so no escrow is ever stranded.
                self._send(
                    self.oracle.functions.withdrawProviderFunds(qid), GAS["withdraw"], f"withdraw q{qid}",
                    decision_block=decision_block, decision_ts=decision_ts,
                )
                withdrawn_ids.append(qid)
            elif q["status"] in (SETTLED_VALID, VETOED_UNDERPRICED, VETOED_OVERPRICED):
                self._send(
                    self.oracle.functions.withdrawProviderFunds(qid), GAS["withdraw"], f"withdraw q{qid}",
                    decision_block=decision_block, decision_ts=decision_ts,
                )
            self._own_current.discard(qid)
            self._pending_own.discard(qid)
        price = self.oracle.functions.getLatestPrice(self.base_token, self.quote_token).call()
        log.info(
            "[%s] round finalized: canonical price=%s (read-time; %s own quotes withdrawn)",
            self.symbol, price[0], len(withdrawn_ids),
        )

    def settle_settlement_quote(
        self, round_expiry: int, decision_block: Optional[int] = None
    ) -> None:
        """Checkpoint THIS round's final settlement quote (expiry E+G) — the sibling of
        `settle_round`. It still runs after it, but the order is no longer load-bearing:
        under lazy settlement the mark is derived at read time, and a checkpoint cannot
        rewind it. The settlement quote is submitted last, so it is the newest quote of
        the round and the walk returns it once its window passes.

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
        last_spend = [0.0]

        while True:
            try:
                self.step()
            except GUARD_SKIPS as e:
                # Already logged once (WARNING/ERROR) by the guard that tripped;
                # repeating it every loop would bury the real cause in noise.
                log.debug("[%s] step skipped by a send guard: %s", self.symbol, e)
            except Exception as e:  # transient RPC/proxy resets must not kill the bot
                log.warning("[%s] step failed (will retry): %s", self.symbol, e)
            _log_spend([self], last_spend)
            if once:
                return
            time.sleep(NEAR_EXPIRY_POLL_SECONDS if self._near_expiry() else self.poll_seconds)


GUARD_SKIPS = (
    SendBackoff, LabelPoisoned, BudgetExceeded, InsufficientBalance, PreflightRevert,
)


def _log_spend(bots: list["MarketMakerBot"], last: list[float]) -> None:
    """Hourly-ish spend meter: makes the burn visible before it matters.

    One INFO line every SPEND_LOG_EVERY_S summing the shared ledger, with the
    balance and a crude runway estimate (1h spend -> hours left). This is the
    line the Oct 21-22 incident never had."""
    now = time.time()
    if not bots or now - last[0] < SPEND_LOG_EVERY_S:
        return
    last[0] = now
    ctx = bots[0].ctx
    hour = ctx.spend_since(3600) / E18
    day = ctx.spend_since(86400) / E18
    balance = ctx.balance_wei() / E18
    runway = (balance / hour) if hour > 0 else float("inf")
    log.info(
        "spend: %.3f MON last hour, %.3f MON last day (caps %.1f/h, %.1f/day) | "
        "balance %.3f MON | runway ~%s h at the current rate",
        hour, day, MAX_MON_PER_HOUR, MAX_MON_PER_DAY, balance,
        f"{runway:.1f}" if runway != float("inf") else "inf",
    )


def run_all(bots: list[MarketMakerBot], once: bool = False) -> None:
    """Multi-pair driver: approve once per pair, then advance every pair one step
    per loop. Sends are serial (blocking receipts) and share the wallet nonce, so
    pairs cannot race each other. Per-pair failures are logged and retried.

    The loop period is adaptive: while ANY driven pair is inside its near-expiry
    band the sleep shortens, because one pair's near-expiry read must not wait for
    another pair's 5 s poll."""
    for b in bots:
        b.ensure_approvals()
    last_spend = [0.0]
    while True:
        for b in bots:
            try:
                b.step()
            except GUARD_SKIPS as e:
                # Already logged once (WARNING/ERROR) by the guard that tripped;
                # repeating it every loop would bury the real cause in noise.
                log.debug("[%s] step skipped by a send guard: %s", b.symbol, e)
            except Exception as e:  # transient RPC/proxy resets must not kill the bot
                log.warning("[%s] step failed (will retry): %s", b.symbol, e)
        _log_spend(bots, last_spend)
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
