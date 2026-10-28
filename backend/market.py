"""Market data client: global listings, adjusted daily history, FX and corporate events."""

from datetime import datetime, timezone
import math
import re
import time
from threading import RLock
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import requests

from .sectors import normalize_sector

SOURCE = "Yahoo Finance public chart/search endpoints (unofficial)"
SYMBOL = re.compile(r"[A-Z0-9][A-Z0-9.=&-]{0,24}")
ISO_CURRENCY = re.compile(r"[A-Z]{3}")
RANGES = ("6mo", "1y", "2y", "5y", "10y", "max")
HOLDING_TYPES = ("EQUITY", "ETF", "MUTUALFUND")
# Provider quote units that are fractions of an ISO currency.
MINOR_UNITS = {"GBp": ("GBP", 0.01), "GBX": ("GBP", 0.01), "ZAc": ("ZAR", 0.01), "ZAC": ("ZAR", 0.01), "ILA": ("ILS", 0.01)}


class MarketUnavailable(RuntimeError):
    pass


class UnsupportedAsset(ValueError):
    pass


def clean_symbol(value):
    ticker = str(value).strip().upper()
    if not SYMBOL.fullmatch(ticker):
        raise ValueError("Use a valid ticker symbol, for example AAPL, BRK-B, RY.TO, VOD.L or 7203.T.")
    return ticker


def currency_unit(code):
    """Map a provider quote currency to (ISO code, scale) where quote × scale = ISO units."""
    if code in MINOR_UNITS:
        return MINOR_UNITS[code]
    if isinstance(code, str) and ISO_CURRENCY.fullmatch(code):
        return code, 1.0
    raise UnsupportedAsset(f"Unsupported quote currency {code!r}; prices are never assumed to be in another unit.")


def finite_positive(value):
    return isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


class Market:
    def __init__(self, store, sleep=time.sleep):
        self.store = store
        self.lock = RLock()
        self.sleep = sleep

    def request(self, path, params):
        for attempt in range(2):
            try:
                response = requests.get(
                    "https://query1.finance.yahoo.com" + path, params=params, timeout=(5, 25),
                    headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
                )
                if response.status_code in (429, 502, 503, 504) and attempt == 0:
                    self.sleep(1.5)
                    continue
                response.raise_for_status()
                data = response.json()
                if not isinstance(data, dict):
                    raise MarketUnavailable("The market provider returned a non-object JSON response.")
                return data
            except requests.exceptions.HTTPError as exc:
                if exc.response is not None and exc.response.status_code == 404:
                    raise UnsupportedAsset("Ticker or requested history was not found by the market provider.") from exc
                raise MarketUnavailable("Yahoo Finance rejected the request or is rate-limiting access. Try again later; no prices were substituted.") from exc
            except (requests.exceptions.RequestException, ValueError) as exc:
                raise MarketUnavailable("The market-data service is unavailable or returned invalid JSON. Saved portfolios are unchanged.") from exc
        raise MarketUnavailable("Yahoo Finance is rate-limiting requests. Try again shortly; no prices were substituted.")

    def search(self, query, refresh=False):
        query = query.strip()
        if not query or len(query) > 80:
            raise ValueError("Search must contain 1 to 80 characters.")
        key = "v2:search:" + query.casefold()
        with self.lock:
            cached = self.store.cache_get(key)
            if cached and not refresh:
                return cached["results"]
            data = self.request("/v1/finance/search", {"q": query, "quotesCount": 15, "newsCount": 0})
            if not isinstance(data.get("quotes"), list):
                raise MarketUnavailable("Market search returned an unexpected format.")
            results, seen = [], set()
            for item in data["quotes"]:
                if not isinstance(item, dict):
                    raise MarketUnavailable("The market search response contains malformed entries.")
                symbol = str(item.get("symbol", "")).upper()
                if item.get("quoteType") not in HOLDING_TYPES or not SYMBOL.fullmatch(symbol) or symbol in seen:
                    continue
                seen.add(symbol)
                results.append({
                    "ticker": symbol, "name": item.get("longname") or item.get("shortname") or symbol,
                    "exchange": item.get("exchDisp") or item.get("exchange") or "Not reported",
                    "instrument": item["quoteType"],
                    "sector": normalize_sector(item.get("sector")) if item["quoteType"] == "EQUITY" else None,
                })
            self.store.cache_put(key, {"results": results})
            return results

    def chart(self, ticker, history_range="1y", refresh=False):
        ticker = clean_symbol(ticker)
        if history_range not in RANGES:
            raise ValueError("Choose a supported history window.")
        # Versioned keys: cached records from earlier schemas are never reused.
        key = f"v3:chart:{ticker}:{history_range}"
        with self.lock:
            cached = self.store.cache_get(key)
            if cached and not refresh:
                return cached
            params = {"interval": "1d", "includeAdjustedClose": "true", "events": "div,splits"}
            if history_range == "max":
                # range=max silently returns quarterly bars; explicit bounds keep daily granularity.
                params.update(period1=0, period2=int(time.time()))
            else:
                params["range"] = history_range
            data = self.request(f"/v8/finance/chart/{quote(ticker, safe='')}", params)
            return self.store.cache_put(key, self.parse_chart(ticker, data))

    def parse_chart(self, ticker, data):
        try:
            envelope = data["chart"]
            if envelope.get("error"):
                raise UnsupportedAsset(str(envelope["error"].get("description", "History unavailable.")))
            result = envelope["result"][0]
            meta = result["meta"]
            timestamps = result.get("timestamp") or []
            closes = result["indicators"]["quote"][0]["close"]
            adjusted = result["indicators"]["adjclose"][0]["adjclose"]
            instrument = meta["instrumentType"]
            currency, scale = meta["currency"], None
            returned = str(meta.get("symbol", "")).upper()
            zone = ZoneInfo(meta["exchangeTimezoneName"])
            regular = meta["currentTradingPeriod"]["regular"]
        except (KeyError, IndexError, TypeError, ZoneInfoNotFoundError) as exc:
            raise MarketUnavailable(f"{ticker} has incomplete adjusted-price metadata. No unadjusted fallback was used.") from exc
        if meta.get("dataGranularity") != "1d":
            raise MarketUnavailable(f"{ticker}: the provider returned {meta.get('dataGranularity')} bars instead of daily data.")
        if not len(timestamps) == len(closes) == len(adjusted):
            raise MarketUnavailable(f"Price history lengths do not agree for {ticker}.")
        if instrument not in (*HOLDING_TYPES, "CURRENCY"):
            raise UnsupportedAsset(f"{ticker} is a {instrument}; this app supports stocks, ETFs and mutual funds, not derivatives or indices.")
        # Yahoo serves USDXXX=X under the alias XXX=X; accept only that verified form.
        alias = ticker.startswith("USD") and ticker.endswith("=X") and returned == ticker[3:] and instrument == "CURRENCY" and currency == ticker[3:6]
        if returned != ticker and not alias:
            raise MarketUnavailable(f"Provider returned {returned or 'an unnamed symbol'} instead of {ticker}.")
        iso, scale = currency_unit(currency)
        now = datetime.now(timezone.utc)
        incomplete_day = datetime.fromtimestamp(regular["start"], zone).date() if now.timestamp() < regular["end"] else None
        records, seen = [], {}
        for stamp, close, adj in zip(timestamps, closes, adjusted):
            if not isinstance(stamp, (int, float)) or not math.isfinite(stamp):
                raise MarketUnavailable(f"{ticker} has an invalid price timestamp.")
            try:
                day = datetime.fromtimestamp(stamp, zone).date()
            except (ValueError, OverflowError, OSError) as exc:
                raise MarketUnavailable(f"{ticker} has an out-of-range price timestamp.") from exc
            if day == incomplete_day or day > now.astimezone(zone).date():
                continue
            for value in (close, adj):
                if value is not None and not finite_positive(value):
                    raise MarketUnavailable(f"{ticker} contains invalid observed prices.")
            row = {"date": day.isoformat(), "close": close, "adjusted_close": adj}
            if day in seen:
                # Some exchanges (e.g. ASX) add a post-close bar for the latest session; keep the later bar.
                earlier = records[seen[day]]
                if earlier["close"] != close or earlier["adjusted_close"] != adj:
                    latest = max(datetime.fromtimestamp(t, zone).date() for t in timestamps if isinstance(t, (int, float)))
                    if day != latest:
                        raise MarketUnavailable(f"Conflicting duplicate daily observations were returned for {ticker} on {day}.")
                records[seen[day]] = row
                continue
            seen[day] = len(records)
            records.append(row)
        records.sort(key=lambda row: row["date"])
        tail, quote_time = (records[-1] if records else None), meta.get("regularMarketTime")
        if (tail and tail["close"] is None and tail["adjusted_close"] is None and instrument != "CURRENCY"
                and finite_positive(meta.get("regularMarketPrice")) and isinstance(quote_time, (int, float)) and math.isfinite(quote_time)
                and datetime.fromtimestamp(quote_time, zone).date().isoformat() == tail["date"]):
            # The daily bar for a completed session can lag the quote feed; use that same session's last regular price.
            # The latest bar's adjusted close equals its close because adjustments only rescale earlier dates.
            price = float(meta["regularMarketPrice"])
            records[-1] = {"date": tail["date"], "close": price, "adjusted_close": price}
        valid = [row for row in records if finite_positive(row["close"]) and finite_positive(row["adjusted_close"])]
        if not valid:
            raise UnsupportedAsset(f"No completed adjusted-price history is available for {ticker}.")
        last = valid[-1]
        warnings = []
        if records[-1]["date"] != last["date"]:
            warnings.append(f"{ticker}: latest price observation is missing; valuation uses {last['date']}.")
        if (now.date() - datetime.fromisoformat(last["date"]).date()).days > 5:
            warnings.append(f"{ticker}: the most recent completed close is more than five calendar days old.")
        events = result.get("events") or {}
        dividends, splits = [], []
        for item in (events.get("dividends") or {}).values():
            if isinstance(item, dict) and finite_positive(item.get("amount")) and isinstance(item.get("date"), (int, float)):
                dividends.append({"date": datetime.fromtimestamp(item["date"], zone).date().isoformat(), "amount": float(item["amount"])})
        for item in (events.get("splits") or {}).values():
            if isinstance(item, dict) and finite_positive(item.get("numerator")) and finite_positive(item.get("denominator")) and isinstance(item.get("date"), (int, float)):
                splits.append({"date": datetime.fromtimestamp(item["date"], zone).date().isoformat(),
                               "numerator": float(item["numerator"]), "denominator": float(item["denominator"])})
        return {
            "ticker": ticker, "provider_symbol": returned, "name": meta.get("longName") or meta.get("shortName") or ticker,
            "exchange": meta.get("fullExchangeName") or meta.get("exchangeName") or "Not reported",
            "exchange_timezone": meta["exchangeTimezoneName"], "currency": currency, "currency_iso": iso, "currency_scale": scale,
            "instrument": instrument, "price": last["close"], "price_date": last["date"], "records": records,
            "dividends": sorted(dividends, key=lambda row: row["date"]), "splits": sorted(splits, key=lambda row: row["date"]),
            "source": SOURCE, "warnings": warnings,
        }

    def asset(self, ticker, history_range="1y", refresh=False):
        chart = self.chart(ticker, history_range, refresh)
        if chart["instrument"] not in HOLDING_TYPES:
            raise UnsupportedAsset("Currency pairs may be used for conversion, not as portfolio holdings.")
        warning, sector = None, None
        if chart["instrument"] == "EQUITY":
            try:
                match = next((item for item in self.search(chart["ticker"], refresh) if item["ticker"] == chart["ticker"]), None)
                sector = match["sector"] if match else None
            except (MarketUnavailable, UnsupportedAsset, ValueError) as exc:
                warning = f"{chart['ticker']}: sector lookup is unavailable ({exc}); exposure is shown as Unknown."
        return {**chart, "sector": sector, "warnings": [*chart["warnings"], *([warning] if warning else [])]}

    def pair(self, source, target, history_range, refresh):
        """Daily close rates for 1 source = rate × target, validated against the provider's quote currency."""
        chart = self.chart(f"{source}{target}=X", history_range, refresh)
        if chart["instrument"] != "CURRENCY" or chart["currency_iso"] != target:
            raise MarketUnavailable(f"{source}{target}=X is not quoted in {target}.")
        series = {row["date"]: row["close"] for row in chart["records"] if finite_positive(row["close"])}
        return {"series": series, "rate": chart["price"], "date": chart["price_date"], "pair": chart["ticker"],
                "fetched_at": chart["fetched_at"], "warnings": chart["warnings"]}

    def fx(self, source, target, history_range="1y", refresh=False):
        """Convert ISO `source` to ISO `target`: direct pair, else inverted pair, else triangulated through USD."""
        if source == target:
            raise ValueError("No conversion is needed between identical currencies.")
        for method, legs in (("direct", (source, target)), ("inverse", (target, source))):
            try:
                quote_pair = self.pair(*legs, history_range, refresh)
            except UnsupportedAsset:
                continue
            except MarketUnavailable as exc:
                if "not quoted" in str(exc) or "instead of" in str(exc):
                    continue
                raise
            if method == "inverse":
                quote_pair = {**quote_pair, "series": {day: 1 / rate for day, rate in quote_pair["series"].items()}, "rate": 1 / quote_pair["rate"]}
            return {"currency": source, "base": target, "method": method, "pairs": [quote_pair["pair"]], **quote_pair}
        if "USD" in (source, target):
            raise UnsupportedAsset(f"No exchange-rate history is available for {source}/{target}.")
        first, second = self.fx(source, "USD", history_range, refresh), self.fx("USD", target, history_range, refresh)
        series = {day: rate * second["series"][day] for day, rate in first["series"].items() if day in second["series"]}
        if not series:
            raise UnsupportedAsset(f"No overlapping exchange-rate history is available for {source}/{target}.")
        return {
            "currency": source, "base": target, "method": "triangulated", "pairs": [*first["pairs"], *second["pairs"]],
            "series": series, "rate": first["rate"] * second["rate"], "date": min(first["date"], second["date"]),
            "fetched_at": min(first["fetched_at"], second["fetched_at"]), "warnings": [*first["warnings"], *second["warnings"]],
        }

    def history(self, ticker, history_range="5y", refresh=False):
        chart = self.asset(ticker, history_range, refresh)
        points = [{"date": row["date"], "close": row["close"], "adjusted_close": row["adjusted_close"]}
                  for row in chart["records"] if finite_positive(row["close"]) and finite_positive(row["adjusted_close"])]
        return {
            "ticker": chart["ticker"], "name": chart["name"], "currency": chart["currency"], "currency_iso": chart["currency_iso"],
            "currency_scale": chart["currency_scale"], "range": history_range, "points": points,
            "dividends": chart["dividends"], "splits": chart["splits"], "fetched_at": chart["fetched_at"],
            "source": chart["source"], "warnings": chart["warnings"],
        }
