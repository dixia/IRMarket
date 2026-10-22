"""Unit tests for the one-market-per-pair round model in bot/verifier.py.

No network: the bot object is built via `object.__new__` (skipping BotContext), the
oracle is a stub, and `_send` records calls instead of broadcasting. Covers
docs/sc-tech-spec.md §5 as merged with the settlement-window /
bounded-bookkeeping code on `main` (round = QUOTE expiry; the bot never creates
markets in its loop).

Run:  py -m unittest discover -s bot/tests -v
"""

import sys
import unittest
from pathlib import Path

WAD = 10**18

BOT_DIR = str(Path(__file__).resolve().parent.parent)
if BOT_DIR not in sys.path:
    sys.path.insert(0, BOT_DIR)

import verifier  # noqa: E402

FIELDS = verifier.MarketMakerBot._QUOTE_FIELDS

# QuoteStatus (mirror of verifier.py)
ACTIVE = 0
VETOED_UNDERPRICED = 1
VETOED_OVERPRICED = 2
SETTLED_VALID = 3

BASE = "0x" + "11" * 20
QUOTE = "0x" + "22" * 20
OTHER_BASE = "0x" + "33" * 20
BOT = "0x" + "44" * 20
STRANGER = "0x" + "55" * 20


def quote_dict(provider=BOT, base=BASE, quote_tok=QUOTE, expiry=0, status=ACTIVE, price=100 * WAD):
    return {
        "provider": provider,
        "baseToken": base,
        "quoteToken": quote_tok,
        "baseAmount": WAD,
        "quoteAmount": price,
        "price": price,
        "startSlot": 0,
        "expiryBlock": expiry,
        "settledSlot": 0,
        "status": status,
    }


def to_tuple(q):
    return tuple(q[f] for f in FIELDS)


class _Fn:
    """Builder for oracle.functions.<name>(...).call() nodes."""

    def __init__(self, fn):
        self._fn = fn

    def call(self):
        return self._fn()


class _Fn2:
    def __init__(self, fn):
        self._fn = fn

    def build_transaction(self, tx):
        return tx


class _StubW3:
    def __init__(self, block):
        self.eth = type("Eth", (), {"block_number": block})()


class make_bot:
    """Construct a bare MarketMakerBot (no BotContext/RPC) with a stub oracle."""

    def __init__(self, ledger=None, block=1000):
        self.bot = object.__new__(verifier.MarketMakerBot)
        b = self.bot
        b.symbol = "T"
        b.base_token = BASE
        b.quote_token = QUOTE
        b.oracle_addr = "0x" + "66" * 20
        b.market_addr = "0x" + "77" * 20
        b.address = BOT
        b.round_blocks = 3000
        b.lead_blocks = 2
        b.settlement_window_blocks = 60
        b.auto_create = False
        b.requote = False
        b.market_id = 1
        # Merged (main) bookkeeping: bounded sets + per-round state + read cache.
        b._own_current = set()
        b._pending_own = set()
        b._settlement_quote_id = None
        b._round_swept = False
        b._round_expiry = None
        b._read_cache = {}
        b._read_count = 0
        b._booted = False
        b._last_head = None
        b._last_expiry = None
        b.sends = []
        b.w3 = _StubW3(block)

        def _send(fn, gas, label, decision_block=None, decision_ts=None):
            b.sends.append(label)
            return None

        b._send = _send

        class _Feed:
            def get(self, block):
                return 100 * WAD

        b.feed = _Feed()
        # No Multicall3 in unit tests: fall back to sequential `_market()`.
        b._read_snapshot = lambda: None
        b._market = lambda: (BASE, QUOTE, BOT, 100, 10**9, 0)

        if ledger is not None:
            self.ledger = ledger
            self.wire_oracle(ledger)

    @property
    def __class__(self):
        return verifier.MarketMakerBot

    def wire_oracle(self, ledger):
        """ledger: qid -> quote dict. The stub serves `quotes(qid).call()` as the
        tuple and records settle/withdraw invocations into `self.calls`."""
        b = self.bot
        calls = []

        class _Funcs:
            def nextQuoteId(self):
                return _Fn(lambda: max(ledger, default=0) + 1)

            def getLatestPrice(self, *a):
                return _Fn(lambda: (123 * WAD, 0, True))

            def quotes(self, qid):
                return _Fn(lambda: to_tuple(ledger[qid]))

            def settleValidQuote(self, qid):
                return _Fn2(lambda: calls.append(("settle", qid)))

            def withdrawProviderFunds(self, qid):
                return _Fn2(lambda: calls.append(("withdraw", qid)))

        class _Oracle:
            pass

        oracle = _Oracle()
        oracle.functions = _Funcs()
        b.oracle = oracle
        self.calls = calls
        return calls


class TestSyncRound(unittest.TestCase):
    def test_adopts_max_live_own_expiry(self):
        bot = make_bot().bot
        bot._own_current = {1, 2}
        bot._quote_cached = lambda qid: {
            1: quote_dict(expiry=900),
            2: quote_dict(expiry=1200),
        }[qid]
        bot._sync_round(block=1000)
        self.assertEqual(bot._round_expiry, 1200)

    def test_ignores_own_expired_quotes_and_adopts_other_provider(self):
        m = make_bot(ledger={
            1: quote_dict(expiry=800),                       # own, expired
            2: quote_dict(provider=STRANGER, expiry=1500),   # other provider, live
        })
        bot = m.bot
        bot._own_current = {1}
        bot._sync_round(block=1000)
        self.assertEqual(bot._round_expiry, 1500)
        self.assertEqual(m.calls, [])  # scan only — no sends

    def test_nothing_live_anywhere_leaves_none(self):
        m = make_bot(ledger={1: quote_dict(expiry=800)})  # own, expired
        bot = m.bot
        bot._own_current = {1}
        bot._sync_round(block=1000)
        self.assertIsNone(bot._round_expiry)

    def test_other_pair_quotes_are_ignored_for_round_adoption(self):
        m = make_bot(ledger={
            1: quote_dict(provider=STRANGER, base=OTHER_BASE, expiry=1500),
        })
        bot = m.bot
        bot._sync_round(block=1000)
        self.assertIsNone(bot._round_expiry)

    def test_own_settlement_quote_maps_back_to_its_round(self):
        # A live quote with expiry within G of the head can only be the E+G
        # settlement quote, so the round it serves is E = expiry - G.
        m = make_bot(ledger={1: quote_dict(expiry=1030)})  # own, live, inside window
        bot = m.bot
        bot._own_current = {1}
        bot._sync_round(block=1000)
        self.assertEqual(bot._round_expiry, 970)

    def test_set_round_change_resets_round_state(self):
        bot = make_bot().bot
        bot._settlement_quote_id = 42
        bot._round_swept = True
        bot._set_round(500)
        self.assertEqual(bot._round_expiry, 500)
        self.assertIsNone(bot._settlement_quote_id)
        self.assertFalse(bot._round_swept)
        bot._settlement_quote_id = 43
        bot._set_round(500)  # same round -> state kept
        self.assertEqual(bot._settlement_quote_id, 43)

    def test_start_round_uses_round_blocks_and_never_creates_market(self):
        m = make_bot(ledger={})
        bot = m.bot
        expiry = bot._start_round(block=1000)
        self.assertEqual(expiry, 4000)
        self.assertEqual(bot._round_expiry, 4000)
        self.assertEqual(bot.sends, [])
        self.assertEqual(m.calls, [])


class TestSettleRound(unittest.TestCase):
    def test_settles_and_withdraws_only_this_rounds_own_quotes(self):
        ledger = {
            1: quote_dict(expiry=800, status=ACTIVE),                 # own, this round
            2: quote_dict(provider=STRANGER, expiry=800, status=ACTIVE),  # not ours
            3: quote_dict(expiry=1800, status=ACTIVE),                # own, another round
            4: quote_dict(expiry=800, status=ACTIVE),                 # own, this round (higher id)
        }
        m = make_bot(ledger=ledger)
        bot = m.bot
        bot._own_current = {1, 3, 4}
        bot.settle_round(800)
        settles = [int(s.split("q")[1]) for s in bot.sends if s.startswith("settle q")]
        self.assertEqual(settles, [1, 4])  # sorted ids, this round only
        # each ACTIVE quote is withdrawn in the same pass
        withdraws = [int(s.split("q")[1]) for s in bot.sends if s.startswith("withdraw q")]
        self.assertEqual(withdraws, [1, 4])
        self.assertEqual(m.calls, [])  # _send is stubbed; nothing broadcast

    def test_no_send_for_live_rounds(self):
        ledger = {1: quote_dict(expiry=1800, status=ACTIVE)}
        m = make_bot(ledger=ledger)
        bot = m.bot
        bot._own_current = {1}
        bot.settle_round(800)  # nothing matches expiry 800
        self.assertEqual(bot.sends, [])

    def test_withdraws_pending_settled_quotes_of_this_round(self):
        ledger = {1: quote_dict(expiry=800, status=SETTLED_VALID)}
        m = make_bot(ledger=ledger)
        bot = m.bot
        bot._pending_own = {1}
        bot.settle_round(800)
        self.assertEqual([s for s in bot.sends if s.startswith("settle q")], [])
        self.assertIn("withdraw q1", bot.sends)


class TestRescanOwnQuotes(unittest.TestCase):
    def test_scans_backwards_with_early_stop(self):
        ledger = {}
        qid = 1
        for _ in range(30):
            ledger[qid] = quote_dict(provider=STRANGER, expiry=1000)
            qid += 1
        ledger[qid] = quote_dict(expiry=1200)  # ours, newest
        m = make_bot(ledger=ledger)
        bot = m.bot
        bot._rescan_own_quotes(1000)
        self.assertIn(qid, bot._own_current)
        self.assertNotIn(1, bot._own_current)  # early stop before reaching the tail
        self.assertIsNone(bot._settlement_quote_id)

    def test_classifies_settlement_quote(self):
        m = make_bot(ledger={1: quote_dict(expiry=1060)})  # E + G
        bot = m.bot
        bot._rescan_own_quotes(1000)
        self.assertEqual(bot._settlement_quote_id, 1)
        self.assertEqual(bot._own_current, set())


class TestStepFlow(unittest.TestCase):
    def _bot(self, ledger):
        m = make_bot(ledger=ledger)
        return m.bot, m

    def test_expired_own_quote_settles_then_quotes_new_15min_round(self):
        ledger = {1: quote_dict(expiry=900, status=ACTIVE)}  # own, expired at block=1000
        bot, m = self._bot(ledger)
        submitted = []
        bot.submit_quote = lambda expiry, label, **kw: submitted.append((expiry, label)) or 99
        bot.step()
        # expired own round settled (recovery) before a fresh round starts
        self.assertIn("settle q1", bot.sends)
        self.assertEqual(len(submitted), 1)
        expiry, label = submitted[0]
        self.assertEqual(expiry, 1000 + bot.round_blocks)
        self.assertEqual(label, "restock quote")
        self.assertEqual(bot._round_expiry, expiry)

    def test_live_vetoed_round_is_served_not_replaced(self):
        ledger = {1: quote_dict(expiry=1500, status=VETOED_UNDERPRICED)}  # own, live
        bot, m = self._bot(ledger)
        submitted = []
        bot.submit_quote = lambda expiry, label, **kw: submitted.append((expiry, label)) or 99
        bot.step()
        # the vetoed quote is withdrawn (2x return) — never re-settled
        self.assertIn("withdraw q1", bot.sends)
        # round adopted from the own quote; restock at the SAME expiry
        self.assertEqual(len(submitted), 1)
        self.assertEqual(submitted[0][0], 1500)
        self.assertEqual(bot._round_expiry, 1500)

    def test_active_quote_present_means_no_restock(self):
        ledger = {1: quote_dict(expiry=1500, status=ACTIVE)}
        bot, m = self._bot(ledger)
        submitted = []
        bot.submit_quote = lambda expiry, label, **kw: submitted.append(expiry) or 99
        bot.step()
        self.assertEqual(submitted, [])


if __name__ == "__main__":
    unittest.main()
