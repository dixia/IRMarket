"""Unit tests for the send guards in bot/verifier.py — stdlib `unittest`, no network.

P0 of the #33 gas audit. Monad bills the gas LIMIT of a mined tx, so a
revert-retry loop is a paid no-op: on 2026-10-21/22 the bot burned ~270 MON
that way (~21k reverted `withdrawProviderFunds` txs). `_send` therefore

  * backs off exponentially once a label reverts REVERT_BACKOFF_AFTER times,
  * parks a label that keeps reverting (circuit breaker, persisted),
  * charges every tx to a rolling MON budget and stops when it is spent,
  * skips sends the wallet cannot fund,
  * and clears the backoff as soon as the same label succeeds.

Run:  py -m unittest discover -s bot/tests -v
"""

import os
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path

BOT_DIR = Path(__file__).resolve().parent.parent
if str(BOT_DIR) not in sys.path:
    sys.path.insert(0, str(BOT_DIR))

import verifier  # noqa: E402

E18 = verifier.E18


class FakeFn:
    def __init__(self, call_error=None):
        self.call_error = call_error
        self.calls = 0

    def build_transaction(self, params):
        return {"fake": True, **params}

    def call(self, params=None):
        self.calls += 1
        if self.call_error is not None:
            raise self.call_error
        return True


class FakeAccount:
    def sign_transaction(self, tx, pk):
        return types.SimpleNamespace(raw_transaction=b"\x00")


class FakeEth:
    def __init__(self, statuses, balance):
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
        return types.SimpleNamespace(status=status, blockNumber=1001, gasUsed=129367)


class FakeW3:
    def __init__(self, statuses=(1,), balance=10 * E18):
        self.eth = FakeEth(statuses, balance)


def make_bot(statuses=(1,), balance=10 * E18, nonce=7, state_file=""):
    """A MarketMakerBot wired to a real BotContext (ledger + breaker) with a fake chain."""
    verifier.GUARD_STATE_FILE = state_file  # module global read by the ctx methods
    w3 = FakeW3(statuses, balance)
    ctx = object.__new__(verifier.BotContext)
    ctx.w3 = w3
    ctx.address = "0xbot"
    ctx.chain_id = 10143
    ctx.nonce = nonce
    ctx._balance_ts = 0.0
    ctx._balance_wei = 0
    ctx._spend = []
    ctx._poisoned = {}
    if state_file:
        ctx._load_guard_state()

    bot = object.__new__(verifier.MarketMakerBot)
    bot.w3 = w3
    bot.ctx = ctx
    bot.address = "0xbot"
    bot.pk = "0xkey"
    bot.gas_price_cap = 0
    bot._nonce = nonce
    bot._revert_state = {}
    bot._low_balance_warned = 0.0
    bot._budget_warned = 0.0
    bot._preflight_warned = 0.0
    bot._last_head = None
    bot._last_expiry = None
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


class CircuitBreakerTest(unittest.TestCase):
    def _revert_n(self, bot, n, gas=129_367, label="withdraw q11"):
        """N reverts of the same label, with the backoff expiring between attempts
        (the breaker counts real reverts, and the backoff legitimately paces them)."""
        for _ in range(n):
            state = bot._revert_state.get(label)
            if state:
                state["until"] = 0.0  # simulate the backoff window expiring
            with self.assertRaises(RuntimeError):
                bot._send(FakeFn(), gas, label)

    def test_label_is_parked_after_max_consecutive_reverts(self):
        n = verifier.MAX_CONSECUTIVE_REVERTS
        bot = make_bot(statuses=[0] * n)
        self._revert_n(bot, n)
        sent_before = len(bot.w3.eth.sent)
        with self.assertRaises(verifier.LabelPoisoned):
            bot._send(FakeFn(), 129_367, "withdraw q11")
        self.assertEqual(len(bot.w3.eth.sent), sent_before, "breaker must not send")

    def test_breaker_does_not_park_other_labels(self):
        n = verifier.MAX_CONSECUTIVE_REVERTS
        bot = make_bot(statuses=[0] * n + [1])
        self._revert_n(bot, n)
        bot._send(FakeFn(), 366_000, "restock quote")
        self.assertEqual(len(bot.w3.eth.sent), n + 1)

    def test_parked_label_resumes_after_the_cool_down(self):
        n = verifier.MAX_CONSECUTIVE_REVERTS
        bot = make_bot(statuses=[0] * n + [1])
        self._revert_n(bot, n)
        bot.ctx._poisoned["withdraw q11"] = time.time() - 1  # cool-down elapsed
        bot._send(FakeFn(), 129_367, "withdraw q11")
        self.assertEqual(len(bot.w3.eth.sent), n + 1)


class SpendBudgetTest(unittest.TestCase):
    def test_budget_exceeded_skips_the_send(self):
        bot = make_bot()
        bot.ctx._spend = [(time.time(), int(verifier.MAX_MON_PER_HOUR * E18))]
        with self.assertRaises(verifier.BudgetExceeded):
            bot._send(FakeFn(), 129_367, "withdraw q11")
        self.assertEqual(bot.w3.eth.sent, [])

    def test_daily_cap_is_enforced_even_when_the_hourly_one_is_not(self):
        bot = make_bot()
        # inside the last hour but just over the daily cap: spread it out in time
        bot.ctx._spend = [
            (time.time() - 7200, int(verifier.MAX_MON_PER_DAY * E18)),
        ]
        with self.assertRaises(verifier.BudgetExceeded):
            bot._send(FakeFn(), 129_367, "withdraw q11")

    def test_a_quiet_window_lets_the_bot_resume(self):
        bot = make_bot()
        bot.ctx._spend = [(time.time() - 3700, int(verifier.MAX_MON_PER_HOUR * E18))]
        bot._send(FakeFn(), 129_367, "withdraw q11")  # older than 1 h: budget is free
        self.assertEqual(len(bot.w3.eth.sent), 1)

    def test_send_cost_is_charged_to_the_ledger(self):
        bot = make_bot()
        bot._send(FakeFn(), 366_000, "restock quote")
        self.assertEqual(bot.ctx.spend_since(60), 366_000 * 102 * 10**9)

    def test_revert_is_charged_too(self):
        bot = make_bot(statuses=[0])
        with self.assertRaises(RuntimeError):
            bot._send(FakeFn(), 129_367, "withdraw q11")
        self.assertEqual(bot.ctx.spend_since(60), 129_367 * 102 * 10**9)


class PreflightSimulationTest(unittest.TestCase):
    """A would-be revert must be caught by `eth_call`, not paid for on-chain."""

    def test_simulation_revert_is_not_broadcast(self):
        bot = make_bot()
        fn = FakeFn(call_error=Exception("execution reverted: NotWithdrawable"))
        with self.assertRaises(verifier.PreflightRevert):
            bot._send(fn, 129_367, "withdraw q11")
        self.assertEqual(bot.w3.eth.sent, [], "nothing may be broadcast")
        self.assertEqual(bot.ctx.spend_since(60), 0, "a caught revert must cost nothing")
        self.assertEqual(fn.calls, 1)

    def test_simulation_runs_before_an_ok_send(self):
        bot = make_bot()
        fn = FakeFn()
        bot._send(fn, 129_367, "withdraw q11")
        self.assertEqual(fn.calls, 1)
        self.assertEqual(len(bot.w3.eth.sent), 1)

    def test_simulation_is_skipped_in_the_near_expiry_band(self):
        bot = make_bot()
        bot._last_head = 1000
        bot._last_expiry = 1000  # inside the near-expiry band
        fn = FakeFn(call_error=Exception("execution reverted"))
        bot._send(fn, 129_367, "final settlement quote")
        self.assertEqual(fn.calls, 0, "latency-critical path must not spend an extra RPC")
        self.assertEqual(len(bot.w3.eth.sent), 1)

    def test_simulation_can_be_disabled(self):
        old = verifier.PREFLIGHT_SIMULATE
        verifier.PREFLIGHT_SIMULATE = False
        try:
            bot = make_bot()
            fn = FakeFn(call_error=Exception("execution reverted"))
            bot._send(fn, 129_367, "withdraw q11")
            self.assertEqual(fn.calls, 0)
            self.assertEqual(len(bot.w3.eth.sent), 1)
        finally:
            verifier.PREFLIGHT_SIMULATE = old

    def test_repeated_simulation_failures_do_not_crash_the_loop(self):
        bot = make_bot()
        fn = FakeFn(call_error=Exception("execution reverted: NotWithdrawable"))
        for _ in range(3):
            with self.assertRaises(verifier.PreflightRevert):
                bot._send(fn, 129_367, "withdraw q11")
        self.assertEqual(bot.w3.eth.sent, [])
        self.assertGreater(bot._preflight_warned, 0)


class BalanceGuardTest(unittest.TestCase):
    def test_send_skipped_when_wallet_cannot_fund_it(self):
        # 129,367 gas x 102 gwei x 3 head-room = ~0.0396 MON; wallet holds 0.01.
        bot = make_bot(balance=int(0.01 * E18))
        with self.assertRaises(verifier.InsufficientBalance):
            bot._send(FakeFn(), 129_367, "withdraw q11")
        self.assertEqual(bot.w3.eth.sent, [])

    def test_send_proceeds_when_wallet_is_funded(self):
        bot = make_bot(balance=10 * E18)
        bot._send(FakeFn(), 129_367, "withdraw q11")
        self.assertEqual(len(bot.w3.eth.sent), 1)

    def test_low_balance_warning_is_throttled(self):
        bot = make_bot(balance=int(0.01 * E18))
        for _ in range(3):
            with self.assertRaises(verifier.InsufficientBalance):
                bot._send(FakeFn(), 129_367, "withdraw q11")
        self.assertGreater(bot._low_balance_warned, 0)


class GuardStatePersistenceTest(unittest.TestCase):
    """A restart (systemd Restart=always) must not reset a tripped stop."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, ".guard-state.json")

    def tearDown(self):
        self.dir.cleanup()

    def test_poisoned_label_and_spend_survive_a_restart(self):
        bot = make_bot(statuses=[0] * verifier.MAX_CONSECUTIVE_REVERTS,
                       state_file=self.path)
        for _ in range(verifier.MAX_CONSECUTIVE_REVERTS):
            state = bot._revert_state.get("withdraw q11")
            if state:
                state["until"] = 0.0
            with self.assertRaises(RuntimeError):
                bot._send(FakeFn(), 129_367, "withdraw q11")
        spent = bot.ctx.spend_since(60)
        self.assertTrue(Path(self.path).exists())

        # "restart": a fresh bot with the same state file
        reborn = make_bot(state_file=self.path)
        self.assertTrue(reborn.ctx.is_poisoned("withdraw q11"))
        self.assertEqual(reborn.ctx.spend_since(60), spent)

    def test_expired_poison_is_not_restored(self):
        bot = make_bot(state_file=self.path)
        bot.ctx._poisoned["withdraw q11"] = time.time() - 1
        bot.ctx._save_guard_state()
        reborn = make_bot(state_file=self.path)
        self.assertFalse(reborn.ctx.is_poisoned("withdraw q11"))

    def test_state_file_can_be_disabled(self):
        bot = make_bot(state_file="")
        bot.ctx.record_spend(10**18)
        self.assertFalse(os.path.exists(".guard-state.json"))
        self.assertEqual(bot.ctx.spend_since(60), 10**18)


class BalanceCacheTest(unittest.TestCase):
    def test_balance_is_cached_for_the_ttl(self):
        bot = make_bot()
        ctx = bot.ctx
        calls = []

        class W3:
            class eth:
                @staticmethod
                def get_balance(_a):
                    calls.append(1)
                    return 42

        ctx.w3 = W3()
        ctx._balance_ts = 0.0
        ctx._balance_wei = 0
        self.assertEqual(ctx.balance_wei(ttl=30), 42)
        self.assertEqual(ctx.balance_wei(ttl=30), 42)
        self.assertEqual(len(calls), 1, "second read must hit the cache")
        ctx._balance_ts = time.time() - 31  # TTL elapsed
        self.assertEqual(ctx.balance_wei(ttl=30), 42)
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
