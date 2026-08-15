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
import time
from typing import Any, Optional

from dotenv import load_dotenv
from web3 import Web3

load_dotenv()

log = logging.getLogger("irmarket-bot")

E18 = 10**18

# QuoteStatus enum (MonoracleWindowed)
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


class PriceFeed:
    """Fair-price source. Demo: static env price (B5 — live 06658.HK feed to be
    pinned at dev time; swap `get()` for the real fetch here)."""

    def __init__(self, fair_price: int):
        self.fair = int(fair_price)

    def get(self, _block: int) -> int:
        return self.fair


class MarketMakerBot:
    def __init__(self) -> None:
        rpc = os.getenv("RPC_HTTP_URL", "https://testnet-rpc.monad.xyz")
        self.w3 = Web3(Web3.HTTPProvider(rpc))
        if not self.w3.is_connected():
            raise RuntimeError(f"RPC unreachable: {rpc}")

        self.pk = os.environ["PRIVATE_KEY"]
        self.account = self.w3.eth.account.from_key(self.pk)
        self.address = self.account.address

        self.oracle_addr = Web3.to_checksum_address(os.environ["ORACLE_ADDRESS"])
        self.market_addr = Web3.to_checksum_address(os.environ["MARKET_ADDRESS"])
        self.oracle = self.w3.eth.contract(
            address=self.oracle_addr, abi=_load_abi("abi/Monoracle.abi.json")
        )
        self.market = self.w3.eth.contract(
            address=self.market_addr,
            abi=_load_abi("artifacts/contracts/IRMarket.sol/IRMarket.json"),
        )

        # Monitored pair: BASE_TOKEN,QUOTE_TOKEN,FAIR_PRICE (1e18 FP)
        parts = os.environ["MONITORED_PAIRS"].split(",")
        self.base_token = Web3.to_checksum_address(parts[0].strip())
        self.quote_token = Web3.to_checksum_address(parts[1].strip())
        self.feed = PriceFeed(int(parts[2].strip()))

        self.market_id = int(os.getenv("MARKET_ID", "0"))
        self.lead_blocks = int(os.getenv("SETTLEMENT_QUOTE_LEAD_BLOCKS", "2"))
        self.round_blocks = int(os.getenv("ROUND_BLOCKS", "6000"))  # ~30 min @300ms
        self.auto_create = os.getenv("AUTO_CREATE_MARKET", "1") == "1"
        self.poll_seconds = float(os.getenv("QUOTE_INTERVAL_SECONDS", "5"))

        base_amount = int(os.getenv("QUOTE_BASE_AMOUNT", str(1 * E18)))
        self.quote_base = base_amount
        self.gas_price_cap = int(os.getenv("GAS_PRICE_CAP_WEI", "0"))  # 0 = use chain

        self._nonce: Optional[int] = None
        self._final_submitted = False
        self._withdrawn: set[int] = set()
        self._own_quotes: set[int] = set()

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

    def _quote(self, qid: int) -> tuple:
        return self.oracle.functions.quotes(qid).call()

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
        """Index quotes we are the provider of by scanning the quote ledger directly
        (no get_logs — the public RPC 413s on wide log ranges). Our oracle instance
        only carries this bot's quotes, so a bounded descending scan is cheap and
        survives restarts mid-round."""
        next_id = self.oracle.functions.nextQuoteId().call()
        consecutive_strangers = 0
        for qid in range(next_id - 1, 0, -1):
            q = self._quote(qid)
            if q[0].lower() == self.address.lower():
                self._own_quotes.add(qid)
                consecutive_strangers = 0
            else:
                consecutive_strangers += 1
                if consecutive_strangers >= 20:
                    break

    def _active_own_quote(self, round_expiry: int) -> Optional[int]:
        """Our newest ACTIVE quote for THIS round (expiryBlock == market expiry), if any."""
        active = None
        for qid in self._own_quotes:
            q = self._quote(qid)
            if q[1].lower() != self.base_token.lower() or q[2].lower() != self.quote_token.lower():
                continue
            if q[8] != round_expiry:
                continue  # belongs to a different round
            if q[9] == ACTIVE:
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
            "quoted id=%s base=%s quote=%s price=%s (fair=%s)",
            qid, self.quote_base / E18, quote_amount / E18, quote_amount * E18 // self.quote_base, fair,
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
            if q[9] not in (VETOED_UNDERPRICED, VETOED_OVERPRICED):
                continue
            base_amt, quote_amt = q[3], q[4]
            fair = self.feed.get(self.w3.eth.block_number)
            if q[9] == VETOED_UNDERPRICED:
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
                "VETO q%s %s | pnl≈%s HKD (base %s, quote %s, fair %s)",
                qid, side, pnl_hkd / E18, base_amt / E18, quote_amt / E18, fair,
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
            if q[1].lower() != self.base_token.lower() or q[2].lower() != self.quote_token.lower():
                continue
            if q[8] != round_expiry:
                continue  # belongs to a different round
            if q[9] == ACTIVE:
                self._send(self.oracle.functions.settleValidQuote(qid), GAS["settle"], f"settle q{qid}")
                settled_ids.append(qid)
        for qid in sorted(self._own_quotes - self._withdrawn):
            q = self._quote(qid)
            if q[8] != round_expiry:
                continue
            if q[9] in (SETTLED_VALID, VETOED_UNDERPRICED, VETOED_OVERPRICED):
                self._send(self.oracle.functions.withdrawProviderFunds(qid), GAS["withdraw"], f"withdraw q{qid}")
                self._withdrawn.add(qid)
        price = self.oracle.functions.getLatestPrice(self.base_token, self.quote_token).call()
        log.info("round settled: canonical price=%s (settled %s quotes)", price[0], len(settled_ids))

    def roll_round(self, current_expiry: int) -> int:
        """Create the next round's market (bot as marketMaker) and continue quoting."""
        if not self.auto_create:
            log.warning("round %s expired — AUTO_CREATE_MARKET off, exiting round", self.market_id)
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
            "NEXT ROUND: marketId=%s expiryBlock=%s (was %s) — update web/.env.local NEXT_PUBLIC_DEMO_MARKET_ID=%s",
            mid, new_expiry, current_expiry, mid,
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

    def run(self, once: bool = False) -> None:
        self._sync_nonce()
        self.ensure_approvals()

        while True:
            self._rescan_own_quotes()
            block = self.w3.eth.block_number
            market = self._market()
            base_t, quote_t, _mm, fee_bps, expiry, _created = market
            if base_t.lower() != self.base_token.lower() or quote_t.lower() != self.quote_token.lower():
                raise RuntimeError(f"market {self.market_id} pair mismatch")

            log.debug("block=%s expiry=%s (%s left)", block, expiry, expiry - block)

            if block > expiry:
                # Stale marketId (e.g. after a restart mid/late round): settle the old
                # round's quotes and roll to a fresh one instead of crashing.
                self.settle_round(expiry)
                self.roll_round(expiry)
                if once:
                    return
                time.sleep(self.poll_seconds)
                continue

            # veto watch + restock
            self.watch_vetoes()
            active = self._active_own_quote(expiry)

            if expiry - block <= self.lead_blocks and not self._final_submitted:
                # final settlement quote = mark (D-06/FR-BOT-002)
                self.submit_quote(expiry, "final settlement quote")
                self._final_submitted = True
            elif active is None:
                self.submit_quote(expiry, "restock quote")

            if once:
                return
            time.sleep(self.poll_seconds)


def main() -> None:
    import sys

    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    bot = MarketMakerBot()
    log.info("market-maker bot %s | marketId=%s | pair %s/%s", bot.address, bot.market_id, bot.base_token, bot.quote_token)
    once = "--once" in sys.argv
    bot.run(once=once)


if __name__ == "__main__":
    main()
