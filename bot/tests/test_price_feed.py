"""Unit tests for bot/price_feed.py — stdlib `unittest`, no network.

Run:  py -m unittest discover -s bot/tests -v
"""

import json
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


class _CountRaisingSource(price_feed.PriceSource):
    """Raises, but counts attempts (for retry-throttle tests)."""

    name = "count-raising"

    def __init__(self):
        self.calls = 0

    def fetch(self, _block):
        self.calls += 1
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

    def test_closed_market_logs_status_and_trade_time_at_debug(self):
        # Live shape (api.nasdaq.com, verified): `marketStatus` is a sibling of
        # `primaryData`; `lastTradeTimestamp` is nested inside it.
        body = json.dumps(
            {
                "data": {
                    "symbol": "SOXX",
                    "marketStatus": "Closed",
                    "assetClass": "ETF",
                    "primaryData": {
                        "lastSalePrice": "$514.71",
                        "lastTradeTimestamp": "Oct 20, 2026 4:00 PM",
                    },
                }
            }
        ).encode("utf-8")
        _patch_http(self, lambda url, headers=None, timeout=5: body)
        with self.assertLogs("irmarket-bot.price-feed", level="DEBUG") as logs:
            self.assertEqual(price_feed.NasdaqSource("SOXX", "etf").fetch(0), 514710000000000000000)
        self.assertIn("Closed", "\n".join(logs.output))
        self.assertIn("Oct 20, 2026", "\n".join(logs.output))

    def test_open_market_logs_nothing(self):
        body = json.dumps(
            {
                "data": {
                    "marketStatus": "Open",
                    "primaryData": {"lastSalePrice": "$514.71"},
                }
            }
        ).encode("utf-8")
        _patch_http(self, lambda url, headers=None, timeout=5: body)
        with self.assertNoLogs("irmarket-bot.price-feed", level="DEBUG"):
            self.assertEqual(price_feed.NasdaqSource("SOXX", "etf").fetch(0), 514710000000000000000)

    def test_closed_market_nested_in_primary_data_does_not_log(self):
        """Regression guard for the shape mix-up: a nested `marketStatus` is NOT
        the live location, so reading only `primaryData` would miss "Closed"."""
        body = json.dumps(
            {
                "data": {
                    "primaryData": {
                        "lastSalePrice": "$514.71",
                        "marketStatus": "Closed",
                    }
                }
            }
        ).encode("utf-8")
        _patch_http(self, lambda url, headers=None, timeout=5: body)
        with self.assertNoLogs("irmarket-bot.price-feed", level="DEBUG"):
            price_feed.NasdaqSource("SOXX", "etf").fetch(0)

    def test_missing_price_raises_for_fallback(self):
        body = json.dumps({"data": {"marketStatus": "Closed", "primaryData": {}}}).encode("utf-8")
        _patch_http(self, lambda url, headers=None, timeout=5: body)
        with self.assertRaises(ValueError):
            price_feed.NasdaqSource("SOXX", "etf").fetch(0)


# --------------------------------------------------------------------------- Yahoo


class YahooSourceTests(unittest.TestCase):
    def test_parses_regular_market_price(self):
        body = b'{"chart":{"result":[{"meta":{"regularMarketPrice":217.23}}]}}'
        _patch_http(self, lambda url, headers=None, timeout=5: body)
        self.assertEqual(price_feed.YahooSource("NVDA").fetch(0), 217230000000000000000)


# ------------------------------------------------------------------------- Nebius


_NEBIUS_BODY = json.dumps(
    {
        "items": [
            {
                "skuId": "sku-e00vd4x28cozliwb6g4vh",
                "productTitle": "Preemptible NVIDIA® B300 NVLink",
                "region": "eu-west2",
                "price": {"value": "9.19", "currency": "usd", "unitTitle": "GPU hour"},
            },
            {
                "skuId": "sku-e00em8l461xmyihec7sr8",
                "productTitle": "Preemptible NVIDIA® H200 NVLink",
                "region": "us-central1",
                "price": {"value": "0.79", "currency": "usd", "unitTitle": "GPU hour"},
            },
            {
                "skuId": "sku-e00hfg6dlxtt9ji6fqo9u",
                "productTitle": "Preemptible NVIDIA® B300 NVLink",
                "region": "us-north1",
                "price": {"value": "8.29", "currency": "usd", "unitTitle": "GPU hour"},
            },
        ],
        "snapshotTime": "2026-10-20T06:32:55.757339Z",
    }
).encode("utf-8")


class NebiusSourceTests(unittest.TestCase):
    def _feed(self, symbol):
        _patch_http(self, lambda url, headers=None, timeout=5: _NEBIUS_BODY)
        return price_feed.NebiusSource(symbol)

    def test_parses_lowest_across_regions(self):
        self.assertEqual(self._feed("B300").fetch(0), 8290000000000000000)

    def test_region_pin(self):
        self.assertEqual(self._feed("B300@eu-west2").fetch(0), 9190000000000000000)

    def test_region_pin_case_insensitive(self):
        self.assertEqual(self._feed("B300@EU-WEST2").fetch(0), 9190000000000000000)

    def test_other_gpu(self):
        self.assertEqual(self._feed("H200").fetch(0), 790000000000000000)

    def test_unknown_gpu_raises(self):
        with self.assertRaises(ValueError):
            self._feed("H100").fetch(0)

    def test_unknown_region_raises(self):
        with self.assertRaises(ValueError):
            self._feed("B300@mars-1").fetch(0)

    def test_empty_symbol_raises(self):
        with self.assertRaises(ValueError):
            price_feed.NebiusSource("")

    def test_empty_items_raises(self):
        _patch_http(self, lambda url, headers=None, timeout=5: b'{"items": []}')
        with self.assertRaises(ValueError):
            price_feed.NebiusSource("B300").fetch(0)

    def test_fx_applied(self):
        self.assertEqual(self._feed("B300").fetch(0) * 2, 16580000000000000000)

    def test_api_base_env_override(self):
        seen = {}

        def fake(url, headers=None, timeout=5):
            seen["url"] = url
            return _NEBIUS_BODY

        _patch_http(self, fake)
        with mock.patch.dict(os.environ, {"NEBIUS_API_BASE": "http://127.0.0.1:9/spot"}):
            price_feed.NebiusSource("B300").fetch(0)
        self.assertEqual(seen["url"], "http://127.0.0.1:9/spot")

    def test_malformed_item_does_not_abort_scan(self):
        body = json.dumps(
            {
                "items": [
                    {
                        "productTitle": "Preemptible NVIDIA® B300 NVLink",
                        "region": "eu-west2",
                        "price": {"value": "N/A"},
                    },
                    {
                        "productTitle": "Preemptible NVIDIA® B300 NVLink",
                        "region": "uk-south1",
                        "price": {"value": "7.30"},
                    },
                ]
            }
        ).encode("utf-8")
        _patch_http(self, lambda url, headers=None, timeout=5: body)
        self.assertEqual(price_feed.NebiusSource("B300").fetch(0), 7300000000000000000)


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


class SinaAShareSourceTests(unittest.TestCase):
    """A-shares (SSE/SZSE): field 3 is the last price, not field 6 like HK."""

    BODY_SH = (
        "var hq_str_sh600519=\"贵州茅台,1303.210,1309.690,1318.490,"
        "1322.000,1296.000,1318.080,1318.490,4249133,5576216948.000,...\";"
    ).encode("gbk")

    def test_parses_field_three(self):
        _patch_http(self, lambda url, headers=None, timeout=5: self.BODY_SH)
        self.assertEqual(price_feed.SinaSource("sh600519").fetch(0), 1318490000000000000000)

    def test_url_and_key_use_market_prefix(self):
        seen = {}

        def fake(url, headers=None, timeout=5):
            seen["url"] = url
            return self.BODY_SH

        _patch_http(self, fake)
        price_feed.SinaSource("sh600519").fetch(0)
        self.assertIn("/list=sh600519", seen["url"])

    def test_bare_code_defaults_to_hk(self):
        self.assertEqual(price_feed.SinaSource("02513").market, "hk")

    def test_empty_ticker_raises(self):
        with self.assertRaises(ValueError):
            price_feed.SinaSource("   ")

    def test_hk_alias_still_works(self):
        self.assertIs(price_feed.SinaHKSource, price_feed.SinaSource)


class TencentAShareSourceTests(unittest.TestCase):
    BODY_SH = (
        "v_sh600519=\"1~贵州茅台~600519~1318.49~1309.69~1303.21~42491~22341~20150~...\";"
    ).encode("gbk")

    def test_parses_field_three(self):
        _patch_http(self, lambda url, headers=None, timeout=5: self.BODY_SH)
        self.assertEqual(price_feed.TencentSource("sh600519").fetch(0), 1318490000000000000000)

    def test_url_and_key_use_market_prefix(self):
        seen = {}

        def fake(url, headers=None, timeout=5):
            seen["url"] = url
            return self.BODY_SH

        _patch_http(self, fake)
        price_feed.TencentSource("sh600519").fetch(0)
        self.assertIn("/q=sh600519", seen["url"])

    def test_sz_market_supported(self):
        body = 'v_sz000001="1~平安银行~000001~11.50~11.40~11.42~...";'.encode("gbk")
        _patch_http(self, lambda url, headers=None, timeout=5: body)
        self.assertEqual(price_feed.TencentSource("sz000001").fetch(0), 11500000000000000000)

    def test_hk_alias_still_works(self):
        self.assertIs(price_feed.TencentHKSource, price_feed.TencentSource)


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
        cache = price_feed.CachedSource(
            inner, ttl_seconds=0, max_staleness_seconds=3600, seed_wad=7 * WAD, outage_policy="seed"
        )
        self.assertEqual(cache.get(1), 42 * WAD)
        cache.inner = _RaisingSource()
        cache._at = time.time() - 4000
        with self.assertLogs("irmarket-bot.price-feed", level="ERROR"):
            self.assertEqual(cache.get(2), 7 * WAD)

    def test_never_raises_when_never_fetched(self):
        cache = price_feed.CachedSource(
            _RaisingSource(), ttl_seconds=0, seed_wad=9 * WAD, outage_policy="seed"
        )
        with self.assertLogs("irmarket-bot.price-feed", level="ERROR"):
            self.assertEqual(cache.get(1), 9 * WAD)

    # ---- outage policy (default halt) -------------------------------------

    def test_halt_raises_when_never_fetched(self):
        cache = price_feed.CachedSource(_RaisingSource(), ttl_seconds=0, seed_wad=9 * WAD)
        with self.assertRaises(price_feed.FeedOutageError):
            cache.get(1)

    def test_halt_raises_past_staleness_even_with_last_good(self):
        inner = _CountSource(42 * WAD)
        cache = price_feed.CachedSource(inner, ttl_seconds=0, max_staleness_seconds=3600, seed_wad=7 * WAD)
        self.assertEqual(cache.get(1), 42 * WAD)
        cache.inner = _RaisingSource()
        cache._at = time.time() - 4000
        with self.assertRaises(price_feed.FeedOutageError):
            cache.get(2)

    def test_seed_policy_zero_seed_raises(self):
        cache = price_feed.CachedSource(
            _RaisingSource(), ttl_seconds=0, seed_wad=0, outage_policy="seed"
        )
        with self.assertRaises(price_feed.FeedOutageError):
            cache.get(1)

    def test_policy_from_env(self):
        import os as _os
        from unittest import mock as _mock

        with _mock.patch.dict(_os.environ, {"PRICE_FEED_OUTAGE_POLICY": "seed"}):
            cache = price_feed.CachedSource(_RaisingSource(), ttl_seconds=0, seed_wad=3 * WAD)
            self.assertFalse(cache._halt_on_outage)
        with _mock.patch.dict(_os.environ, {"PRICE_FEED_OUTAGE_POLICY": "halt"}):
            cache = price_feed.CachedSource(_RaisingSource(), ttl_seconds=0, seed_wad=3 * WAD)
            self.assertTrue(cache._halt_on_outage)

    # ---- retry throttle (one fetch attempt per TTL window) -----------------

    def test_throttles_refetch_during_outage(self):
        inner = _CountSource(42 * WAD)
        cache = price_feed.CachedSource(inner, ttl_seconds=100, max_staleness_seconds=3600, seed_wad=7 * WAD)
        self.assertEqual(cache.get(1), 42 * WAD)
        cache.inner = _CountRaisingSource()
        # value + last attempt both 200s old: stale AND outside the throttle window
        cache._at = cache._last_attempt_at = time.time() - 200
        with self.assertLogs("irmarket-bot.price-feed", level="WARNING"):
            self.assertEqual(cache.get(2), 42 * WAD)  # attempt #1 fails -> last-good
        self.assertEqual(cache.inner.calls, 1)
        self.assertEqual(cache.get(3), 42 * WAD)  # throttled: NO new attempt
        self.assertEqual(cache.get(4), 42 * WAD)
        self.assertEqual(cache.inner.calls, 1)

    def test_throttle_window_expires(self):
        inner = _CountSource(42 * WAD)
        cache = price_feed.CachedSource(inner, ttl_seconds=0.05, max_staleness_seconds=3600, seed_wad=7 * WAD)
        self.assertEqual(cache.get(1), 42 * WAD)
        cache.inner = _CountRaisingSource()
        time.sleep(0.06)  # value stale AND throttle window expired
        with self.assertLogs("irmarket-bot.price-feed", level="WARNING"):
            self.assertEqual(cache.get(2), 42 * WAD)
        self.assertEqual(cache.inner.calls, 1)
        self.assertEqual(cache.get(3), 42 * WAD)  # throttled
        self.assertEqual(cache.inner.calls, 1)
        time.sleep(0.06)
        with self.assertLogs("irmarket-bot.price-feed", level="WARNING"):
            cache.get(4)
        self.assertEqual(cache.inner.calls, 2)  # window expired -> attempt again

    def test_throttled_outage_still_raises_halt(self):
        inner = _CountSource(42 * WAD)
        cache = price_feed.CachedSource(inner, ttl_seconds=100, max_staleness_seconds=0, seed_wad=7 * WAD)
        self.assertEqual(cache.get(1), 42 * WAD)
        cache.inner = _CountRaisingSource()
        cache._at = cache._last_attempt_at = time.time() - 200
        with self.assertRaises(price_feed.FeedOutageError):
            cache.get(2)  # attempt #1 fails, age 200 >= max 0 -> halt
        with self.assertRaises(price_feed.FeedOutageError):
            cache.get(3)  # throttled skip -> halt again, NO new attempt
        self.assertEqual(cache.inner.calls, 1)

    def test_throttled_ticks_do_not_log_errors(self):
        """A throttled tick repeats every poll (down to ~0.4s near expiry); it must
        not emit an ERROR per tick (that would be a log storm). Only the actual
        attempt logs loudly."""
        inner = _CountSource(42 * WAD)
        cache = price_feed.CachedSource(
            inner, ttl_seconds=100, max_staleness_seconds=0, seed_wad=7 * WAD, outage_policy="seed"
        )
        self.assertEqual(cache.get(1), 42 * WAD)
        cache.inner = _CountRaisingSource()
        cache._at = cache._last_attempt_at = time.time() - 200
        with self.assertLogs("irmarket-bot.price-feed", level="ERROR"):
            self.assertEqual(cache.get(2), 7 * WAD)  # real attempt -> ERROR
        with self.assertNoLogs("irmarket-bot.price-feed", level="ERROR"):
            for _ in range(20):
                self.assertEqual(cache.get(3), 7 * WAD)  # throttled -> silent
        self.assertEqual(cache.inner.calls, 1)


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

    def test_does_not_override_fetch(self):
        # The old `fetch` called `self.get`, an infinite-recursion trap if anyone
        # ever "unifies" get with the base _guard(self.fetch(...)) pattern.
        self.assertIs(
            price_feed.SyntheticWalkSource.fetch, price_feed.PriceSource.fetch
        )


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

    def test_moutai_a_share_selects_sina_then_tencent(self):
        with mock.patch.dict(os.environ, {"PRICE_FEED_ENABLED": "1"}):
            feed = price_feed.build_feed(_pair(price_source="sina", price_symbol="sh600519"))
        self.assertEqual([s.name for s in feed.inner.sources], ["sina", "tencent"])
        self.assertEqual(feed.inner.sources[0].market, "sh")
        self.assertEqual(feed.inner.sources[0].code, "600519")

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
