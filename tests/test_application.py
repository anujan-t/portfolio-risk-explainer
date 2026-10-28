from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.parse import unquote

from fastapi.testclient import TestClient
import numpy as np
import pandas as pd
import requests

from backend.analytics import analyze, compare_scenario, prepare_market, resolve_frequency
from backend.app import create_app
from backend.market import Market, MarketUnavailable, UnsupportedAsset, currency_unit
from backend.storage import Store

DATES = pd.bdate_range("2025-01-01", periods=300)
STEPS = np.arange(len(DATES) - 1)
COMMON = np.sin(STEPS / 4) * 0.012 + 0.0004


def path(start, returns):
    return start * np.cumprod(np.r_[1, 1 + returns])


SERIES = {
    "AAA": ("USD", 1, "America/New_York", "EQUITY", "Information Technology", path(100, 2 * COMMON)),
    "BBB": ("USD", 1, "America/New_York", "ETF", None, path(70, -0.3 * COMMON + np.cos(STEPS) * 0.003)),
    "SPY": ("USD", 1, "America/New_York", "ETF", None, path(100, COMMON)),
    "CADSTOCK": ("CAD", 1, "America/Toronto", "EQUITY", "Financials", path(50, 0.7 * COMMON)),
    "LONSTOCK": ("GBp", 0.01, "Europe/London", "EQUITY", None, path(1200, 0.5 * COMMON + np.sin(STEPS) * 0.002)),
    "TOKSTOCK": ("JPY", 1, "Asia/Tokyo", "EQUITY", "Industrials", path(3000, 0.4 * COMMON + np.cos(STEPS / 3) * 0.004)),
}
RATES = {"CAD": np.linspace(0.70, 0.72, len(DATES)), "GBP": np.linspace(1.30, 1.33, len(DATES)),
         "JPY": np.linspace(0.0065, 0.0063, len(DATES))}


class FixtureMarket:
    def __init__(self):
        self.assets = {}
        for ticker, (currency, scale, zone, instrument, sector, prices) in SERIES.items():
            self.assets[ticker] = {
                "ticker": ticker, "provider_symbol": ticker, "name": ticker + " fixture", "exchange": zone.split("/")[1] + " exchange",
                "exchange_timezone": zone, "currency": currency, "currency_iso": currency_unit(currency)[0], "currency_scale": scale,
                "instrument": instrument, "sector": sector, "price": float(prices[-1]), "price_date": str(DATES[-1].date()),
                "records": [{"date": str(day.date()), "close": float(value), "adjusted_close": float(value)} for day, value in zip(DATES, prices)],
                "dividends": [{"date": str(DATES[40].date()), "amount": 0.25}], "splits": [],
                "fetched_at": "2026-10-28T00:00:00+00:00", "source": "Test fixture, not market data", "warnings": [],
            }
        self.rates = {iso: {str(day.date()): float(rate) for day, rate in zip(DATES, values)} for iso, values in RATES.items()}
        self.calls = []

    def asset(self, ticker, history_range="1y", refresh=False):
        self.calls.append(("asset", ticker, history_range))
        if ticker not in self.assets:
            raise UnsupportedAsset("Unpriced holding: " + ticker)
        return deepcopy(self.assets[ticker])

    def fx(self, source, target, history_range="1y", refresh=False):
        self.calls.append(("fx", source, target, history_range))
        assert target == "USD"
        series = dict(self.rates[source])
        last = max(series)
        return {"currency": source, "base": target, "method": "direct", "pairs": [f"{source}{target}=X"], "series": series,
                "rate": series[last], "date": last, "fetched_at": "2026-10-28T00:00:00+00:00", "warnings": []}

    def search(self, query):
        return [{key: asset[key] for key in ("ticker", "name", "exchange", "instrument", "sector")}
                for ticker, asset in self.assets.items() if query.upper() in ticker]

    def history(self, ticker, history_range="5y", refresh=False):
        asset = self.asset(ticker, history_range)
        return {"ticker": ticker, "name": asset["name"], "currency": asset["currency"], "currency_iso": asset["currency_iso"],
                "currency_scale": asset["currency_scale"], "range": history_range,
                "points": [{"date": r["date"], "close": r["close"], "adjusted_close": r["adjusted_close"]} for r in asset["records"]],
                "dividends": asset["dividends"], "splits": asset["splits"], "fetched_at": asset["fetched_at"],
                "source": asset["source"], "warnings": []}


PORTFOLIO = {"name": "Test allocation", "base_currency": "USD", "holdings": [{"ticker": "AAA", "shares": 10}, {"ticker": "BBB", "shares": 15}]}


def run(portfolio, market, benchmark="SPY", history_range="1y", frequency="auto"):
    return analyze(portfolio, prepare_market([portfolio], benchmark, history_range, market, False, frequency))


class AnalyticsTests(unittest.TestCase):
    def setUp(self):
        self.market = FixtureMarket()

    def test_complete_portfolio_math_trims_window_and_fetches_two_years(self):
        result = run(PORTFOLIO, self.market)
        self.assertIn(("asset", "AAA", "2y"), self.market.calls)
        self.assertEqual(result["coverage"]["frequency"], "daily")
        self.assertEqual(result["coverage"]["periods_per_year"], 252)
        self.assertGreaterEqual(pd.Timestamp(result["coverage"]["start_date"]), DATES[-1] - pd.DateOffset(years=1))
        self.assertAlmostEqual(sum(h["weight"] for h in result["holdings"]), 1)
        self.assertAlmostEqual(sum(h["risk_contribution"] for h in result["holdings"]), 1)
        self.assertAlmostEqual(sum(h["market_value"] for h in result["holdings"]), result["total_value"])
        self.assertLess(result["risk"]["max_drawdown"], 0)
        self.assertGreaterEqual(result["risk"]["historical_es_95"], result["risk"]["historical_var_95"])
        self.assertAlmostEqual(result["risk"]["annual_volatility"], result["risk"]["period_volatility"] * np.sqrt(252))
        self.assertEqual(result["series"][0]["portfolio"], 100)
        self.assertGreater(result["concentration"]["fund_weight"], 0)
        self.assertIn("not an LLM", result["explanation_method"])

    def test_minor_units_and_fx_are_applied_once(self):
        portfolio = {**PORTFOLIO, "holdings": [{"ticker": "LONSTOCK", "shares": 100}]}
        result = run(portfolio, self.market)
        holding = result["holdings"][0]
        expected = SERIES["LONSTOCK"][5][-1] * 0.01 * RATES["GBP"][-1]
        self.assertAlmostEqual(holding["price_base"], expected)
        self.assertAlmostEqual(result["total_value"], expected * 100)
        self.assertEqual(result["concentration"]["currency_exposures"], [{"currency": "GBP", "weight": 1.0}])
        self.assertEqual(result["fx"][0]["currency"], "GBP")
        self.assertTrue(any("minor units" in w for w in result["warnings"]))

    def test_distant_time_zones_switch_to_weekly(self):
        portfolio = {**PORTFOLIO, "holdings": [{"ticker": "AAA", "shares": 5}, {"ticker": "TOKSTOCK", "shares": 10}]}
        result = run(portfolio, self.market)
        coverage = result["coverage"]
        self.assertEqual((coverage["frequency"], coverage["periods_per_year"], coverage["horizon"], coverage["min_observations"]), ("weekly", 52, "week", 26))
        self.assertIn("hours apart", coverage["frequency_reason"])
        self.assertTrue(all(pd.Timestamp(point["date"]).dayofweek == 4 for point in result["series"][1:]))
        self.assertLessEqual(pd.Timestamp(result["series"][-1]["date"]), DATES[-1])
        daily = run(portfolio, self.market, frequency="daily")
        self.assertEqual(daily["coverage"]["frequency"], "daily")

    def test_weekly_requires_a_year(self):
        with self.assertRaisesRegex(ValueError, "at least one year"):
            prepare_market([PORTFOLIO], "SPY", "6mo", self.market, False, "weekly")
        frequency, reason = resolve_frequency("auto", {t: self.market.assets[t] for t in ("AAA", "TOKSTOCK")}, "6mo")
        self.assertEqual(frequency, "daily")
        self.assertIn("too short", reason)

    def test_missing_fx_date_is_not_filled(self):
        missing = str(DATES[-80].date())
        del self.market.rates["CAD"][missing]
        portfolio = {**PORTFOLIO, "holdings": [{"ticker": "CADSTOCK", "shares": 20}]}
        result = run(portfolio, self.market)
        self.assertEqual(result["coverage"]["dropped_observations"], 2)
        self.assertNotIn(missing, [point["date"] for point in result["series"]])

    def test_missing_price_excludes_adjacent_returns_without_dropping_holding(self):
        self.market.assets["AAA"]["records"][-60]["adjusted_close"] = None
        result = run(PORTFOLIO, self.market)
        self.assertEqual(result["coverage"]["dropped_observations"], 2)
        self.assertEqual(len(result["holdings"]), 2)

    def test_session_and_period_returns(self):
        portfolio = {**PORTFOLIO, "holdings": [{"ticker": "AAA", "shares": 10}, {"ticker": "CADSTOCK", "shares": 20}]}
        result = run(portfolio, self.market)
        aaa = next(h for h in result["holdings"] if h["ticker"] == "AAA")
        prices = SERIES["AAA"][5]
        self.assertAlmostEqual(aaa["session"]["return_local"], prices[-1] / prices[-2] - 1)
        self.assertAlmostEqual(aaa["session"]["return_base"], aaa["session"]["return_local"])
        cad = next(h for h in result["holdings"] if h["ticker"] == "CADSTOCK")
        local = SERIES["CADSTOCK"][5]
        expected = local[-1] * RATES["CAD"][-1] / (local[-2] * RATES["CAD"][-2]) - 1
        self.assertAlmostEqual(cad["session"]["return_base"], expected)
        self.assertAlmostEqual(result["session"]["change_base"], aaa["session"]["change_base"] + cad["session"]["change_base"])
        self.assertAlmostEqual(result["session"]["covered_weight"], 1)
        month = pd.Series(prices, index=DATES)
        anchor = month[month.index <= DATES[-1] - pd.DateOffset(months=1)].iloc[-1]
        self.assertAlmostEqual(aaa["period_returns"]["m1"], prices[-1] / anchor - 1)
        self.assertIsNotNone(aaa["period_returns"]["y1"])

    def test_unpriced_holding_and_short_history_rejected(self):
        with self.assertRaisesRegex(UnsupportedAsset, "Unpriced"):
            prepare_market([{**PORTFOLIO, "holdings": [{"ticker": "MISSING", "shares": 1}]}], "SPY", "1y", self.market)
        self.market.assets["AAA"]["records"] = self.market.assets["AAA"]["records"][-30:]
        with self.assertRaisesRegex(ValueError, "60 common"):
            run(PORTFOLIO, self.market)

    def test_scenario_shares_window_and_keeps_inputs(self):
        baseline = deepcopy(PORTFOLIO)
        alternative = {**PORTFOLIO, "holdings": [{"ticker": "CADSTOCK", "shares": 10}]}
        self.market.assets["CADSTOCK"]["records"] = self.market.assets["CADSTOCK"]["records"][-150:]
        result = compare_scenario(baseline, alternative, prepare_market([baseline, alternative], "SPY", "1y", self.market))
        self.assertEqual(result["baseline"]["coverage"]["start_date"], result["scenario"]["coverage"]["start_date"])
        self.assertEqual(result["baseline"]["coverage"]["observations"], result["scenario"]["coverage"]["observations"])
        self.assertEqual(baseline, PORTFOLIO)

    def test_constant_benchmark_gives_null_beta(self):
        for row in self.market.assets["SPY"]["records"]:
            row["adjusted_close"] = 100
        result = run(PORTFOLIO, self.market)
        self.assertIsNone(result["risk"]["beta"])
        self.assertIsNone(result["risk"]["benchmark_correlation"])

    def test_negative_risk_contribution_is_preserved(self):
        portfolio = {**PORTFOLIO, "holdings": [{"ticker": "AAA", "shares": 50}, {"ticker": "BBB", "shares": 1}]}
        result = run(portfolio, self.market)
        self.assertLess(next(h for h in result["holdings"] if h["ticker"] == "BBB")["risk_contribution"], 0)
        self.assertAlmostEqual(sum(h["risk_contribution"] for h in result["holdings"]), 1)


class FakeNews:
    def __init__(self):
        self.calls = []

    def sector_board(self):
        return {"sectors": [], "refreshed_at": None, "next_refresh_at": None, "refreshing": False, "last_error": None, "source": "fake"}

    def status(self):
        return {"refreshed_at": None, "next_refresh_at": None, "refreshing": False, "last_error": None}

    def request_refresh(self):
        return {"status": "started", "next_allowed_at": None, **self.status()}

    def holdings_news(self, holdings, refresh=False):
        self.calls.append((holdings, refresh))
        return {"items": [], "by_ticker": {}, "refreshed_at": "2026-10-28T00:00:00Z", "source": "fake", "warnings": []}

    def start(self):
        raise AssertionError("background disabled in tests")

    def stop(self):
        raise AssertionError("background disabled in tests")


class APITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)
        self.news = FakeNews()
        self.client = TestClient(create_app(self.path, FixtureMarket(), self.news, background=False), base_url="http://127.0.0.1")

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def test_portfolio_revisions_and_private_storage(self):
        saved = self.client.post("/api/portfolios", json=PORTFOLIO).json()
        self.assertEqual(saved["revision"], 1)
        changed = self.client.put("/api/portfolios/" + saved["id"], json={**PORTFOLIO, "name": "Changed", "revision": 1})
        self.assertEqual(changed.json()["revision"], 2)
        self.assertEqual(self.client.put("/api/portfolios/" + saved["id"], json={**PORTFOLIO, "revision": 1}).status_code, 409)
        self.assertEqual(self.client.delete(f"/api/portfolios/{saved['id']}?revision=1").status_code, 409)
        self.assertEqual(self.client.delete(f"/api/portfolios/{saved['id']}?revision=2").status_code, 200)
        self.assertEqual(Store(self.path).list_portfolios(), [])

    def test_analysis_and_scenario_routes(self):
        response = self.client.post("/api/analyze", json={"portfolio": PORTFOLIO, "benchmark": "SPY", "range": "1y", "frequency": "daily"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(self.client.get("/api/portfolios").json()["portfolios"], [])
        scenario = self.client.post("/api/scenario", json={"baseline": PORTFOLIO, "scenario": {**PORTFOLIO, "holdings": [{"ticker": "AAA", "shares": 3}]}})
        self.assertEqual(scenario.status_code, 200, scenario.text)
        self.assertEqual(self.client.post("/api/scenario", json={"baseline": PORTFOLIO, "scenario": {**PORTFOLIO, "base_currency": "CAD"}}).status_code, 422)
        self.assertEqual(self.client.post("/api/analyze", json={"portfolio": PORTFOLIO, "range": "6mo", "frequency": "weekly"}).status_code, 422)

    def test_validation(self):
        for entry in ({"ticker": "AAA", "shares": -1}, {"ticker": "AAA", "shares": 0}, {"ticker": "../secret", "shares": 1}):
            self.assertEqual(self.client.post("/api/portfolios", json={**PORTFOLIO, "holdings": [entry]}).status_code, 422)
        self.assertEqual(self.client.post("/api/portfolios", json={**PORTFOLIO, "base_currency": "XYZ"}).status_code, 422)
        too_many = [{"ticker": f"T{i}", "shares": 1} for i in range(26)]
        self.assertEqual(self.client.post("/api/portfolios", json={**PORTFOLIO, "holdings": too_many}).status_code, 422)
        merged = self.client.post("/api/portfolios", json={**PORTFOLIO, "holdings": [{"ticker": " aaa ", "shares": 1}, {"ticker": "AAA", "shares": 2}]}).json()
        self.assertEqual(merged["holdings"], [{"ticker": "AAA", "shares": 3}])
        failed = self.client.post("/api/analyze", json={"portfolio": {**PORTFOLIO, "holdings": [*PORTFOLIO["holdings"], {"ticker": "MISSING", "shares": 1}]}})
        self.assertEqual(failed.status_code, 422)
        self.assertIn("Unpriced", failed.json()["detail"])

    def test_metadata_assets_and_history(self):
        config = self.client.get("/api/config").json()
        self.assertIn("10y", config["ranges"])
        self.assertIn("max", config["ranges"])
        self.assertEqual(config["max_holdings"], 25)
        self.assertEqual(len(self.client.get("/api/examples").json()["examples"]), 3)
        asset = self.client.get("/api/assets/LONSTOCK").json()
        self.assertEqual((asset["currency"], asset["currency_iso"], asset["currency_scale"]), ("GBp", "GBP", 0.01))
        self.assertNotIn("records", asset)
        history = self.client.get("/api/assets/AAA/history?range=max").json()
        self.assertEqual(len(history["points"]), len(DATES))
        self.assertEqual(history["dividends"][0]["amount"], 0.25)
        self.assertEqual(self.client.get("/api/assets/AAA/history?range=3y").status_code, 422)
        self.assertTrue(self.client.get("/api/assets/search?q=AAA").json()["results"])

    def test_news_routes_validate_and_delegate(self):
        self.assertEqual(self.client.get("/api/news/sectors").json()["source"], "fake")
        self.assertEqual(self.client.post("/api/news/refresh").json()["status"], "started")
        self.assertIn("refreshing", self.client.get("/api/news/status").json())
        ok = self.client.post("/api/news/holdings", json={"holdings": [{"ticker": "aaa", "name": "Alpha"}]})
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(self.news.calls[-1], ([{"ticker": "AAA", "name": "Alpha"}], False))
        self.assertEqual(self.client.post("/api/news/holdings", json={"holdings": [{"ticker": "<x>"}]}).status_code, 422)
        self.assertEqual(self.client.post("/api/news/holdings", json={"holdings": []}).status_code, 422)

    def test_screenshot_route_limits_and_errors(self):
        self.assertEqual(self.client.post("/api/import/screenshot", content=b"abc", headers={"Content-Type": "text/plain"}).status_code, 415)
        self.assertEqual(self.client.post("/api/import/screenshot", content=b"x" * (8 * 1024 * 1024 + 1), headers={"Content-Type": "image/png"}).status_code, 413)
        self.assertEqual(self.client.post("/api/import/screenshot", content=b"not an image", headers={"Content-Type": "image/png"}).status_code, 422)
        with patch("backend.app.analyze_screenshot", return_value={"rows": []}) as extractor:
            response = self.client.post("/api/import/screenshot", content=b"\x89PNG fake", headers={"Content-Type": "image/png"})
        self.assertEqual(response.json(), {"rows": []})
        self.assertEqual(extractor.call_args.args[0], b"\x89PNG fake")

    def test_cross_origin_writes_blocked(self):
        denied = self.client.post("/api/portfolios", json=PORTFOLIO, headers={"Origin": "https://external.example"})
        self.assertEqual(denied.status_code, 403)


def chart_response(symbol="AAA", currency="USD", instrument="EQUITY", granularity="1d", closes=(100, 102, 999), adjusted=(98, 100, 998), offsets=(2, 1, 0), events=None, meta=None):
    now = datetime.now(timezone.utc)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    result = {
        "meta": {"symbol": symbol, "currency": currency, "instrumentType": instrument, "longName": "Alpha", "dataGranularity": granularity,
                 "exchangeTimezoneName": "UTC", "currentTradingPeriod": {"regular": {"start": int(today.timestamp()), "end": int((today + timedelta(days=1)).timestamp())}},
                 **(meta or {})},
        "timestamp": [int((today - timedelta(days=offset)).timestamp()) + 3600 for offset in offsets],
        "indicators": {"quote": [{"close": list(closes)}], "adjclose": [{"adjclose": list(adjusted)}]},
    }
    if events:
        result["events"] = events
    return {"chart": {"error": None, "result": [result]}}


class MarketTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.market = Market(Store(Path(self.temp.name)), sleep=lambda _: None)

    def tearDown(self):
        self.temp.cleanup()

    def test_completed_adjusted_history_and_cache(self):
        with patch.object(self.market, "request", return_value=chart_response()) as source:
            result = self.market.chart("AAA")
            self.assertEqual((result["price"], result["records"][-1]["adjusted_close"], len(result["records"])), (102, 100, 2))
            self.assertEqual(self.market.chart("AAA")["fetched_at"], result["fetched_at"])
            source.assert_called_once()
            self.market.chart("AAA", refresh=True)
            self.assertEqual(source.call_count, 2)

    def test_minor_units_supported_unknown_units_rejected(self):
        with patch.object(self.market, "request", return_value=chart_response(currency="GBp")):
            result = self.market.chart("AAA")
        self.assertEqual((result["currency_iso"], result["currency_scale"]), ("GBP", 0.01))
        with patch.object(self.market, "request", return_value=chart_response(symbol="AAB", currency="XXc")), self.assertRaises(UnsupportedAsset):
            self.market.chart("AAB")

    def test_non_daily_and_missing_adjustment_rejected(self):
        with patch.object(self.market, "request", return_value=chart_response(granularity="3mo")), self.assertRaisesRegex(MarketUnavailable, "instead of daily"):
            self.market.chart("AAA")
        response = chart_response()
        del response["chart"]["result"][0]["indicators"]["adjclose"]
        with patch.object(self.market, "request", return_value=response), self.assertRaisesRegex(MarketUnavailable, "No unadjusted fallback"):
            self.market.chart("AAC")

    def test_max_range_requests_daily_bounds(self):
        with patch.object(self.market, "request", return_value=chart_response()) as source:
            self.market.chart("AAA", "max")
        params = source.call_args.args[1]
        self.assertEqual(params["period1"], 0)
        self.assertNotIn("range", params)
        self.assertEqual(params["interval"], "1d")

    def test_symbol_alias_only_for_usd_pairs(self):
        with patch.object(self.market, "request", return_value=chart_response(symbol="JPY=X", currency="JPY", instrument="CURRENCY")):
            self.assertEqual(self.market.chart("USDJPY=X")["provider_symbol"], "JPY=X")
        with patch.object(self.market, "request", return_value=chart_response(symbol="MSFT")), self.assertRaisesRegex(MarketUnavailable, "instead of AAA"):
            self.market.chart("AAA")

    def test_duplicate_bars(self):
        same = chart_response(closes=(100, 102, 102, 999), adjusted=(98, 100, 100, 998), offsets=(2, 1, 1, 0))
        with patch.object(self.market, "request", return_value=same):
            self.assertEqual(len(self.market.chart("AAA")["records"]), 2)
        conflicting = chart_response(symbol="AAD", closes=(100, 101, 102, 999), adjusted=(98, 99, 100, 998), offsets=(2, 2, 1, 0))
        with patch.object(self.market, "request", return_value=conflicting), self.assertRaisesRegex(MarketUnavailable, "Conflicting"):
            self.market.chart("AAD")

    def test_lagging_daily_bar_uses_same_session_quote_only(self):
        today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        yesterday_close = int((today - timedelta(days=1)).timestamp()) + 20 * 3600
        older_quote = int((today - timedelta(days=2)).timestamp()) + 20 * 3600
        lagging = dict(closes=(100, None, 999), adjusted=(98, None, 998))
        with patch.object(self.market, "request", return_value=chart_response(meta={"regularMarketPrice": 103.5, "regularMarketTime": yesterday_close}, **lagging)):
            filled = self.market.chart("AAA")
        self.assertEqual((filled["price"], filled["records"][-1]["adjusted_close"], filled["warnings"]), (103.5, 103.5, []))
        self.assertEqual(filled["price_date"], (today - timedelta(days=1)).date().isoformat())
        with patch.object(self.market, "request", return_value=chart_response(symbol="AAB", meta={"regularMarketPrice": 103.5, "regularMarketTime": older_quote}, **lagging)):
            stale = self.market.chart("AAB")
        self.assertEqual((stale["price"], stale["price_date"]), (100, (today - timedelta(days=2)).date().isoformat()))
        self.assertIn("latest price observation is missing", stale["warnings"][0])
        with patch.object(self.market, "request", return_value=chart_response(symbol="JPY=X", currency="JPY", instrument="CURRENCY",
                                                                             meta={"regularMarketPrice": 150.1, "regularMarketTime": yesterday_close}, **lagging)):
            rate = self.market.chart("USDJPY=X")
        self.assertEqual(rate["price"], 100)

    def test_dividends_and_splits(self):
        stamp = int((datetime.now(timezone.utc) - timedelta(days=2)).timestamp())
        events = {"dividends": {str(stamp): {"amount": 0.5, "date": stamp}}, "splits": {str(stamp): {"numerator": 4, "denominator": 1, "date": stamp}}}
        with patch.object(self.market, "request", return_value=chart_response(events=events)):
            result = self.market.chart("AAA")
        self.assertEqual(result["dividends"][0]["amount"], 0.5)
        self.assertEqual((result["splits"][0]["numerator"], result["splits"][0]["denominator"]), (4, 1))

    def test_fx_direct_inverse_and_triangulated(self):
        def pair(symbol, currency):
            return chart_response(symbol=symbol, currency=currency, instrument="CURRENCY", closes=(2, 4, 9), adjusted=(2, 4, 9))
        responses = {"GBPUSD=X": pair("GBPUSD=X", "USD")}
        def fake(path, params):
            symbol = unquote(path.rsplit("/", 1)[1])
            if symbol not in responses:
                raise UnsupportedAsset("missing")
            return responses[symbol]
        with patch.object(self.market, "request", side_effect=fake):
            direct = self.market.fx("GBP", "USD")
            self.assertEqual((direct["method"], direct["rate"]), ("direct", 4))
            inverse = self.market.fx("USD", "GBP")
            self.assertEqual((inverse["method"], inverse["rate"]), ("inverse", 0.25))
            responses["USDCHF=X"] = pair("CHF=X", "CHF")
            cross = self.market.fx("GBP", "CHF")
            self.assertEqual((cross["method"], cross["pairs"], cross["rate"]), ("triangulated", ["GBPUSD=X", "USDCHF=X"], 16))
            with self.assertRaises(UnsupportedAsset):
                self.market.fx("GBP", "SEK")

    def test_fx_rejects_wrongly_quoted_pair(self):
        responses = {"EURUSD=X": chart_response(symbol="EURUSD=X", currency="EUR", instrument="CURRENCY"),
                     "USDEUR=X": chart_response(symbol="USDEUR=X", currency="EUR", instrument="CURRENCY", closes=(1, 2, 9), adjusted=(1, 2, 9))}
        with patch.object(self.market, "request", side_effect=lambda path, params: responses[unquote(path.rsplit("/", 1)[1])]):
            result = self.market.fx("EUR", "USD")
        self.assertEqual((result["method"], result["rate"]), ("inverse", 0.5))

    @patch("backend.market.requests.get")
    def test_requests_contain_only_market_identifiers(self, request):
        response = Mock(status_code=200)
        response.json.return_value = chart_response()
        request.return_value = response
        self.market.chart("AAA")
        args, kwargs = request.call_args
        self.assertEqual(args[0], "https://query1.finance.yahoo.com/v8/finance/chart/AAA")
        self.assertEqual(set(kwargs["params"]), {"interval", "range", "includeAdjustedClose", "events"})

    @patch("backend.market.requests.get")
    def test_rate_limit_retries_once_then_fails_explicitly(self, request):
        limited = Mock(status_code=429)
        limited.raise_for_status.side_effect = requests.exceptions.HTTPError(response=limited)
        request.return_value = limited
        with self.assertRaisesRegex(MarketUnavailable, "rate-limiting"):
            self.market.chart("AAA")
        self.assertEqual(request.call_count, 2)

    @patch("backend.market.requests.get", side_effect=requests.exceptions.Timeout("timeout"))
    def test_timeout_is_explicit(self, request):
        with self.assertRaisesRegex(MarketUnavailable, "unavailable"):
            self.market.chart("AAA")
