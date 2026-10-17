"""Unit tests for the one-market-per-pair round model in bot/verifier.py.

No network: the bot object is built via `object.__new__` (skipping BotContext), the
oracle is a stub, and `_send` records calls instead of broadcasting. Covers
docs/plan/one-market-per-pair-plan.md §5.

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
        b.auto_create = False
        b.requote = False
        b.market_id = 1
        b._own_quotes = set()
        b._own_cache = {}
        b._withdrawn = set()
        b._round_expiry = None
        b._final_submitted = False
        b.sends = []
        b.w3 = _StubW3(block)

        def _send(fn, gas, label):
            b.sends.append(label)
            return None

        b._send = _send

        class _Feed:
            def get(self, block):
                return 100 * WAD

        b.feed = _Feed()

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

        class _Fn2:
            def __init__(self, fn):
                self._fn = fn

            def build_transaction(self, tx):
                return tx

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
        bot._own_cache = {
            1: quote_dict(expiry=900),
            2: quote_dict(expiry=1200, status=VETOED_UNDERPRICED),
        }
        bot._sync_round(block=1000)
        self.assertEqual(bot._round_expiry, 1200)

    def test_ignores_own_expired_quotes_and_adopts_other_provider(self):
        m = make_bot(ledger={
            1: quote_dict(expiry=800),                       # own, expired
            2: quote_dict(provider=STRANGER, expiry=1500),   # other provider, live
        })
        bot = m.bot
        bot._sync_round(block=1000)
        self.assertEqual(bot._round_expiry, 1500)
        self.assertEqual(m.calls, [])  # scan only — no sends

    def test_nothing_live_anywhere_starts_fresh(self):
        m = make_bot(ledger={1: quote_dict(expiry=800)})  # own, expired
        bot = m.bot
        bot._sync_round(block=1000)
        self.assertIsNone(bot._round_expiry)

    def test_other_pair_quotes_are_ignored_for_round_adoption(self):
        m = make_bot(ledger={
            1: quote_dict(provider=STRANGER, base=OTHER_BASE, expiry=1500),
        })
        bot = m.bot
        bot._sync_round(block=1000)
        self.assertIsNone(bot._round_expiry)

    def test_set_round_change_resets_final_flag(self):
        bot = make_bot().bot
        bot._final_submitted = True
        bot._set_round(500)
        self.assertEqual(bot._round_expiry, 500)
        self.assertFalse(bot._final_submitted)
        bot._final_submitted = True
        bot._set_round(500)  # same round -> flag kept
        self.assertTrue(bot._final_submitted)

    def test_start_round_uses_round_blocks(self):
        bot = make_bot().bot
        expiry = bot._start_round(block=1000)
        self.assertEqual(expiry, 4000)
        self.assertEqual(bot._round_expiry, 4000)
        self.assertFalse(bot._final_submitted)


class TestSettleExpiredRounds(unittest.TestCase):
    def test_settles_only_expired_active_quotes_oldest_round_first(self):
        ledger = {
            1: quote_dict(expiry=800, status=ACTIVE),                                     # own q1 (expired)
            2: quote_dict(provider=STRANGER, expiry=800, status=ACTIVE),                  # stranger (expired)
            3: quote_dict(expiry=1800, status=ACTIVE),                                    # own q3 (live)
            4: quote_dict(expiry=700, status=SETTLED_VALID),                              # already settled
            5: quote_dict(provider=STRANGER, base=OTHER_BASE, expiry=700, status=ACTIVE), # other pair
            6: quote_dict(expiry=700, status=ACTIVE),                                     # own q6 (older round)
        }
        m = make_bot(ledger=ledger)
        bot = m.bot
        bot._own_quotes = {1, 3, 4, 6}
        bot._own_cache = {1: ledger[1], 3: ledger[3], 4: ledger[4], 6: ledger[6]}
        bot.settle_expired_rounds(block=1000)
        settles = [s for s in bot.sends if s.startswith("settle q")]
        qids = [int(s.split("q")[1]) for s in settles]
        # oldest-expiring first: round 700 (q6) before round 800 (q1, then the stranger q2)
        self.assertEqual(qids, [6, 1, 2])
        # our own q4 (SETTLED_VALID, expired from the initial snapshot) is withdrawn;
        # q1/q6 settle first and are withdrawn on a later cycle once the cache refreshes.
        withdraws = [int(s.split("q")[1]) for s in bot.sends if s.startswith("withdraw q")]
        self.assertEqual(withdraws, [4])

    def test_no_send_when_everything_is_live(self):
        m = make_bot(ledger={1: quote_dict(expiry=1800, status=ACTIVE)})
        bot = m.bot
        bot._own_quotes = {1}
        bot._own_cache = dict(m.ledger)
        bot.settle_expired_rounds(block=1000)
        self.assertEqual([c for c in m.calls if c[0] == "settle"], [])
        self.assertEqual(bot.sends, [])

    def test_withdraws_own_finished_expired_quotes(self):
        m = make_bot(ledger={
            1: quote_dict(expiry=800, status=SETTLED_VALID),
            2: quote_dict(expiry=800, status=VETOED_UNDERPRICED),
        })
        bot = m.bot
        bot._own_quotes = {1, 2}
        bot._own_cache = dict(m.ledger)
        bot.settle_expired_rounds(block=1000)
        self.assertEqual(bot._withdrawn, {1, 2})
        self.assertEqual([c for c in m.calls if c[0] == "settle"], [])


class TestRescanOwnQuotes(unittest.TestCase):
    def test_scans_backwards_with_early_stop_and_caches(self):
        ledger = {}
        qid = 1
        for _ in range(30):
            ledger[qid] = quote_dict(provider=STRANGER, expiry=1000)
            qid += 1
        ledger[qid] = quote_dict(expiry=1200)
        m = make_bot(ledger=ledger)
        bot = m.bot
        bot._rescan_own_quotes()
        self.assertIn(qid, bot._own_quotes)
        self.assertEqual(bot._own_cache[qid]["expiryBlock"], 1200)
        self.assertNotIn(1, bot._own_quotes)


class TestStepFlow(unittest.TestCase):
    def _bot(self, ledger):
        m = make_bot(ledger=ledger)
        bot = m.bot
        return bot, m

    def test_expired_own_quote_settles_then_quotes_new_15min_round(self):
        ledger = {1: quote_dict(expiry=900, status=ACTIVE)}  # own, expired at block=1000
        bot, m = self._bot(ledger)
        bot._own_quotes = {1}
        bot._own_cache = {1: dict(ledger[1])}

        submitted = []

        def fake_submit(expiry, label):
            submitted.append((expiry, label))
            return 99

        bot.submit_quote = fake_submit
        bot.step()
        # expired quote settled (full scan path) BEFORE round derivation
        self.assertIn("settle q1", bot.sends)
        # a fresh 15-min round started and restocked exactly once
        self.assertEqual(len(submitted), 1)
        expiry, label = submitted[0]
        self.assertEqual(expiry, 1000 + bot.round_blocks)
        self.assertEqual(label, "restock quote")
        self.assertEqual(bot._round_expiry, expiry)

    def test_live_vetoed_round_is_served_not_replaced(self):
        ledger = {
            1: quote_dict(expiry=1500, status=VETOED_UNDERPRICED),  # own, vetoed, live
        }
        bot, m = self._bot(ledger)
        bot._own_quotes = {1}
        bot._own_cache = {1: dict(ledger[1])}

        submitted = []

        def fake_submit(expiry, label):
            submitted.append((expiry, label))
            return 99

        bot.submit_quote = fake_submit
        bot.step()
        # the vetoed quote is withdrawn (2x return) — never re-settled
        self.assertIn("withdraw q1", bot.sends)
        # round adopted from own quote; restock submitted at the SAME expiry
        self.assertEqual(len(submitted), 1)
        self.assertEqual(submitted[0][0], 1500)
        self.assertEqual(bot._round_expiry, 1500)

    def test_active_quote_present_means_no_restock(self):
        ledger = {1: quote_dict(expiry=1500, status=ACTIVE)}
        bot, m = self._bot(ledger)
        bot._own_quotes = {1}
        bot._own_cache = {1: dict(ledger[1])}

        submitted = []
        bot.submit_quote = lambda expiry, label: submitted.append(expiry) or 99
        bot.step()
        self.assertEqual(submitted, [])


if __name__ == "__main__":
    unittest.main()
