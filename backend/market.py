from datetime import datetime, timezone
import math
import re
from threading import RLock
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import requests

SOURCE = "Yahoo Finance public chart/search endpoints (unofficial)"
SYMBOL = re.compile(r"[A-Z0-9][A-Z0-9.^=-]{0,19}")


class MarketUnavailable(RuntimeError):
    pass


class UnsupportedAsset(ValueError):
    pass


def clean_symbol(value):
    ticker = str(value).strip().upper()
    if not SYMBOL.fullmatch(ticker):
        raise ValueError("Use a valid ticker symbol, for example AAPL, BRK-B or RY.TO.")
    return ticker


def finite_positive(value):
    return isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


class Market:
    def __init__(self, store):
        self.store = store
        self.lock = RLock()

    def request(self, path, params):
        try:
            response = requests.get(
                "https://query1.finance.yahoo.com" + path, params=params, timeout=(5, 20),
                headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
            )
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
            raise MarketUnavailable("The market-data service is unavailable or returned invalid JSON. Previously saved portfolios are unchanged.") from exc

    def search(self, query, refresh=False):
        query = query.strip()
        if not query or len(query) > 80:
            raise ValueError("Search must contain 1 to 80 characters.")
        key = "search:" + query.casefold()
        with self.lock:
            cached = self.store.cache_get(key)
            if cached and not refresh:
                return cached["results"]
            data = self.request("/v1/finance/search", {"q": query, "quotesCount": 12, "newsCount": 0})
            if not isinstance(data.get("quotes"), list):
                raise MarketUnavailable("Market search returned an unexpected format.")
            results = []
            seen = set()
            for item in data["quotes"]:
                if not isinstance(item, dict):
                    raise MarketUnavailable("The market search response contains malformed entries.")
                symbol = item.get("symbol", "")
                if item.get("quoteType") not in ("EQUITY", "ETF") or not SYMBOL.fullmatch(symbol) or symbol in seen:
                    continue
                seen.add(symbol)
                results.append({
                    "ticker": symbol, "name": item.get("longname") or item.get("shortname") or symbol,
                    "exchange": item.get("exchDisp") or item.get("exchange") or "Not reported",
                    "instrument": item["quoteType"], "sector": item.get("sector") or None,
                })
            self.store.cache_put(key, {"results": results})
            return results

    def chart(self, ticker, history_range="1y", refresh=False):
        ticker = clean_symbol(ticker)
        if history_range not in ("6mo", "1y", "2y", "5y"):
            raise ValueError("Choose a supported history window.")
        key = f"chart:{ticker}:{history_range}"
        with self.lock:
            cached = self.store.cache_get(key)
            if cached and not refresh:
                return cached
            data = self.request(f"/v8/finance/chart/{quote(ticker, safe='')}", {
                "interval": "1d", "range": history_range, "includeAdjustedClose": "true",
            })
            try:
                envelope = data["chart"]
                if envelope.get("error"):
                    raise UnsupportedAsset(str(envelope["error"].get("description", "History unavailable.")))
                result = envelope["result"][0]
                meta = result["meta"]
                timestamps = result["timestamp"]
                closes = result["indicators"]["quote"][0]["close"]
                adjusted = result["indicators"]["adjclose"][0]["adjclose"]
                if not len(timestamps) == len(closes) == len(adjusted):
                    raise MarketUnavailable(f"Price history lengths do not agree for {ticker}.")
                currency = meta["currency"]
                instrument = meta["instrumentType"]
                returned_symbol = meta.get("symbol", "").upper()
                # Yahoo also names the USD/CAD pair CAD=X. Permit that verified
                # alias only for the matching currency instrument and direction.
                usd_cad_alias = ticker == "USDCAD=X" and returned_symbol == "CAD=X" and currency == "CAD" and instrument == "CURRENCY"
                if returned_symbol != ticker and not usd_cad_alias:
                    raise MarketUnavailable(f"Provider returned {returned_symbol or 'an unnamed symbol'} instead of {ticker}.")
                if instrument not in ("EQUITY", "ETF", "CURRENCY"):
                    raise UnsupportedAsset(f"{ticker} is a {instrument}; this app supports equities and ETFs, not derivatives or indices.")
                if currency not in ("USD", "CAD"):
                    raise UnsupportedAsset(f"{ticker} is quoted in {currency}. USD and CAD securities are supported; unsupported currencies are never treated as dollars.")
                zone = ZoneInfo(meta["exchangeTimezoneName"])
                regular = meta["currentTradingPeriod"]["regular"]
                now = datetime.now(timezone.utc)
                incomplete_day = datetime.fromtimestamp(regular["start"], zone).date() if now.timestamp() < regular["end"] else None
            except (KeyError, IndexError, TypeError, ZoneInfoNotFoundError) as exc:
                raise MarketUnavailable(f"{ticker} has incomplete adjusted-price metadata. No unadjusted fallback was used.") from exc
            records, seen = [], set()
            for stamp, close, adj in zip(timestamps, closes, adjusted):
                if not isinstance(stamp, (int, float)) or not math.isfinite(stamp):
                    raise MarketUnavailable(f"{ticker} has an invalid price timestamp.")
                try:
                    day = datetime.fromtimestamp(stamp, zone).date()
                except (ValueError, OverflowError, OSError) as exc:
                    raise MarketUnavailable(f"{ticker} has an out-of-range price timestamp.") from exc
                if day == incomplete_day or day > now.astimezone(zone).date():
                    continue
                if day in seen:
                    raise MarketUnavailable(f"Duplicate daily observations were returned for {ticker}.")
                seen.add(day)
                for value in (close, adj):
                    if value is not None and not finite_positive(value):
                        raise MarketUnavailable(f"{ticker} contains invalid observed prices.")
                records.append({"date": day.isoformat(), "close": close, "adjusted_close": adj})
            records.sort(key=lambda row: row["date"])
            valid = [row for row in records if finite_positive(row["close"]) and finite_positive(row["adjusted_close"])]
            if not valid:
                raise UnsupportedAsset(f"No completed adjusted-price history is available for {ticker}.")
            last = valid[-1]
            warnings = []
            if records and records[-1]["date"] != last["date"]:
                warnings.append(f"{ticker}: latest price observation is missing; valuation uses {last['date']}.")
            if (now.date() - datetime.fromisoformat(last["date"]).date()).days > 5:
                warnings.append(f"{ticker}: the most recent completed close is more than five calendar days old.")
            return self.store.cache_put(key, {
                "ticker": ticker, "provider_symbol": returned_symbol, "name": meta.get("longName") or meta.get("shortName") or ticker,
                "exchange": meta.get("fullExchangeName") or meta.get("exchangeName") or "Not reported",
                "currency": currency, "instrument": instrument, "price": last["close"], "price_date": last["date"],
                "records": records, "source": SOURCE, "warnings": warnings,
            })

    def asset(self, ticker, history_range="1y", refresh=False):
        chart = self.chart(ticker, history_range, refresh)
        if chart["instrument"] not in ("EQUITY", "ETF"):
            raise UnsupportedAsset("Currency pairs may be used for conversion, not as portfolio holdings.")
        warning = None
        sector = None
        if chart["instrument"] == "EQUITY":
            try:
                matches = self.search(ticker, refresh)
                match = next((item for item in matches if item["ticker"] == chart["ticker"]), None)
                sector = match["sector"] if match else None
            except (MarketUnavailable, UnsupportedAsset) as exc:
                warning = f"{ticker}: sector lookup is unavailable ({exc}); exposure is shown as Unknown."
        return {**chart, "sector": sector, "warnings": [*chart["warnings"], *([warning] if warning else [])]}
