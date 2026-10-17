"""Unit tests for bot/price_feed.py — stdlib `unittest`, no network.

Run:  py -m unittest discover -s bot/tests -v
"""

import os
import sys
import time
import types
import unittest
from pathlib import Path
from unittest import mock

# Make `import price_feed` work regardless of the cwd / invocation.
BOT_DIR = Path(__file__).resolve().parent.parent
if str(BOT_DIR) not in sys.path:
    sys.path.insert(0, str(BOT_DIR))

import price_feed  # noqa: E402

WAD = price_feed.WAD


def _patch_http(test, fake):
    """Monkeypatch the module-level HTTP helper."""
    test.addCleanup(setattr, price_feed, "_http_get", price_feed._http_get)
    price_feed._http_get = fake


class _CountSource(price_feed.PriceSource):
    name = "count"

    def __init__(self, value):
        self.value = value
        self.calls = 0

    def fetch(self, _block):
        self.calls += 1
        return self.value


class _RaisingSource(price_feed.PriceSource):
    name = "raising"

    def fetch(self, _block):
        raise RuntimeError("boom")


class _EchoSource(price_feed.PriceSource):
    """Returns its value; records the url/headers it would have fetched."""

    def __init__(self, name, value):
        self.name = name
        self.value = value

    def fetch(self, _block):
        return self.value


# --------------------------------------------------------------------------- Nasdaq


class NasdaqSourceTests(unittest.TestCase):
    def _feed(self, last_sale):
        body = ('{"data":{"primaryData":{"lastSalePrice":"%s"}}}' % last_sale).encode("utf-8")
        _patch_http(self, lambda url, headers=None, timeout=5: body)
        return price_feed.NasdaqSource("SOXX", "etf")

    def test_parses_plain_price(self):
        self.assertEqual(self._feed("$514.71").fetch(0), 514710000000000000000)

    def test_parses_thousands_separator(self):
        self.assertEqual(self._feed("$1,394.83").fetch(0), 1394830000000000000000)

    def test_rejects_na(self):
        with self.assertRaises(ValueError):
            self._feed("N/A").fetch(0)

    def test_rejects_empty(self):
        with self.assertRaises(ValueError):
            self._feed("").fetch(0)


# --------------------------------------------------------------------------- Yahoo


class YahooSourceTests(unittest.TestCase):
    def test_parses_regular_market_price(self):
        body = b'{"chart":{"result":[{"meta":{"regularMarketPrice":217.23}}]}}'
        _patch_http(self, lambda url, headers=None, timeout=5: body)
        self.assertEqual(price_feed.YahooSource("NVDA").fetch(0), 217230000000000000000)


# --------------------------------------------------------------------------- HK


class SinaHKSourceTests(unittest.TestCase):
    def test_parses_field_six(self):
        body = (
            b'var hq_str_hk02513="Z.AI,x,529.000,513.500,541.500,513.500,'
            b'518.000,4.500,0.876,...";'
        )
        _patch_http(self, lambda url, headers=None, timeout=5: body)
        self.assertEqual(price_feed.SinaHKSource("02513").fetch(0), 518000000000000000000)

    def test_accepts_hk_prefixed_code(self):
        src = price_feed.SinaHKSource("hk02513")
        self.assertEqual(src.code, "02513")

    def test_gbk_bytes_decode_without_raising(self):
        body = (
            'var hq_str_hk02513="智谱科技,x,529.000,513.500,541.500,513.500,'
            '518.000,4.500,0.876,...";'
        ).encode("gbk")
        _patch_http(self, lambda url, headers=None, timeout=5: body)
        self.assertEqual(price_feed.SinaHKSource("02513").fetch(0), 518000000000000000000)

    def test_invalid_gbk_bytes_use_replace(self):
        body = (
            b'var hq_str_hk02513="'
            + b"\xff\xfe"
            + b',x,529.000,513.500,541.500,513.500,518.000,4.500,0.876,...";'
        )
        _patch_http(self, lambda url, headers=None, timeout=5: body)
        self.assertEqual(price_feed.SinaHKSource("02513").fetch(0), 518000000000000000000)


class TencentHKSourceTests(unittest.TestCase):
    def test_parses_field_three(self):
        body = b'v_hk02513="100~x~02513~518.000~513.500~529.000~...~HKD~...";'
        _patch_http(self, lambda url, headers=None, timeout=5: body)
        self.assertEqual(price_feed.TencentHKSource("02513").fetch(0), 518000000000000000000)

    def test_gbk_bytes_decode_without_raising(self):
        body = (
            'v_hk02513="100~智谱科技~02513~518.000~513.500~529.000~...~HKD~...";'
        ).encode("gbk")
        _patch_http(self, lambda url, headers=None, timeout=5: body)
        self.assertEqual(price_feed.TencentHKSource("hk02513").fetch(0), 518000000000000000000)


# --------------------------------------------------------------------- CachedSource


class CachedSourceTests(unittest.TestCase):
    def test_within_ttl_no_second_fetch(self):
        inner = _CountSource(42 * WAD)
        cache = price_feed.CachedSource(inner, ttl_seconds=1000, max_staleness_seconds=3600, seed_wad=0)
        self.assertEqual(cache.get(1), 42 * WAD)
        self.assertEqual(cache.get(2), 42 * WAD)
        self.assertEqual(inner.calls, 1)

    def test_past_ttl_refetches(self):
        inner = _CountSource(42 * WAD)
        cache = price_feed.CachedSource(inner, ttl_seconds=0, max_staleness_seconds=3600, seed_wad=0)
        cache.get(1)
        cache.get(2)
        self.assertEqual(inner.calls, 2)

    def test_all_down_within_max_returns_last_good(self):
        inner = _CountSource(42 * WAD)
        cache = price_feed.CachedSource(inner, ttl_seconds=0, max_staleness_seconds=3600, seed_wad=7 * WAD)
        self.assertEqual(cache.get(1), 42 * WAD)
        cache.inner = _RaisingSource()
        cache._at = time.time() - 10
        with self.assertLogs("irmarket-bot.price-feed", level="WARNING"):
            self.assertEqual(cache.get(2), 42 * WAD)

    def test_past_max_returns_seed_and_logs_error(self):
        inner = _CountSource(42 * WAD)
        cache = price_feed.CachedSource(inner, ttl_seconds=0, max_staleness_seconds=3600, seed_wad=7 * WAD)
        self.assertEqual(cache.get(1), 42 * WAD)
        cache.inner = _RaisingSource()
        cache._at = time.time() - 4000
        with self.assertLogs("irmarket-bot.price-feed", level="ERROR"):
            self.assertEqual(cache.get(2), 7 * WAD)

    def test_never_raises_when_never_fetched(self):
        cache = price_feed.CachedSource(_RaisingSource(), ttl_seconds=0, seed_wad=9 * WAD)
        with self.assertLogs("irmarket-bot.price-feed", level="ERROR"):
            self.assertEqual(cache.get(1), 9 * WAD)


# ------------------------------------------------------------------- FallbackSource


class FallbackSourceTests(unittest.TestCase):
    def test_primary_raises_secondary_returned(self):
        fb = price_feed.FallbackSource([_RaisingSource(), _EchoSource("secondary", 5 * WAD)])
        self.assertEqual(fb.get(0), 5 * WAD)

    def test_all_raise(self):
        fb = price_feed.FallbackSource([_RaisingSource(), _RaisingSource()])
        with self.assertRaises(RuntimeError):
            fb.get(0)


# ----------------------------------------------------------------- SyntheticWalk


class SyntheticWalkSourceTests(unittest.TestCase):
    def test_clamps_to_plus_minus_20_percent(self):
        seed = 100 * WAD
        src = price_feed.SyntheticWalkSource(seed, jitter_bps=8000)
        lo, hi = int(seed * 0.8), int(seed * 1.2)
        for _ in range(2000):
            value = src.get(0)
            self.assertGreaterEqual(value, lo)
            self.assertLessEqual(value, hi)

    def test_pricefeed_alias(self):
        self.assertIs(price_feed.PriceFeed, price_feed.SyntheticWalkSource)


# --------------------------------------------------------------------- build_feed


def _pair(**kw):
    base = dict(
        fair_price=100 * WAD,
        price_source="nasdaq",
        price_symbol="NVDA",
        asset_class="stocks",
        fx_quote_per_usd=None,
    )
    base.update(kw)
    return types.SimpleNamespace(**base)


class BuildFeedTests(unittest.TestCase):
    def test_disabled_returns_synthetic(self):
        with mock.patch.dict(os.environ, {"PRICE_FEED_ENABLED": "0"}):
            feed = price_feed.build_feed(_pair(price_source="nasdaq"))
        self.assertIsInstance(feed, price_feed.SyntheticWalkSource)

    def test_synthetic_source_returns_synthetic(self):
        with mock.patch.dict(os.environ, {"PRICE_FEED_ENABLED": "1"}):
            feed = price_feed.build_feed(_pair(price_source="synthetic"))
        self.assertIsInstance(feed, price_feed.SyntheticWalkSource)

    def test_unknown_source_returns_synthetic(self):
        with mock.patch.dict(os.environ, {"PRICE_FEED_ENABLED": "1"}):
            feed = price_feed.build_feed(_pair(price_source="bogus"))
        self.assertIsInstance(feed, price_feed.SyntheticWalkSource)

    def test_nasdaq_selects_nasdaq_with_yahoo_fallback(self):
        with mock.patch.dict(os.environ, {"PRICE_FEED_ENABLED": "1", "PRICE_FEED_FALLBACK": "1"}):
            feed = price_feed.build_feed(_pair(price_source="nasdaq"))
        self.assertIsInstance(feed, price_feed.CachedSource)
        self.assertIsInstance(feed.inner, price_feed.FallbackSource)
        self.assertEqual([s.name for s in feed.inner.sources], ["nasdaq", "yahoo"])

    def test_nasdaq_without_fallback(self):
        with mock.patch.dict(os.environ, {"PRICE_FEED_ENABLED": "1", "PRICE_FEED_FALLBACK": "0"}):
            feed = price_feed.build_feed(_pair(price_source="nasdaq"))
        self.assertEqual([s.name for s in feed.inner.sources], ["nasdaq"])

    def test_sina_selects_sina_then_tencent(self):
        with mock.patch.dict(os.environ, {"PRICE_FEED_ENABLED": "1"}):
            feed = price_feed.build_feed(_pair(price_source="sina", price_symbol="hk02513"))
        self.assertEqual([s.name for s in feed.inner.sources], ["sina", "tencent"])
        self.assertEqual(feed.inner.sources[0].code, "02513")

    def test_tencent_selects_tencent_then_sina(self):
        with mock.patch.dict(os.environ, {"PRICE_FEED_ENABLED": "1"}):
            feed = price_feed.build_feed(_pair(price_source="tencent", price_symbol="02513"))
        self.assertEqual([s.name for s in feed.inner.sources], ["tencent", "sina"])

    def test_yahoo_selects_yahoo(self):
        with mock.patch.dict(os.environ, {"PRICE_FEED_ENABLED": "1"}):
            feed = price_feed.build_feed(_pair(price_source="yahoo", price_symbol="NVDA"))
        self.assertIsInstance(feed, price_feed.CachedSource)
        self.assertIsInstance(feed.inner, price_feed.YahooSource)

    def test_hk_sources_ignore_global_fx(self):
        with mock.patch.dict(os.environ, {"PRICE_FEED_ENABLED": "1", "FX_QUOTE_PER_USD": "7.8"}):
            feed = price_feed.build_feed(_pair(price_source="sina", price_symbol="hk02513"))
        self.assertTrue(all(s.fx == 1.0 for s in feed.inner.sources), [s.fx for s in feed.inner.sources])

    def test_us_sources_honour_global_fx(self):
        with mock.patch.dict(os.environ, {"PRICE_FEED_ENABLED": "1", "FX_QUOTE_PER_USD": "7.8"}):
            feed = price_feed.build_feed(_pair(price_source="nasdaq"))
        self.assertTrue(all(s.fx == 7.8 for s in feed.inner.sources), [s.fx for s in feed.inner.sources])

    def test_hk_explicit_fx_escape_hatch(self):
        with mock.patch.dict(os.environ, {"PRICE_FEED_ENABLED": "1", "FX_QUOTE_PER_USD": "7.8"}):
            feed = price_feed.build_feed(
                _pair(price_source="sina", price_symbol="hk02513", fx_quote_per_usd=1.5)
            )
        self.assertTrue(all(s.fx == 1.5 for s in feed.inner.sources), [s.fx for s in feed.inner.sources])


class FxTests(unittest.TestCase):
    def test_fx_applied_before_wad(self):
        self.assertEqual(price_feed._to_wad(514.71, 1.0), 514710000000000000000)
        self.assertEqual(price_feed._to_wad(100.0, 7.8), 780000000000000000000)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
