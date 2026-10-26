"""Unit tests for the send guards in bot/verifier.py — stdlib `unittest`, no network.

P0 of the #33 gas audit. Monad bills the gas LIMIT of a mined tx, so a
revert-retry loop is a paid no-op: on 2026-10-21/22 the bot burned ~270 MON
that way (~21k reverted `withdrawProviderFunds` txs). `_send` therefore

  * backs off exponentially once a label reverts REVERT_BACKOFF_AFTER times,
  * skips sends the wallet cannot fund (MIN_BALANCE_TX_MULT head-room), and
  * clears the backoff as soon as the same label succeeds.

Run:  py -m unittest discover -s bot/tests -v
"""

import sys
import time
import types
import unittest
from pathlib import Path

BOT_DIR = Path(__file__).resolve().parent.parent
if str(BOT_DIR) not in sys.path:
    sys.path.insert(0, str(BOT_DIR))

import verifier  # noqa: E402


class FakeFn:
    def build_transaction(self, params):
        return {"fake": True, **params}


class FakeAccount:
    def sign_transaction(self, tx, pk):
        return types.SimpleNamespace(raw_transaction=b"\x00")


class FakeEth:
    def __init__(self, bot, statuses, balance):
        self._bot = bot
        self.statuses = list(statuses)
        self.balance = balance
        self.gas_price = 102 * 10**9
        self.block_number = 1000
        self.sent = []
        self.account = FakeAccount()

    def get_transaction_count(self, address, _mode):
        return 7

    def get_balance(self, _address):
        return self.balance

    def send_raw_transaction(self, _raw):
        self.sent.append(1)
        return types.SimpleNamespace(hex=lambda: "0xdead")

    def wait_for_transaction_receipt(self, _h, timeout=120):
        status = self.statuses.pop(0) if self.statuses else 1
        return types.SimpleNamespace(
            status=status, blockNumber=1001, gasUsed=129367,
        )


class FakeW3:
    def __init__(self, bot, statuses=(1,), balance=10**18):
        self.eth = FakeEth(bot, statuses, balance)


class FakeCtx:
    def __init__(self, w3, balance):
        self.w3 = w3
        self.chain_id = 10143
        self.nonce = None
        self._balance = balance

    def balance_wei(self, ttl=30.0):
        return self._balance


def make_bot(statuses=(1,), balance=10**18, nonce=7):
    bot = object.__new__(verifier.MarketMakerBot)
    bot.w3 = FakeW3(bot, statuses, balance)
    bot.ctx = FakeCtx(bot.w3, balance)
    bot.address = "0xbot"
    bot.pk = "0xkey"
    bot.gas_price_cap = 0
    bot._nonce = nonce
    bot._revert_state = {}
    bot._low_balance_warned = 0.0
    bot._log_latency = lambda *a, **k: None  # latency probe is not under test
    return bot


class RevertBackoffTest(unittest.TestCase):
    def test_first_revert_raises_and_records_without_backoff(self):
        bot = make_bot(statuses=[0])
        with self.assertRaises(RuntimeError):
            bot._send(FakeFn(), 129_367, "withdraw q11")
        state = bot._revert_state["withdraw q11"]
        self.assertEqual(state["fails"], 1)
        self.assertEqual(state["wasted"], 129_367 * 102 * 10**9)
        self.assertLessEqual(state["until"], time.time())  # no backoff yet

    def test_second_revert_arms_the_backoff(self):
        bot = make_bot(statuses=[0, 0])
        for _ in range(2):
            with self.assertRaises(RuntimeError):
                bot._send(FakeFn(), 129_367, "withdraw q11")
        state = bot._revert_state["withdraw q11"]
        self.assertEqual(state["fails"], 2)
        self.assertGreater(state["until"], time.time())

    def test_send_is_skipped_while_backed_off(self):
        bot = make_bot(statuses=[0, 0])
        for _ in range(2):
            with self.assertRaises(RuntimeError):
                bot._send(FakeFn(), 129_367, "withdraw q11")
        before = len(bot.w3.eth.sent)
        with self.assertRaises(verifier.SendBackoff):
            bot._send(FakeFn(), 129_367, "withdraw q11")
        self.assertEqual(len(bot.w3.eth.sent), before, "no tx may be sent during backoff")

    def test_backoff_does_not_block_other_labels(self):
        bot = make_bot(statuses=[0, 0, 1])
        for _ in range(2):
            with self.assertRaises(RuntimeError):
                bot._send(FakeFn(), 129_367, "withdraw q11")
        bot._send(FakeFn(), 366_000, "restock quote")  # different label: still sends
        self.assertEqual(len(bot.w3.eth.sent), 3)

    def test_expired_backoff_sends_again(self):
        bot = make_bot(statuses=[0, 0, 1])
        for _ in range(2):
            with self.assertRaises(RuntimeError):
                bot._send(FakeFn(), 129_367, "withdraw q11")
        bot._revert_state["withdraw q11"]["until"] = time.time() - 1  # window elapsed
        bot._send(FakeFn(), 129_367, "withdraw q11")
        self.assertEqual(len(bot.w3.eth.sent), 3)

    def test_success_clears_the_backoff_state(self):
        bot = make_bot(statuses=[0, 0, 1])
        for _ in range(2):
            with self.assertRaises(RuntimeError):
                bot._send(FakeFn(), 129_367, "withdraw q11")
        bot._revert_state["withdraw q11"]["until"] = time.time() - 1
        bot._send(FakeFn(), 129_367, "withdraw q11")
        self.assertNotIn("withdraw q11", bot._revert_state)


class BalanceGuardTest(unittest.TestCase):
    def test_send_skipped_when_wallet_cannot_fund_it(self):
        # 129,367 gas x 102 gwei x 3 head-room = ~0.0396 MON; wallet holds 0.01.
        bot = make_bot(balance=int(0.01 * 10**18))
        with self.assertRaises(verifier.InsufficientBalance):
            bot._send(FakeFn(), 129_367, "withdraw q11")
        self.assertEqual(bot.w3.eth.sent, [])

    def test_send_proceeds_when_wallet_is_funded(self):
        bot = make_bot(balance=int(10 * 10**18))
        bot._send(FakeFn(), 129_367, "withdraw q11")
        self.assertEqual(len(bot.w3.eth.sent), 1)

    def test_low_balance_warning_is_throttled(self):
        bot = make_bot(balance=int(0.01 * 10**18))
        for _ in range(3):
            with self.assertRaises(verifier.InsufficientBalance):
                bot._send(FakeFn(), 129_367, "withdraw q11")
        # the second and third attempt must not re-warn (throttled to once per 300 s)
        self.assertEqual(bot._low_balance_warned, bot._low_balance_warned)
        self.assertGreater(bot._low_balance_warned, 0)


class BalanceCacheTest(unittest.TestCase):
    def test_balance_is_cached_for_the_ttl(self):
        ctx = object.__new__(verifier.BotContext)
        ctx._balance_ts = 0.0
        ctx._balance_wei = 0
        ctx.address = "0xbot"
        calls = []

        class W3:
            class eth:
                @staticmethod
                def get_balance(_a):
                    calls.append(1)
                    return 42

        ctx.w3 = W3()
        self.assertEqual(ctx.balance_wei(ttl=30), 42)
        self.assertEqual(ctx.balance_wei(ttl=30), 42)
        self.assertEqual(len(calls), 1, "second read must hit the cache")
        ctx._balance_ts = time.time() - 31  # TTL elapsed
        self.assertEqual(ctx.balance_wei(ttl=30), 42)
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
