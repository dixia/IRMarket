"""FX conversion + cross-currency feed tests — stdlib `unittest`, no network.

The product quotes each asset in its native unit (USD for US feeds, HKD for
CN/HK feeds; CNY is registered as HKD). When a market's quote token is the
*other* currency, the bot converts with a live USD↔HKD rate (`FxProvider`).

Pinned here:
  * same currency → 1.0, **no network call** (the normal case);
  * USD→HKD and HKD→USD are the same rate inverted;
  * the rate is cached for `FX_TTL_SECONDS` (one fetch per TTL);
  * a failed refresh keeps the last good rate until `FX_MAX_STALENESS_SECONDS`,
    then raises `FeedOutageError` — never quote off a stale rate;
  * a refresh > `FX_MAX_DEVIATION` away from the last good is rejected;
  * `FX_STATIC=1` pins the rate and never fetches;
  * `build_feed` wraps the feed in `FxSource` exactly when the currencies differ.

Run:  py -m unittest discover -s bot/tests -v
"""

import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

BOT_DIR = Path(__file__).resolve().parent.parent
if str(BOT_DIR) not in sys.path:
    sys.path.insert(0, str(BOT_DIR))

import price_feed  # noqa: E402

WAD = price_feed.WAD


def _payload(hkd):
    return json.dumps({"result": "success", "rates": {"HKD": hkd}}).encode()


class FxProviderTest(unittest.TestCase):
    def setUp(self):
        self.p = price_feed.FxProvider()
        self.env = mock.patch.dict(os.environ, {"FX_API_URL": "https://fx.test/latest"})
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def test_same_currency_short_circuits_without_network(self):
        with mock.patch.object(price_feed, "_http_get") as http:
            self.assertEqual(self.p.rate("USD", "USD"), 1.0)
            self.assertEqual(self.p.rate("HKD", "HKD"), 1.0)
            http.assert_not_called()

    def test_usd_to_hkd_and_back(self):
        with mock.patch.object(price_feed, "_http_get", return_value=_payload(7.8)):
            self.assertAlmostEqual(self.p.rate("USD", "HKD"), 7.8)
            self.assertAlmostEqual(self.p.rate("HKD", "USD"), 1 / 7.8)

    def test_rate_is_cached_for_the_ttl(self):
        with mock.patch.object(price_feed, "_http_get", return_value=_payload(7.8)) as http:
            self.p.rate("USD", "HKD")
            self.p.rate("USD", "HKD")
            self.p.rate("HKD", "USD")
            self.assertEqual(http.call_count, 1, "one fetch per TTL window")

    def test_failed_refresh_uses_last_good_until_staleness(self):
        with mock.patch.object(price_feed, "_http_get", return_value=_payload(7.8)):
            self.p.rate("USD", "HKD")
        self.p._at -= 100  # past the TTL, well inside max staleness
        with mock.patch.object(price_feed, "_http_get", side_effect=OSError("down")):
            self.assertAlmostEqual(self.p.rate("USD", "HKD"), 7.8)

    def test_outage_past_staleness_refuses_to_quote(self):
        with mock.patch.object(price_feed, "_http_get", return_value=_payload(7.8)):
            self.p.rate("USD", "HKD")
        self.p._at -= 10**6  # way past FX_MAX_STALENESS_SECONDS
        with mock.patch.object(price_feed, "_http_get", side_effect=OSError("down")):
            with self.assertRaises(price_feed.FeedOutageError):
                self.p.rate("USD", "HKD")

    def test_no_previous_rate_and_outage_is_an_outage(self):
        with mock.patch.object(price_feed, "_http_get", side_effect=OSError("down")):
            with self.assertRaises(price_feed.FeedOutageError):
                self.p.rate("USD", "HKD")

    def test_deviation_guard_keeps_the_last_good_rate(self):
        with mock.patch.object(price_feed, "_http_get", return_value=_payload(7.8)):
            self.p.rate("USD", "HKD")
        self.p._at -= 1000  # TTL passed, staleness not
        with mock.patch.object(price_feed, "_http_get", return_value=_payload(100.0)):
            self.assertAlmostEqual(self.p.rate("USD", "HKD"), 7.8, msg="200%+ jump is rejected")

    def test_static_mode_never_fetches(self):
        with mock.patch.dict(os.environ, {"FX_STATIC": "1", "FX_HKD_PER_USD": "7.5"}):
            with mock.patch.object(price_feed, "_http_get") as http:
                self.assertAlmostEqual(self.p.rate("USD", "HKD"), 7.5)
                http.assert_not_called()

    def test_unsupported_currency_pair_raises(self):
        with mock.patch.object(price_feed, "_http_get", return_value=_payload(7.8)):
            with self.assertRaises(ValueError):
                self.p.rate("USD", "CNY")


class _Pair:
    """Minimal PairConfig stand-in."""

    def __init__(self, **kw):
        self.fair_price = 1 * WAD
        self.price_source = "nasdaq"
        self.price_symbol = "ASHR"
        self.asset_class = "etf"
        self.symbol = "ASHR"
        self.fx_quote_per_usd = None
        self.price_currency = None
        self.quote_currency = None
        for k, v in kw.items():
            setattr(self, k, v)


class FxSourceTest(unittest.TestCase):
    def test_conversion_is_applied_per_fetch(self):
        provider = price_feed.FxProvider()
        inner = mock.Mock()
        inner.get.return_value = 100 * WAD
        src = price_feed.FxSource(inner, provider, "USD", "HKD")
        with mock.patch.object(provider, "rate", return_value=7.8):
            self.assertEqual(src.fetch(1), 780 * WAD)

    def test_same_currency_returns_the_inner_value_untouched(self):
        provider = price_feed.FxProvider()
        inner = mock.Mock()
        inner.get.return_value = 123 * WAD
        src = price_feed.FxSource(inner, provider, "HKD", "HKD")
        self.assertEqual(src.fetch(1), 123 * WAD)

    def test_build_feed_wraps_only_when_the_currencies_differ(self):
        with mock.patch.dict(os.environ, {"PRICE_FEED_ENABLED": "1"}):
            usd_market = price_feed.build_feed(
                _Pair(price_currency="USD", quote_currency="USD")
            )
            cross = price_feed.build_feed(
                _Pair(price_currency="USD", quote_currency="HKD")
            )
        self.assertIsInstance(usd_market.inner, price_feed.FallbackSource)
        self.assertIsInstance(cross.inner, price_feed.FxSource)
        self.assertEqual((cross.inner.native, cross.inner.quote), ("USD", "HKD"))

    def test_explicit_fx_overrides_the_live_rate(self):
        with mock.patch.dict(os.environ, {"PRICE_FEED_ENABLED": "1"}):
            feed = price_feed.build_feed(
                _Pair(price_currency="USD", quote_currency="HKD", fx_quote_per_usd=7.0)
            )
        self.assertIsInstance(feed.inner, price_feed.FallbackSource, "static fx keeps the old path")


if __name__ == "__main__":
    unittest.main()
