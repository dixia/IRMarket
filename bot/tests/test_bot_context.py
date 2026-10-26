"""Construction test for BotContext — stdlib `unittest`, no network.

Regression for 2026-10-26: a mis-edit inserted `balance_wei` in the middle of
`BotContext.__init__`, which orphaned the tail of the constructor (assets file,
oracle/market/multicall contracts, nonce) after a `return` inside `poison()`.
Every unit test bypassed `__init__` via `object.__new__`, so the suite stayed
green while the bot crashed on boot with
`'BotContext' object has no attribute 'oracle_addr'`.
Constructing the context with a fake Web3 is the cheapest way to keep that from
happening again.

Run:  py -m unittest discover -s bot/tests -v
"""

import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

BOT_DIR = Path(__file__).resolve().parent.parent
if str(BOT_DIR) not in sys.path:
    sys.path.insert(0, str(BOT_DIR))

import verifier  # noqa: E402


class _FakeAccount:
    @staticmethod
    def from_key(pk):
        return types.SimpleNamespace(address="0xbot")


class _FakeEth:
    def __init__(self):
        self.chain_id = 10143
        self.gas_price = 1
        self.account = _FakeAccount()

    def contract(self, **kwargs):
        return types.SimpleNamespace(address=kwargs.get("address"))

    def get_balance(self, _address):
        return 123


class _FakeWeb3:
    def __init__(self, provider):
        self.provider = provider
        self.eth = _FakeEth()
        self.middleware_onion = types.SimpleNamespace(remove=lambda name: None)

    def is_connected(self):
        return True

    @staticmethod
    def to_checksum_address(address):
        return address

    @staticmethod
    def HTTPProvider(url, **kwargs):
        return url


class BotContextInitTest(unittest.TestCase):
    def test_init_wires_every_chain_object(self):
        env = {
            "PRIVATE_KEY": "0x" + "11" * 32,
            "ORACLE_ADDRESS": "0x" + "22" * 20,
            "MARKET_ADDRESS": "0x" + "33" * 20,
            "CHAIN_ID": "10143",
            "MULTICALL3_ADDRESS": "0xcA11bde05977b3631167028862bE2a173976CA11",
        }
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(verifier, "Web3", _FakeWeb3), \
                mock.patch.object(verifier, "_load_abi", lambda rel: []), \
                mock.patch.object(verifier, "GUARD_STATE_FILE", ""):
            ctx = verifier.BotContext(shared={"chainId": 10143})

        # the tail of __init__ that the 2026-10-26 mis-edit orphaned
        self.assertEqual(ctx.oracle_addr, env["ORACLE_ADDRESS"])
        self.assertEqual(ctx.market_addr, env["MARKET_ADDRESS"])
        self.assertIsNotNone(ctx.oracle)
        self.assertIsNotNone(ctx.market)
        self.assertIsNotNone(ctx.multicall3)
        self.assertIsNone(ctx.nonce)
        # and the guards' state, which must exist before the first send
        self.assertEqual(ctx._spend, [])
        self.assertEqual(ctx._poisoned, {})
        self.assertEqual(ctx.balance_wei(), 123)

    def test_missing_addresses_still_fail_loudly(self):
        env = {"PRIVATE_KEY": "0x" + "11" * 32, "CHAIN_ID": "10143"}
        with mock.patch.dict(os.environ, env, clear=False), \
                mock.patch.object(verifier, "Web3", _FakeWeb3), \
                mock.patch.object(verifier, "_load_abi", lambda rel: []), \
                mock.patch.object(verifier, "GUARD_STATE_FILE", ""):
            os.environ.pop("ORACLE_ADDRESS", None)
            os.environ.pop("MARKET_ADDRESS", None)
            with self.assertRaises(RuntimeError):
                verifier.BotContext(shared={})


if __name__ == "__main__":
    unittest.main()
