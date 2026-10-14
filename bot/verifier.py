"""IRMarket market-maker & settlement bot (Monad testnet).

Implements bot/prd.md FR-BOT-001..004 on the V0.9 Veto-Market design
(docs/sc-tech-spec.md §5.1/§8.2):

  - Quoting loop (FR-BOT-001): keep one ACTIVE quote per round at the tracked fair
    price (per-quote expiryBlock = the market's expiryBlock, D-13). Re-quote
    (restock) immediately whenever our quote is vetoed.
  - Settlement quote (FR-BOT-002): SETTLEMENT_QUOTE_LEAD_BLOCKS before expiry,
    submit one final quote at the current fair price so it settles LAST as the
    round mark (终价, D-06).
  - Auto-settle (FR-BOT-003): after expiry, settle ALL ACTIVE quotes of the pair
    oldest-first (final quote last = canonical price), then withdraw our funds.
    Optionally create the next round's market and keep quoting (AUTO_CREATE_MARKET).
  - Veto watch (FR-BOT-004): detect vetoes on our quotes, withdraw the 2x
    other-side return, log provider P&L.

The bot is the market maker / provider: bilateral collateral quotes back every
trade, zero-sum (D-10); the 1% wrapper fee lands at market.marketMaker in HKD.
"""

import logging
import os
import random
import time
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv
from web3 import Web3

load_dotenv()

log = logging.getLogger("irmarket-bot")

E18 = 10**18

# QuoteStatus enum (Monoracle)
ACTIVE = 0
VETOED_UNDERPRICED = 1
VETOED_OVERPRICED = 2
SETTLED_VALID = 3
SETTLED_WITHDRAWN = 4

# Fixed gas limits (Monad bills by gas LIMIT — sc-tech-spec §7). Skip estimateGas.
GAS = {
    "approve": 100_000,
    "submit_quote": 600_000,
    "settle": 150_000,
    "withdraw": 200_000,
    "create_market": 2_000_000,
}


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
    ) -> None:
        self.base_token = base_token
        self.quote_token = quote_token
        self.fair_price = int(fair_price)
        self.market_id = int(market_id)
        self.symbol = symbol or base_token[:10]
        self.expiry_block = int(expiry_block) if expiry_block is not None else None


class BotContext:
    """Chain-level resources shared by every pair's bot instance: the provider,
    wallet, oracle/market contracts, and the wallet's nonce cursor.

    Sharing the nonce cursor keeps the sequential per-pair sends from racing
    each other when several pairs are driven in one process."""

    def __init__(self, shared: Optional[dict] = None) -> None:
        shared = shared or {}
        rpc = os.getenv("RPC_HTTP_URL", "https://testnet-rpc.monad.xyz")
        self.w3 = Web3(Web3.HTTPProvider(rpc))
        if not self.w3.is_connected():
            raise RuntimeError(f"RPC unreachable: {rpc}")

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
    """Pick multi-asset vs legacy single-pair config. Multi-asset wins when the
    file exists and lists at least one asset; otherwise fall back to env."""
    loaded = load_asset_configs(explicit)
    if loaded is not None:
        return loaded
    return {}, [load_env_pair()]


class PriceFeed:
    """Fair-price source. Demo: a bounded random walk around the configured base price
    so the quoted (canonical) price visibly moves. Swap `get()` for a real feed in prod.
    Jitter band is `PRICE_JITTER_BPS` (default 300 = ±3%), clamped to ±20% of the base."""

    def __init__(self, fair_price: int):
        self.fair = int(fair_price)
        self.current = int(fair_price)
        self.jitter = int(os.getenv("PRICE_JITTER_BPS", "300")) / 10_000

    def get(self, _block: int) -> int:
        if self.jitter > 0:
            self.current = int(self.current * (1 + random.uniform(-self.jitter, self.jitter)))
            lo, hi = int(self.fair * 0.8), int(self.fair * 1.2)
            self.current = max(lo, min(hi, self.current))
        return self.current


class MarketMakerBot:
    """Market maker for ONE pair. Chain resources come from a shared
    `BotContext`; pair-specific state (tokens, market id, own quotes, withdrawn
    set, final-quote flag) stays on the instance so pairs never interfere.

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
        self.feed = PriceFeed(pair.fair_price)
        self.expiry_hint = pair.expiry_block

        self.market_id = pair.market_id
        self.lead_blocks = int(os.getenv("SETTLEMENT_QUOTE_LEAD_BLOCKS", "2"))
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
        self._final_submitted = False
        self._withdrawn: set[int] = set()
        self._own_quotes: set[int] = set()

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

    def _send(self, fn: Any, gas: int, label: str) -> Any:
        """Sign + send a tx with manual nonce tracking; retry on nonce races."""
        for _ in range(5):
            if self._nonce is None:
                self._sync_nonce()
            tx = fn.build_transaction(
                {"from": self.address, "nonce": self._nonce, "gas": gas, "gasPrice": self._gas_price()}
            )
            signed = self.w3.eth.account.sign_transaction(tx, self.pk)
            try:
                h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
            except Exception as e:  # web3 v7 raises Web3RPCError for nonce races
                if "nonce" in str(e).lower():
                    self._sync_nonce()
                    continue
                raise
            receipt = self.w3.eth.wait_for_transaction_receipt(h, timeout=120)
            if receipt.status != 1:
                raise RuntimeError(f"{label}: tx reverted {h.hex()}")
            self._nonce += 1
            log.info("%s ok (gas %s) %s", label, receipt.gasUsed, h.hex())
            return receipt
        raise RuntimeError(f"{label}: nonce sync exhausted")

    def _market(self) -> tuple:
        return self.market.functions.markets(self.market_id).call()

    # Field order comes from the deployed MonoracleWindowed ABI (abi/Monoracle.abi.json):
    # provider, baseToken, quoteToken, baseAmount, quoteAmount, price, startSlot,
    # settledSlot, expiryBlock, status. Index by NAME so a field-order change cannot
    # silently shift `expiryBlock` (the upstream ABI orders startSlot/expiryBlock/settledSlot
    # differently, which is what made positional indexing wrong here).
    _QUOTE_FIELDS = (
        "provider", "baseToken", "quoteToken", "baseAmount", "quoteAmount",
        "price", "startSlot", "settledSlot", "expiryBlock", "status",
    )

    def _quote(self, qid: int) -> dict:
        return dict(zip(self._QUOTE_FIELDS, self.oracle.functions.quotes(qid).call()))

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

    def _rescan_own_quotes(self) -> None:
        """Index quotes we are the provider of for THIS pair by scanning the quote
        ledger directly (no get_logs — the public RPC 413s on wide log ranges). The
        oracle is shared across pairs, so filter by our tokens: each instance keeps
        its own `_own_quotes` and never acts on another pair's quotes."""
        next_id = self.oracle.functions.nextQuoteId().call()
        consecutive_strangers = 0
        for qid in range(next_id - 1, 0, -1):
            q = self._quote(qid)
            if q["provider"].lower() == self.address.lower():
                consecutive_strangers = 0
                if q["baseToken"].lower() == self.base_token.lower() and q["quoteToken"].lower() == self.quote_token.lower():
                    self._own_quotes.add(qid)
            else:
                consecutive_strangers += 1
                if consecutive_strangers >= 20:
                    break

    def _active_own_quote(self, round_expiry: int) -> Optional[int]:
        """Our newest ACTIVE quote for THIS round (expiryBlock == market expiry), if any."""
        active = None
        for qid in self._own_quotes:
            q = self._quote(qid)
            if q["baseToken"].lower() != self.base_token.lower() or q["quoteToken"].lower() != self.quote_token.lower():
                continue
            if q["expiryBlock"] != round_expiry:
                continue  # belongs to a different round
            if q["status"] == ACTIVE:
                active = qid if active is None or qid > active else active
        return active

    def submit_quote(self, expiry_block: int, label: str) -> int:
        fair = self.feed.get(self.w3.eth.block_number)
        quote_amount = self.quote_base * fair // E18
        qid_before = self.oracle.functions.nextQuoteId().call()
        receipt = self._send(
            self.oracle.functions.submitQuote(
                self.base_token, self.quote_token, self.quote_base, quote_amount, expiry_block
            ),
            GAS["submit_quote"],
            label,
        )
        # Parse the event from logs emitted by the oracle only (avoids web3's
        # "MismatchedABI" warnings for ERC20 Transfer logs in the same tx).
        qid = self._oracle_event_id(receipt, "QuoteSubmitted")
        if qid is None:
            qid = qid_before
        self._own_quotes.add(qid)
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

    def watch_vetoes(self) -> None:
        """FR-BOT-004: withdraw the 2x return on our vetoed quotes, log P&L."""
        for qid in sorted(self._own_quotes):
            if qid in self._withdrawn:
                continue
            q = self._quote(qid)
            if q["status"] not in (VETOED_UNDERPRICED, VETOED_OVERPRICED):
                continue
            base_amt, quote_amt = q["baseAmount"], q["quoteAmount"]
            fair = self.feed.get(self.w3.eth.block_number)
            if q["status"] == VETOED_UNDERPRICED:
                # we keep 2x quote, lose base
                pnl_hkd = quote_amt - base_amt * fair // E18
                side = "UNDERPRICED (trader went LONG)"
            else:
                # we keep 2x base, lose quote
                pnl_hkd = base_amt * fair // E18 - quote_amt
                side = "OVERPRICED (trader went SHORT)"
            self._send(self.oracle.functions.withdrawProviderFunds(qid), GAS["withdraw"], f"withdraw q{qid}")
            self._withdrawn.add(qid)
            log.warning(
                "[%s] VETO q%s %s | pnl≈%s HKD (base %s, quote %s, fair %s)",
                self.symbol, qid, side, pnl_hkd / E18, base_amt / E18, quote_amt / E18, fair,
            )

    def settle_round(self, round_expiry: int) -> None:
        """After expiry: settle THIS round's ACTIVE quotes oldest-first; final quote last
        becomes the canonical 终价 (D-06). Then withdraw our own funds.
        Quotes are matched by the round's expiryBlock so a stale run never touches the
        live round's quotes."""
        next_id = self.oracle.functions.nextQuoteId().call()
        settled_ids = []
        for qid in range(1, next_id):
            q = self._quote(qid)
            if q["baseToken"].lower() != self.base_token.lower() or q["quoteToken"].lower() != self.quote_token.lower():
                continue
            if q["expiryBlock"] != round_expiry:
                continue  # belongs to a different round
            if q["status"] == ACTIVE:
                self._send(self.oracle.functions.settleValidQuote(qid), GAS["settle"], f"settle q{qid}")
                settled_ids.append(qid)
        for qid in sorted(self._own_quotes - self._withdrawn):
            q = self._quote(qid)
            if q["expiryBlock"] != round_expiry:
                continue
            if q["status"] in (SETTLED_VALID, VETOED_UNDERPRICED, VETOED_OVERPRICED):
                self._send(self.oracle.functions.withdrawProviderFunds(qid), GAS["withdraw"], f"withdraw q{qid}")
                self._withdrawn.add(qid)
        price = self.oracle.functions.getLatestPrice(self.base_token, self.quote_token).call()
        log.info(
            "[%s] round settled: canonical price=%s (settled %s quotes)",
            self.symbol, price[0], len(settled_ids),
        )

    def roll_round(self, current_expiry: int) -> int:
        """Create the next round's market (bot as marketMaker) and continue quoting."""
        if not self.auto_create:
            log.warning(
                "[%s] round %s expired — AUTO_CREATE_MARKET off, exiting round",
                self.symbol, self.market_id,
            )
            return self.market_id
        block = self.w3.eth.block_number
        new_expiry = block + self.round_blocks
        fee_bps = int(os.getenv("FEE_BPS", "100"))
        receipt = self._send(
            self.market.functions.createMarket(
                self.base_token, self.quote_token, self.address, new_expiry, fee_bps
            ),
            GAS["create_market"],
            "createMarket (next round)",
        )
        mid = self._market_created_id(receipt)
        if mid is None:
            raise RuntimeError("createMarket: MarketCreated event not found")
        log.warning(
            "[%s] NEXT ROUND: marketId=%s expiryBlock=%s (was %s) — update web/.env.local NEXT_PUBLIC_DEMO_MARKET_ID=%s",
            self.symbol, mid, new_expiry, current_expiry, mid,
        )
        self.market_id = mid
        self._final_submitted = False
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
        from `run` so the multi-pair driver can advance every pair in turn."""
        self._rescan_own_quotes()
        block = self.w3.eth.block_number
        market = self._market()
        base_t, quote_t, _mm, fee_bps, expiry, _created = market
        if base_t.lower() != self.base_token.lower() or quote_t.lower() != self.quote_token.lower():
            raise RuntimeError(f"[{self.symbol}] market {self.market_id} pair mismatch")

        log.debug("[%s] block=%s expiry=%s (%s left)", self.symbol, block, expiry, expiry - block)

        if block > expiry:
            # Stale marketId (e.g. after a restart mid/late round): settle the old
            # round's quotes and roll to a fresh one instead of crashing.
            self.settle_round(expiry)
            self.roll_round(expiry)
            return

        # veto watch + restock
        self.watch_vetoes()
        active = self._active_own_quote(expiry)

        if expiry - block <= self.lead_blocks and not self._final_submitted:
            # final settlement quote = mark (D-06/FR-BOT-002)
            self.submit_quote(expiry, "final settlement quote")
            self._final_submitted = True
        elif active is None or self.requote:
            self.submit_quote(expiry, "restock quote")

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
            time.sleep(self.poll_seconds)


def run_all(bots: list[MarketMakerBot], once: bool = False) -> None:
    """Multi-pair driver: approve once per pair, then advance every pair one step
    per loop. Sends are serial (blocking receipts) and share the wallet nonce, so
    pairs cannot race each other. Per-pair failures are logged and retried."""
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
        time.sleep(bots[0].poll_seconds)


def main() -> None:
    import sys

    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
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
    run_all(bots, once="--once" in sys.argv)


if __name__ == "__main__":
    main()
