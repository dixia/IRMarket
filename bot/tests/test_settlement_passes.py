"""Unit tests for the settlement passes in bot/verifier.py — stdlib `unittest`,
no network.

What these pin (lazy-settlement oracle, cutover #33):

  * `settle_round` must NOT send `settleValidQuote` for the round's trading
    quotes. Under lazy settlement the quote is canonical the moment
    `block.number > expiryBlock`, and `withdrawProviderFunds` backfills
    `settledSlot = expiryBlock` for a matured ACTIVE quote, so the quote stays a
    canonical candidate in `getLatestPrice`'s 8-step walk without the extra tx.
    The checkpoint cost ~73k gas (Monad bills the limit) per quote per round.
  * the withdraw half of that pass stays — collateral has to be recycled.
  * `settle_settlement_quote` KEEPS its checkpoint: it is the only writer of
    `latestValidQuoteId[pair]`, the walk's fallback floor once a round piles up
    more than MAX_PRICE_WALK (8) non-canonical quotes (every user trade vetoes
    one, and vetoed quotes never become canonical).

Run:  py -m unittest discover -s bot/tests -v
"""

import sys
import types
import unittest
from pathlib import Path

BOT_DIR = Path(__file__).resolve().parent.parent
if str(BOT_DIR) not in sys.path:
    sys.path.insert(0, str(BOT_DIR))

import verifier  # noqa: E402

ACTIVE = verifier.ACTIVE
SETTLED_VALID = verifier.SETTLED_VALID
VETOED_UNDERPRICED = verifier.VETOED_UNDERPRICED
VETOED_OVERPRICED = verifier.VETOED_OVERPRICED


class FakeFunctions:
    """Records the selector of every send, answers `.call()` reads."""

    def __init__(self, oracle):
        self._oracle = oracle

    def settleValidQuote(self, qid):
        self._oracle.sent.append(("settleValidQuote", qid))
        return ("tx", "settleValidQuote", qid)

    def withdrawProviderFunds(self, qid):
        self._oracle.sent.append(("withdrawProviderFunds", qid))
        return ("tx", "withdrawProviderFunds", qid)

    def getLatestPrice(self, base, quote):
        self._oracle.reads.append("getLatestPrice")
        return types.SimpleNamespace(call=lambda: [12345, 0, True])


class FakeOracle:
    def __init__(self):
        self.sent = []
        self.reads = []
        self.functions = FakeFunctions(self)


class FakeEth:
    def __init__(self, head):
        self.head = head
        self.block_number = head


class FakeW3:
    def __init__(self, head):
        self.eth = FakeEth(head)


def make_bot(quotes, head, own_current, own_pending, settlement_quote_id=None,
             round_expiry=None):
    """A MarketMakerBot with only the state the settlement passes touch."""
    bot = object.__new__(verifier.MarketMakerBot)
    bot.symbol = "TEST"
    bot.base_token = "0xbase"
    bot.quote_token = "0xquote"
    bot.oracle = FakeOracle()
    bot.w3 = FakeW3(head)
    bot.settlement_window_blocks = 60
    bot._own_current = set(own_current)
    bot._pending_own = set(own_pending)
    bot._settlement_quote_id = settlement_quote_id
    bot._round_swept = False
    bot._quotes = dict(quotes)

    def quote_of(qid):
        return bot._quotes[qid]

    bot._quote = quote_of
    bot.sends = []

    def send(txfn, gas, label, decision_block=None, decision_ts=None):
        bot.sends.append((label, gas, txfn))
        return None

    bot._send = send
    bot.round_expiry = round_expiry
    return bot


def quote(expiry, status):
    return {"expiryBlock": expiry, "status": status, "settledSlot": 0}


class SettleRoundTest(unittest.TestCase):
    """`settle_round` — the trading-quote pass, run once per round after expiry."""

    ROUND = 1_000_000

    def test_no_settle_tx_for_matured_active_quote(self):
        # ACTIVE, window passed: withdraw only, no checkpoint.
        bot = make_bot({11: quote(self.ROUND, ACTIVE)}, head=self.ROUND + 5,
                       own_current=[11], own_pending=set())
        bot.settle_round(self.ROUND)
        self.assertEqual([s[0] for s in bot.sends], ["withdraw q11"])
        self.assertEqual(bot.oracle.sent, [("withdrawProviderFunds", 11)])

    def test_settled_and_vetoed_quotes_are_withdrawn_only(self):
        quotes = {
            12: quote(self.ROUND, SETTLED_VALID),
            13: quote(self.ROUND, VETOED_UNDERPRICED),
            14: quote(self.ROUND, VETOED_OVERPRICED),
        }
        bot = make_bot(quotes, head=self.ROUND + 5, own_current=set(),
                       own_pending={12, 13, 14})
        bot.settle_round(self.ROUND)
        self.assertEqual(sorted(s[0] for s in bot.sends),
                         ["withdraw q12", "withdraw q13", "withdraw q14"])
        self.assertEqual(bot.oracle.sent.count(("settleValidQuote", 12)), 0)

    def test_other_round_quotes_are_skipped(self):
        # Per-round attribution: a quote from another round is not touched.
        bot = make_bot({21: quote(self.ROUND - 6000, ACTIVE)}, head=self.ROUND + 5,
                       own_current=[21], own_pending=set())
        bot.settle_round(self.ROUND)
        self.assertEqual(bot.sends, [])
        self.assertEqual(bot.oracle.sent, [])
        self.assertIn(21, bot._own_current)  # kept for the round that owns it

    def test_round_gas_is_one_withdraw_per_quote(self):
        # The billable cost of the pass: GAS["withdraw"] per own quote, no settle.
        quotes = {i: quote(self.ROUND, ACTIVE) for i in (31, 32)}
        bot = make_bot(quotes, head=self.ROUND + 5, own_current=[31, 32],
                       own_pending=set())
        bot.settle_round(self.ROUND)
        self.assertEqual(len(bot.sends), 2)
        self.assertEqual([s[1] for s in bot.sends],
                         [verifier.GAS["withdraw"], verifier.GAS["withdraw"]])

    def test_canonical_price_is_read_not_written(self):
        bot = make_bot({41: quote(self.ROUND, ACTIVE)}, head=self.ROUND + 5,
                       own_current=[41], own_pending=set())
        bot.settle_round(self.ROUND)
        self.assertEqual(bot.oracle.reads, ["getLatestPrice"])


class SettleSettlementQuoteTest(unittest.TestCase):
    """`settle_settlement_quote` — keeps the checkpoint (the walk's floor)."""

    ROUND = 2_000_000

    def test_checkpoint_is_still_sent_for_the_settlement_quote(self):
        # window_end = E + G is past: settle (floor) + withdraw.
        bot = make_bot({7: quote(self.ROUND + 60, ACTIVE)}, head=self.ROUND + 70,
                       own_current=set(), own_pending=set(), settlement_quote_id=7)
        bot.settle_settlement_quote(self.ROUND)
        self.assertEqual([s[0] for s in bot.sends],
                         ["settle q7 (settlement quote)", "withdraw q7"])
        self.assertEqual(bot.oracle.sent,
                         [("settleValidQuote", 7), ("withdrawProviderFunds", 7)])

    def test_no_send_while_the_settlement_window_is_open(self):
        bot = make_bot({8: quote(self.ROUND + 60, ACTIVE)}, head=self.ROUND + 30,
                       own_current=set(), own_pending=set(), settlement_quote_id=8)
        bot.settle_settlement_quote(self.ROUND)
        self.assertEqual(bot.sends, [])
        self.assertEqual(bot.oracle.sent, [])

    def test_vetoed_settlement_quote_withdraws_only(self):
        bot = make_bot({9: quote(self.ROUND + 60, VETOED_OVERPRICED)},
                       head=self.ROUND + 70, own_current=set(), own_pending=set(),
                       settlement_quote_id=9)
        bot.settle_settlement_quote(self.ROUND)
        self.assertEqual([s[0] for s in bot.sends], ["withdraw q9"])
        self.assertEqual(bot.oracle.sent, [("withdrawProviderFunds", 9)])


if __name__ == "__main__":
    unittest.main()
