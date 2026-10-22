"""Real, free price feeds for the IRMarket verifier bot.

Stdlib only (``urllib``/``json``/``gzip``/``logging``/``time``/``random``/``os``/``math``)
so the adapters are unit-testable without installing ``web3``/``requests``.

Design (see ``docs/design/bot-real-price-feed-spec.md`` §5):

  * ``PriceSource`` — base/protocol; ``get(block)`` returns a 1e18 WAD ``int``.
  * ``SyntheticWalkSource`` — the legacy bounded random walk (±20% of the static
    seed). The ONLY source that clamps.
  * ``NasdaqSource`` / ``YahooSource`` — US equities/ETF (Nasdaq primary, Yahoo
    backdrop).
  * ``NebiusSource`` — Nebius spot (preemptible) GPU prices, USD per GPU-hour,
    from the unauthenticated API behind nebius.com/spot-prices.
  * ``SinaSource`` / ``TencentSource`` — CN quotes for HK **and** A-shares
    (`hk02513`, `sh600519`, `sz000001`); HK prices are HKD, A-shares CNY
    (both used nominally in the demo's "HKD" quote unit).
  * ``FallbackSource`` — try sources in order, first success wins.
  * ``CachedSource`` — TTL cache + last-good + staleness guard. On a total outage
    (no last-good, or last-good older than ``PRICE_FEED_MAX_STALENESS_SECONDS``)
    the outage policy applies (default ``halt`` = raise :class:`FeedOutageError`;
    ``seed`` = legacy fallback to the ``fairPrice`` seed).

Real sources BYPASS the ±20% clamp. Instead a sanity band rejects non-finite /
``<= 0`` / absurd WAD values, and an implausible jump is logged as a WARNING but
still returned (a real jump is information, not an error).

``bot/verifier.py`` builds a feed with :func:`build_feed` and polls
``feed.get(block)`` — the legacy synthetic contract is preserved.
"""

import gzip
import json
import logging
import math
import os
import random
import time
import urllib.request
from decimal import ROUND_HALF_UP, Decimal

WAD = 10**18

log = logging.getLogger("irmarket-bot.price-feed")

_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

_DEFAULT_NASDAQ_BASE = "https://api.nasdaq.com/api/quote"
_DEFAULT_YAHOO_BASE = "https://query1.finance.yahoo.com"
_DEFAULT_NEBIUS_BASE = "https://api.nebius.cloud/billing/v1alpha1/spot-price"
_DEFAULT_SINA_BASE = "https://hq.sinajs.cn"
_DEFAULT_TENCENT_BASE = "https://qt.gtimg.cn"


# --------------------------------------------------------------------------- env


def _env_float(name: str, default: float) -> float:
    """Read a float env var at call time (so tests can monkeypatch)."""
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return float(default)
    try:
        return float(raw)
    except ValueError:
        return float(default)


def _env_int(name: str, default: int) -> int:
    return int(_env_float(name, float(default)))


def _to_wad(price: float, fx: float = 1.0) -> int:
    """Convert a quoted price to 1e18 WAD, applying the quote-per-USD FX factor.

    Uses ``Decimal`` (stdlib) rather than binary-float multiplication so that
    e.g. ``514.71`` maps to exactly ``514710000000000000000`` instead of the
    nearest double (``…0065536``)."""
    scaled = Decimal(str(price)) * Decimal(str(fx)) * Decimal(WAD)
    return int(scaled.to_integral_value(rounding=ROUND_HALF_UP))


def _clean_number(text) -> float:
    """Parse a numeric price string, stripping ``$`` and thousands separators.

    Rejects ``None``/empty/``N/A``/non-finite/non-positive values by raising
    ``ValueError`` so the fallback chain can advance."""
    if text is None:
        raise ValueError("empty price")
    s = str(text).strip().replace("$", "").replace(",", "").replace(" ", "")
    if not s:
        raise ValueError("empty price")
    try:
        value = float(s)
    except ValueError as e:
        raise ValueError(f"unparseable price: {text!r}") from e
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"non-finite/non-positive price: {text!r}")
    return value


def _market_code(symbol: str) -> tuple[str, str]:
    """Split a CN/HK ticker into ``(market, code)``.

    Accepts an explicit market prefix — ``hk02513`` (HKEX), ``sh600519`` /
    ``sz000001`` (SSE/SZSE A-shares) — and defaults to ``hk`` for a bare code
    (the historical behaviour: ``"02513"`` == ``"hk02513"``)."""
    s = str(symbol).strip()
    low = s.lower()
    for market in ("sh", "sz", "hk"):
        if low.startswith(market) and len(s) > len(market):
            return market, s[len(market):]
    if not s:
        raise ValueError("empty ticker")
    return "hk", s


# --------------------------------------------------------------------------- http


def _http_get(url: str, headers: dict, timeout: float = 5) -> bytes:
    """GET ``url`` with urllib, transparently gunzipping the response.

    Returns raw bytes or raises (callers are expected to catch). Network access
    is never performed at import time."""
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
        encoding = (resp.headers.get("Content-Encoding") or "").lower()
        if "gzip" in encoding or data[:2] == b"\x1f\x8b":
            data = gzip.decompress(data)
        return data


# --------------------------------------------------------------------------- base


class PriceSource:
    """Base feed source. ``fetch(block)`` may raise; the default ``get(block)``
    applies the real-source sanity band + jump warning and returns a WAD int.

    ``_last`` (instance-level, created lazily in ``_guard``) tracks the previous
    value for the jump check, so subclasses need no ``__init__`` cooperation and
    no shared-class-attribute footgun."""

    name = "source"

    def fetch(self, block: int) -> int:  # pragma: no cover - abstract
        raise NotImplementedError

    def get(self, block: int) -> int:
        return self._guard(self.fetch(block))

    def _guard(self, value: int) -> int:
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError(f"{self.name}: non-finite price")
        if value is None or value <= 0:
            raise ValueError(f"{self.name}: non-positive price {value!r}")
        sanity_max = int(_env_float("PRICE_SANITY_MAX", 1e9) * WAD)
        if value > sanity_max:
            raise ValueError(f"{self.name}: price {value} exceeds sanity max {sanity_max}")
        last = self.__dict__.setdefault("_last", None)
        if last:
            jump_bps = abs(value - last) * 10_000.0 / last
            if jump_bps > _env_float("PRICE_MAX_JUMP_BPS", 5000):
                log.warning(
                    "%s: implausible jump %.0f bps vs last %s (warn only, value kept)",
                    self.name, jump_bps, last,
                )
        self._last = value
        return value


# --------------------------------------------------------------------- synthetic


class SyntheticWalkSource(PriceSource):
    """Legacy demo feed: a bounded random walk around the configured base price
    so the quoted (canonical) price visibly moves.

    Jitter band is ``PRICE_JITTER_BPS`` (default 300 = ±3%), clamped to ±20% of
    the static base. This is the ONLY source with a clamp."""

    name = "synthetic"

    def __init__(self, fair_price: int, jitter_bps=None):
        self.fair = int(fair_price)
        self.current = int(fair_price)
        jitter = _env_int("PRICE_JITTER_BPS", 300) if jitter_bps is None else int(jitter_bps)
        self.jitter = jitter / 10_000

    def get(self, _block: int) -> int:
        if self.jitter > 0:
            self.current = int(self.current * (1 + random.uniform(-self.jitter, self.jitter)))
            lo, hi = int(self.fair * 0.8), int(self.fair * 1.2)
            self.current = max(lo, min(hi, self.current))
        return self.current


# Backward-compat name: some callers import ``PriceFeed``.
PriceFeed = SyntheticWalkSource


# --------------------------------------------------------------------- US feeds


class NasdaqSource(PriceSource):
    """Nasdaq (unofficial) quote: ``/api/quote/{symbol}/info?assetclass=…``."""

    name = "nasdaq"

    def __init__(self, symbol: str, asset_class: str = "stocks", fx: float = None):
        self.symbol = symbol
        self.asset_class = asset_class or "stocks"
        self.fx = 1.0 if fx is None else float(fx)

    def fetch(self, _block: int) -> int:
        base = os.getenv("NASDAQ_API_BASE", _DEFAULT_NASDAQ_BASE)
        url = f"{base}/{self.symbol}/info?assetclass={self.asset_class}"
        headers = {"User-Agent": _BROWSER_UA, "Accept": "application/json"}
        raw = _http_get(url, headers)
        data = json.loads(raw.decode("utf-8", "replace"))
        payload = data.get("data") or {}
        primary = payload.get("primaryData") or {}
        price = _clean_number(primary.get("lastSalePrice"))
        # Market-status context (spec §5.3): outside trading hours the last sale is
        # a valid frozen mark, but a frozen price must be distinguishable from a
        # stuck feed when explaining a demo — log it at DEBUG, with the trade time.
        # `marketStatus` is a SIBLING of `primaryData` in the live response
        # (`lastTradeTimestamp` is the one nested inside it):
        #   {"data": {"primaryData": {...}, "marketStatus": "Closed", ...}}
        status = (payload.get("marketStatus") or "").strip()
        if status and status.lower() != "open":
            log.debug(
                "nasdaq %s: market %s, last sale %s (%s)",
                self.symbol, status, primary.get("lastSalePrice"), primary.get("lastTradeTimestamp"),
            )
        return _to_wad(price, self.fx)


class YahooSource(PriceSource):
    """Yahoo Finance chart (unofficial) — the US backdrop/fallback feed."""

    name = "yahoo"

    def __init__(self, symbol: str, fx: float = None):
        self.symbol = symbol
        self.fx = 1.0 if fx is None else float(fx)

    def fetch(self, _block: int) -> int:
        base = os.getenv("YAHOO_API_BASE", _DEFAULT_YAHOO_BASE)
        url = f"{base}/v8/finance/chart/{self.symbol}?interval=1d&range=1d"
        headers = {"User-Agent": _BROWSER_UA, "Accept": "application/json"}
        raw = _http_get(url, headers)
        data = json.loads(raw.decode("utf-8", "replace"))
        price = _clean_number(data["chart"]["result"][0]["meta"]["regularMarketPrice"])
        return _to_wad(price, self.fx)


# ----------------------------------------------------------------- GPU spot feeds


class NebiusSource(PriceSource):
    """Nebius spot (preemptible) GPU prices — the JSON API behind
    https://nebius.com/spot-prices (unauthenticated, no key).

    ``symbol`` is a GPU model (``B300``, ``B200``, ``H200``, ``H100``,
    ``RTX PRO 6000``), optionally pinned to one region with ``@``:
    ``B300@us-central1``. Unpinned takes the LOWEST spot across regions —
    the site's headline "current spot price".

    Prices are USD per GPU-hour; ``fx`` (the usual US-source factor) applies.
    """

    name = "nebius"

    def __init__(self, symbol: str, fx: float = None):
        self.symbol, self.region = self._split(symbol)
        self.fx = 1.0 if fx is None else float(fx)

    @staticmethod
    def _split(symbol: str):
        gpu, _, region = (symbol or "").partition("@")
        gpu = gpu.strip()
        region = region.strip().lower() or None
        if not gpu:
            raise ValueError("nebius: empty GPU model")
        return gpu, region

    def fetch(self, _block: int) -> int:
        base = os.getenv("NEBIUS_API_BASE", _DEFAULT_NEBIUS_BASE)
        headers = {"User-Agent": _BROWSER_UA, "Accept": "application/json"}
        raw = _http_get(base, headers)
        data = json.loads(raw.decode("utf-8", "replace"))
        want = self.symbol.lower()
        best = None
        for item in data.get("items") or []:
            if want not in (item.get("productTitle") or "").lower():
                continue
            if self.region and (item.get("region") or "").lower() != self.region:
                continue
            try:
                price = _clean_number((item.get("price") or {}).get("value"))
            except ValueError:
                continue  # a malformed SKU row must not kill the whole scan
            if best is None or price < best:
                best = price
        if best is None:
            raise ValueError(
                f"nebius: no spot price for {self.symbol}" + (f"@{self.region}" if self.region else "")
            )
        return _to_wad(best, self.fx)


# --------------------------------------------------------------------- HK feeds


class SinaSource(PriceSource):
    """Sina (unofficial) CN quote: ``/list={market}{code}`` -> ``var hq_str_{market}{code}="…"``.

    Field layout differs by market: A-shares (``sh``/``sz``) put the last price at
    field **3**; HK puts it at field **6**. The response is GBK."""

    name = "sina"

    def __init__(self, code: str, fx: float = None):
        self.market, self.code = _market_code(code)
        self.fx = 1.0 if fx is None else float(fx)

    @property
    def _field(self) -> int:
        return 3 if self.market in ("sh", "sz") else 6

    def fetch(self, _block: int) -> int:
        base = os.getenv("SINA_API_BASE", _DEFAULT_SINA_BASE)
        ticker = f"{self.market}{self.code}"
        url = f"{base}/list={ticker}"
        headers = {"User-Agent": _BROWSER_UA, "Referer": "https://finance.sina.com.cn"}
        raw = _http_get(url, headers)
        text = raw.decode("gbk", "replace")
        key = f'hq_str_{ticker}="'
        idx = text.find(key)
        if idx < 0:
            raise ValueError(f"sina: field {key!r} not found")
        payload = text[idx + len(key):].split('"', 1)[0]
        fields = payload.split(",")
        field = self._field
        if len(fields) <= field:
            raise ValueError(f"sina: expected >{field + 1} fields, got {len(fields)}")
        return _to_wad(_clean_number(fields[field]), self.fx)


class TencentSource(PriceSource):
    """Tencent (unofficial) CN quote: ``/q={market}{code}`` -> ``v_{market}{code}="…"``.

    Field 3 (``~``-split) is the last price for both HK and A-shares; the response
    is GBK."""

    name = "tencent"

    def __init__(self, code: str, fx: float = None):
        self.market, self.code = _market_code(code)
        self.fx = 1.0 if fx is None else float(fx)

    def fetch(self, _block: int) -> int:
        base = os.getenv("TENCENT_API_BASE", _DEFAULT_TENCENT_BASE)
        ticker = f"{self.market}{self.code}"
        url = f"{base}/q={ticker}"
        headers = {"User-Agent": _BROWSER_UA, "Referer": "https://gu.qq.com"}
        raw = _http_get(url, headers)
        text = raw.decode("gbk", "replace")
        key = f'v_{ticker}="'
        idx = text.find(key)
        if idx < 0:
            raise ValueError(f"tencent: field {key!r} not found")
        payload = text[idx + len(key):].split('"', 1)[0]
        fields = payload.split("~")
        if len(fields) <= 3:
            raise ValueError(f"tencent: expected ≥4 fields, got {len(fields)}")
        return _to_wad(_clean_number(fields[3]), self.fx)


# Historical names (HK-only) kept so existing imports/tests keep working.
SinaHKSource = SinaSource
TencentHKSource = TencentSource


# ------------------------------------------------------------------- aggregation


class FallbackSource(PriceSource):
    """Try each source in order; first success wins. Raises the last error if
    every source fails."""

    name = "fallback"

    def __init__(self, sources):
        self.sources = list(sources)

    def fetch(self, block: int) -> int:
        last_err = None
        for src in self.sources:
            try:
                return src.get(block)
            except Exception as e:  # noqa: BLE001 - any failure -> try next
                last_err = e
                log.warning("source %s failed: %s", getattr(src, "name", src), e)
        if last_err is not None:
            raise last_err
        raise RuntimeError("fallback: no sources configured")


class FeedOutageError(RuntimeError):
    """No usable price is available.

    Raised (default outage policy ``halt``) when the feed is down and there is
    nothing legitimate to return: never-fetched, or last-good older than
    ``PRICE_FEED_MAX_STALENESS_SECONDS``. Callers must NOT quote off a stale
    ``fairPrice`` seed — a 15x-off mark is instantly veto-arbitraged. Use
    ``PRICE_FEED_OUTAGE_POLICY=seed`` to restore the legacy seed fallback."""


class CachedSource(PriceSource):
    """TTL cache + last-good + staleness guard around an inner source.

    * fresh (age < ttl)        -> cached value, no fetch
    * age ≥ ttl                -> refetch; on success update cache
    * all sources error        -> if age < max_staleness: last-good + WARNING
                                  else: outage policy:
                                    - ``halt`` (default): raise FeedOutageError
                                    - ``seed``: seed_wad + ERROR (legacy; the
                                      seed MUST be refreshed to real values)
    * retry throttle: at most ONE fetch attempt per TTL window — ``age`` tracks
      the last success, so during an outage every poll would otherwise hit the
      network (a 429 storm that prolongs the outage)
    * a zero/absent seed under the ``seed`` policy also raises (a zero mark
      silently mints a zero quote amount)."""

    name = "cached"

    def __init__(
        self,
        inner,
        ttl_seconds=None,
        max_staleness_seconds=None,
        seed_wad=0,
        logger=None,
        outage_policy=None,
    ):
        self.inner = inner
        self._ttl_s = None if ttl_seconds is None else float(ttl_seconds)
        self._max_s = None if max_staleness_seconds is None else float(max_staleness_seconds)
        self.seed = int(seed_wad)
        self._value = None
        self._at = 0.0  # last SUCCESSFUL fetch (drives freshness/staleness)
        self._last_attempt_at = 0.0  # last fetch ATTEMPT (drives retry throttling)
        self._log = logger or globals()["log"]
        policy = outage_policy if outage_policy is not None else os.getenv(
            "PRICE_FEED_OUTAGE_POLICY", "halt"
        )
        self._halt_on_outage = str(policy).strip().lower() != "seed"

    def _ttl(self) -> float:
        return self._ttl_s if self._ttl_s is not None else _env_float("PRICE_FEED_TTL_SECONDS", 60)

    def _max(self) -> float:
        if self._max_s is not None:
            return self._max_s
        return _env_float("PRICE_FEED_MAX_STALENESS_SECONDS", 3600)

    def _outage(self, age, error=None, throttled: bool = False) -> int:
        """No usable price: no last-good, or last-good beyond staleness.

        Throttled ticks only log at DEBUG: they repeat every poll (down to
        ~0.4 s near expiry) and the caller already reports the outcome — an
        ERROR per tick would be a log storm with no new information."""
        loud = not throttled
        if self._halt_on_outage:
            (self._log.error if loud else self._log.debug)(
                "price feed down %s — refusing to quote (outage policy=halt)%s",
                f"(last {age:.0f}s ago) " if age is not None else "(nothing fetched yet) ",
                f": {error}" if error is not None else " (retry throttled)",
            )
            raise FeedOutageError(
                f"no usable price: feed down {f'{age:.0f}s' if age is not None else 'since start'}"
            ) from error
        if self.seed <= 0:
            if loud:
                self._log.error("price feed down and seed unusable (%s) — cannot price", self.seed)
            raise FeedOutageError(f"no usable price: feed down and seed={self.seed}") from error
        (self._log.error if loud else self._log.debug)(
            "price feed down beyond staleness — using seed (outage policy=seed)%s",
            "" if loud else " (retry throttled)",
        )
        return self.seed

    def get(self, block: int) -> int:
        now = time.time()
        have = self._value is not None
        age = (now - self._at) if have else None
        if have and age < self._ttl():
            return self._value
        # Retry throttle: `age` tracks the last SUCCESS, so during an outage it
        # stays >= ttl forever — without this every poll (and every near-expiry
        # tick, ~0.4 s) would hit the network, i.e. a 429 storm that prolongs the
        # very outage it reacts to. At most one fetch attempt per TTL window.
        if now - self._last_attempt_at < self._ttl():
            if have and age < self._max():
                self._log.debug("stale price (age %.0fs) — retry throttled, using last-good", age)
                return self._value
            return self._outage(age, throttled=True)
        self._last_attempt_at = now
        try:
            value = self.inner.get(block)
            self._value = value
            self._at = now
            return value
        except Exception as e:  # noqa: BLE001 - non-outage failures stay internal
            if have and age < self._max():
                self._log.warning("stale price (age %.0fs) — using last-good: %s", age, e)
                return self._value
            # Total outage: no last-good, or last-good beyond staleness.
            return self._outage(age, error=e)


# ----------------------------------------------------------------------- factory


def _effective_fx(pair) -> float:
    """US-source FX: explicit per-asset value, else the global ``FX_QUOTE_PER_USD``."""
    fx = getattr(pair, "fx_quote_per_usd", None)
    if fx is None:
        return _env_float("FX_QUOTE_PER_USD", 1.0)
    return float(fx)


def _local_fx(pair) -> float:
    """CN/HK-source FX: always 1.0 (GLM/02513.HK is HKD; A-shares are CNY — the
    demo quote unit is nominal, so neither is converted). An explicit per-asset
    ``fx_quote_per_usd`` is honoured as an escape hatch; the global
    ``FX_QUOTE_PER_USD`` is deliberately ignored."""
    fx = getattr(pair, "fx_quote_per_usd", None)
    return 1.0 if fx is None else float(fx)


def build_feed(pair, logger=None):
    """Build a price source for ``pair``.

    ``pair`` may be a ``PairConfig`` (or any object with the same attributes):
    ``fair_price``, ``price_source``, ``price_symbol``, ``asset_class``,
    ``fx_quote_per_usd``. Attributes are read with ``getattr`` defaults so the
    legacy single-pair config keeps working.

    ``PRICE_FEED_ENABLED != "1"`` (or a synthetic/blank source) yields the legacy
    :class:`SyntheticWalkSource`; unknown sources also fall back to synthetic.
    """
    logger = logger or globals()["log"]
    fair = int(getattr(pair, "fair_price", 0) or 0)

    def synthetic():
        return SyntheticWalkSource(fair)

    if os.getenv("PRICE_FEED_ENABLED", "0") != "1":
        return synthetic()

    source = (getattr(pair, "price_source", None) or "").strip().lower()
    if source in ("", "synthetic", "auto-with-no-symbol"):
        return synthetic()

    us_fx = _effective_fx(pair)
    local_fx = _local_fx(pair)
    fallback_on = os.getenv("PRICE_FEED_FALLBACK", "1") == "1"

    if source == "nasdaq":
        symbol = getattr(pair, "price_symbol", None) or getattr(pair, "symbol", None)
        if not symbol:
            logger.warning("nasdaq source without a symbol — using synthetic")
            return synthetic()
        asset_class = getattr(pair, "asset_class", None) or "stocks"
        sources = [NasdaqSource(symbol, asset_class, fx=us_fx)]
        if fallback_on:
            sources.append(YahooSource(symbol, fx=us_fx))
        inner = FallbackSource(sources)
    elif source in ("sina", "tencent"):
        symbol = getattr(pair, "price_symbol", None) or getattr(pair, "symbol", None)
        if not symbol:
            logger.warning("%s source without a symbol — using synthetic", source)
            return synthetic()
        if source == "sina":
            sources = [SinaSource(symbol, fx=local_fx), TencentSource(symbol, fx=local_fx)]
        else:
            sources = [TencentSource(symbol, fx=local_fx), SinaSource(symbol, fx=local_fx)]
        inner = FallbackSource(sources)
    elif source == "nebius":
        symbol = getattr(pair, "price_symbol", None) or getattr(pair, "symbol", None)
        if not symbol:
            logger.warning("nebius source without a symbol — using synthetic")
            return synthetic()
        # Single endpoint (no secondary): a total outage is handled by
        # CachedSource's outage policy, not by a fake fallback chain.
        inner = NebiusSource(symbol, fx=us_fx)
    elif source == "yahoo":
        symbol = getattr(pair, "price_symbol", None) or getattr(pair, "symbol", None)
        if not symbol:
            logger.warning("yahoo source without a symbol — using synthetic")
            return synthetic()
        inner = YahooSource(symbol, fx=us_fx)
    else:
        logger.warning("unknown price source %r — using synthetic", source)
        return synthetic()

    return CachedSource(inner, seed_wad=fair, logger=logger)
