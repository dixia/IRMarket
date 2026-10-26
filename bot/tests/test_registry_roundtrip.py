"""Registry round-trip tests for bot/verifier.py — stdlib `unittest`, no network.

`deployment-assets.json` is the bot's boot hint. Until 2026-10-26 nothing wrote
the rolled round back into it, so every restart resumed from an expired market,
walked the whole quote ledger (~60 s per pair) and re-created a market per pair
(7 wasted `createMarket` txs). `persist_round()` keeps `marketId`/`expiryBlock`
current; these tests pin the write, the no-op cases and the atomicity.

Run:  py -m unittest discover -s bot/tests -v
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

BOT_DIR = Path(__file__).resolve().parent.parent
if str(BOT_DIR) not in sys.path:
    sys.path.insert(0, str(BOT_DIR))

import verifier  # noqa: E402

REGISTRY = {
    "network": "monad-testnet",
    "chainId": 10143,
    "oracle": "0x0BC36e1ac475AdEF75F102deb1708BE6E45aA16f",
    "market": "0x05475037AE4e0717083737eDAc38590850968E7c",
    "quoteToken": "0x36448Ef080ba5fa251e1a9bd61782786f9e24F04",
    "assets": [
        {
            "symbol": "NVDA",
            "baseToken": "0xda9CF5A68cc2d8EFA5940db4094b6377D389DE17",
            "quoteToken": "0x36448Ef080ba5fa251e1a9bd61782786f9e24F04",
            "fairPrice": "230000000000000000000",
            "marketId": "1",
            "expiryBlock": "73772916",
            "priceSource": "nasdaq",
        },
        {
            "symbol": "DEEPSEEK",
            "baseToken": "0xbc25eF3e40B43806803a87c5CB2bbdA80b9b92d5",
            "quoteToken": "0x36448Ef080ba5fa251e1a9bd61782786f9e24F04",
            "fairPrice": "45000000000000000000",
            "marketId": "3",
            "expiryBlock": "73772916",
            "priceSource": "synthetic",
        },
    ],
}


class PersistRoundTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "deployment-assets.json")
        with open(self.path, "w", encoding="utf8") as f:
            json.dump(REGISTRY, f, indent=2)

    def tearDown(self):
        self.dir.cleanup()

    def _load(self):
        with open(self.path, encoding="utf8") as f:
            return json.load(f)

    def test_rolled_round_is_written_back(self):
        ok = verifier.persist_round("NVDA", 42, 74_000_000, self.path)
        self.assertTrue(ok)
        nvda = self._load()["assets"][0]
        self.assertEqual(nvda["marketId"], "42")
        self.assertEqual(nvda["expiryBlock"], "74000000")

    def test_other_assets_are_preserved(self):
        verifier.persist_round("NVDA", 42, 74_000_000, self.path)
        data = self._load()
        self.assertEqual(data["assets"][1]["symbol"], "DEEPSEEK")
        self.assertEqual(data["assets"][1]["marketId"], "3")
        self.assertEqual(data["oracle"], REGISTRY["oracle"])  # top level untouched

    def test_symbol_match_is_case_insensitive(self):
        self.assertTrue(verifier.persist_round("nvda", 43, 74_000_100, self.path))
        self.assertEqual(self._load()["assets"][0]["marketId"], "43")

    def test_unknown_symbol_is_a_noop(self):
        before = self._load()
        self.assertFalse(verifier.persist_round("GLM", 99, 1, self.path))
        self.assertEqual(self._load(), before)

    def test_missing_registry_is_a_noop(self):
        os.remove(self.path)
        self.assertFalse(verifier.persist_round("NVDA", 42, 74_000_000, self.path))

    def test_corrupt_registry_does_not_raise_or_clobber(self):
        with open(self.path, "w", encoding="utf8") as f:
            f.write("{not json")
        self.assertFalse(verifier.persist_round("NVDA", 42, 74_000_000, self.path))
        with open(self.path, encoding="utf8") as f:
            self.assertEqual(f.read(), "{not json")

    def test_write_leaves_no_tmp_file(self):
        verifier.persist_round("NVDA", 42, 74_000_000, self.path)
        leftovers = [p for p in os.listdir(self.dir.name) if p.endswith(".tmp")]
        self.assertEqual(leftovers, [])

    def test_round_trip_is_what_the_bot_reads_on_boot(self):
        verifier.persist_round("NVDA", 42, 74_000_000, self.path)
        with unittest.mock.patch.dict(os.environ, {"BOT_SKIP_SYMBOLS": ""}):
            shared, pairs = verifier.load_asset_configs(self.path)
        self.assertEqual(shared["oracle"], REGISTRY["oracle"])
        self.assertEqual(pairs[0].market_id, 42)
        self.assertEqual(pairs[0].expiry_block, 74_000_000)


    def test_registry_currencies_reach_pair_config(self):
        with open(self.path, "w", encoding="utf8") as f:
            data = json.loads(json.dumps(REGISTRY))
            data["assets"][0]["quoteSymbol"] = "HKD"
            data["assets"][0]["priceCurrency"] = "USD"
            data["assets"][1]["quoteSymbol"] = "USD"
            data["assets"][1]["priceCurrency"] = "USD"
            json.dump(data, f)
        with unittest.mock.patch.dict(os.environ, {"BOT_SKIP_SYMBOLS": ""}):
            _shared, pairs = verifier.load_asset_configs(self.path)
        self.assertEqual((pairs[0].price_currency, pairs[0].quote_currency), ("USD", "HKD"))
        self.assertEqual((pairs[1].price_currency, pairs[1].quote_currency), ("USD", "USD"))


class DefaultAssetSetTest(unittest.TestCase):
    """The demo set is MOUTAI + ASHR + DEEPSEEK + B300 (B300 is the only GPU)."""

    def test_deploy_default_assets(self):
        js = (BOT_DIR.parent / "script" / "deploy-market-stack.js").read_text(encoding="utf8")
        line = next(l for l in js.splitlines() if "process.env.ASSETS" in l)
        for keep in ("MOUTAI:1500:HKD", "DEEPSEEK:45:HKD", "ASHR:27:USD", "B300:4.39:USD"):
            self.assertIn(keep, line)
        for gone in ("NVDA", "GLM", "B200", "H200", "H100", "SNDK", "SOXX"):
            self.assertNotIn(gone, line)

    def test_ashr_has_a_real_price_descriptor(self):
        js = (BOT_DIR.parent / "script" / "deploy-market-stack.js").read_text(encoding="utf8")
        line = next(l for l in js.splitlines() if l.strip().startswith("ASHR:"))
        self.assertIn("nasdaq", line)
        self.assertIn('"ASHR"', line)


if __name__ == "__main__":
    import unittest.mock  # noqa: F401  (used above under the if-main path)

    unittest.main()
