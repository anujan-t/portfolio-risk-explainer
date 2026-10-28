from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
import numpy as np
import pandas as pd
import requests

from backend.analytics import analyze, compare_scenario, prepare_market
from backend.app import create_app
from backend.market import Market, MarketUnavailable, UnsupportedAsset
from backend.storage import Store


class FixtureMarket:
    def __init__(self):
        dates = pd.bdate_range("2025-01-01", periods=180)
        common = np.sin(np.arange(179) / 4) * 0.012 + 0.0004
        values = {
            "AAA": 100 * np.cumprod(np.r_[1, 1 + 2 * common]),
            "BBB": 70 * np.cumprod(np.r_[1, 1 - 0.3 * common + np.cos(np.arange(179)) * 0.003]),
            "SPY": 100 * np.cumprod(np.r_[1, 1 + common]),
            "CADSTOCK": 50 * np.cumprod(np.r_[1, 1 + common * 0.7]),
            "CADUSD=X": np.linspace(0.70, 0.72, 180),
            "USDCAD=X": np.linspace(1 / 0.70, 1 / 0.72, 180),
        }
        self.assets = {}
        for ticker, prices in values.items():
            self.assets[ticker] = {
                "ticker": ticker, "name": ticker + " fixture", "exchange": "Fixture",
                "currency": "CAD" if ticker in ("CADSTOCK", "USDCAD=X") else "USD",
                "instrument": "CURRENCY" if "=" in ticker else "ETF" if ticker == "BBB" else "EQUITY",
                "sector": None if ticker == "BBB" else "Technology",
                "price": float(prices[-1]), "price_date": str(dates[-1].date()),
                "records": [{"date": str(day.date()), "close": float(value), "adjusted_close": float(value)} for day, value in zip(dates, prices)],
                "fetched_at": "2026-10-28T00:00:00+00:00", "source": "Test fixture, not real market data", "warnings": [],
            }

    def chart(self, ticker, history_range="1y", refresh=False):
        if ticker not in self.assets:
            raise UnsupportedAsset("Unpriced holding: " + ticker)
        return deepcopy(self.assets[ticker])

    def asset(self, ticker, history_range="1y", refresh=False):
        return self.chart(ticker, history_range, refresh)

    def search(self, query):
        return [{key: value for key, value in asset.items() if key in ("ticker", "name", "exchange", "instrument", "sector")}
                for ticker, asset in self.assets.items() if query.upper() in ticker and "=" not in ticker]


PORTFOLIO = {"name": "Test allocation", "base_currency": "USD", "holdings": [{"ticker": "AAA", "shares": 10}, {"ticker": "BBB", "shares": 15}]}


class AnalyticsTests(unittest.TestCase):
    def setUp(self):
        self.market = FixtureMarket()

    def test_complete_portfolio_risk_math_and_provenance(self):
        snapshot = prepare_market([PORTFOLIO], "SPY", "1y", self.market)
        result = analyze(PORTFOLIO, snapshot)
        self.assertEqual(result["coverage"]["observations"], 179)
        self.assertEqual(result["coverage"]["priced_weight"], 1)
        self.assertAlmostEqual(sum(h["weight"] for h in result["holdings"]), 1)
        self.assertAlmostEqual(sum(h["risk_contribution"] for h in result["holdings"]), 1)
        self.assertAlmostEqual(sum(h["market_value"] for h in result["holdings"]), result["total_value"])
        self.assertLess(result["risk"]["max_drawdown"], 0)
        self.assertGreaterEqual(result["risk"]["historical_es_95"], result["risk"]["historical_var_95"])
        self.assertEqual(result["series"][0]["portfolio"], 100)
        self.assertEqual(result["series"][0]["drawdown"], 0)
        self.assertGreater(result["concentration"]["fund_weight"], 0)
        self.assertIn("not an LLM", result["explanation_method"])

    def test_single_asset_beta_and_risk_contribution(self):
        portfolio = {**PORTFOLIO, "holdings": [{"ticker": "AAA", "shares": 1}]}
        result = analyze(portfolio, prepare_market([portfolio], "SPY", "1y", self.market))
        self.assertAlmostEqual(result["risk"]["beta"], 2)
        self.assertAlmostEqual(result["holdings"][0]["risk_contribution"], 1)
        self.assertEqual(result["concentration"]["effective_positions"], 1)

    def test_currency_conversion_affects_value_and_history(self):
        portfolio = {**PORTFOLIO, "holdings": [{"ticker": "CADSTOCK", "shares": 2}]}
        snapshot = prepare_market([portfolio], "SPY", "1y", self.market)
        result = analyze(portfolio, snapshot)
        self.assertAlmostEqual(result["total_value"], self.market.assets["CADSTOCK"]["price"] * 2 * 0.72)
        self.assertAlmostEqual(result["holdings"][0]["fx_rate"], 0.72)
        self.assertEqual(result["concentration"]["currency_exposures"], [{"currency": "CAD", "weight": 1.0}])
        expected = self.market.assets["CADSTOCK"]["records"][0]["adjusted_close"] * 0.7
        self.assertAlmostEqual(snapshot["prices"]["CADSTOCK"].iloc[0], expected)

    def test_missing_prices_exclude_two_adjacent_returns_never_drop_position(self):
        self.market.assets["AAA"]["records"][80]["adjusted_close"] = None
        result = analyze(PORTFOLIO, prepare_market([PORTFOLIO], "SPY", "1y", self.market))
        self.assertEqual(result["coverage"]["observations"], 177)
        self.assertEqual(result["coverage"]["dropped_observations"], 2)
        self.assertEqual(len(result["holdings"]), 2)
        self.assertTrue(any("excludes these intervals" in warning for warning in result["warnings"]))

    def test_unpriced_holding_and_short_history_rejected(self):
        with self.assertRaisesRegex(UnsupportedAsset, "Unpriced"):
            prepare_market([{**PORTFOLIO, "holdings": [{"ticker": "MISSING", "shares": 1}]}], "SPY", "1y", self.market)
        self.market.assets["AAA"]["records"] = self.market.assets["AAA"]["records"][-30:]
        with self.assertRaisesRegex(ValueError, "60 common"):
            analyze(PORTFOLIO, prepare_market([PORTFOLIO], "SPY", "1y", self.market))

    def test_scenario_uses_common_window_and_does_not_mutate_inputs(self):
        baseline = deepcopy(PORTFOLIO)
        scenario = {**PORTFOLIO, "holdings": [{"ticker": "CADSTOCK", "shares": 10}]}
        self.market.assets["CADSTOCK"]["records"] = self.market.assets["CADSTOCK"]["records"][-100:]
        result = compare_scenario(baseline, scenario, prepare_market([baseline, scenario], "SPY", "1y", self.market))
        self.assertEqual(result["baseline"]["coverage"]["observations"], result["scenario"]["coverage"]["observations"])
        self.assertEqual(result["baseline"]["coverage"]["start_date"], result["scenario"]["coverage"]["start_date"])
        self.assertAlmostEqual(result["delta"]["beta"], result["scenario"]["risk"]["beta"] - result["baseline"]["risk"]["beta"])
        self.assertEqual(baseline, PORTFOLIO)

    def test_constant_benchmark_exposes_null_and_does_not_emit_nan(self):
        for row in self.market.assets["SPY"]["records"]:
            row["adjusted_close"] = 100
        result = analyze(PORTFOLIO, prepare_market([PORTFOLIO], "SPY", "1y", self.market))
        self.assertIsNone(result["risk"]["beta"])
        self.assertIsNone(result["risk"]["benchmark_correlation"])

    def test_risk_contributions_preserve_negative_hedging_effect(self):
        portfolio = {**PORTFOLIO, "holdings": [{"ticker": "AAA", "shares": 50}, {"ticker": "BBB", "shares": 1}]}
        result = analyze(portfolio, prepare_market([portfolio], "SPY", "1y", self.market))
        hedge = next(row for row in result["holdings"] if row["ticker"] == "BBB")
        self.assertLess(hedge["risk_contribution"], 0)
        self.assertAlmostEqual(sum(row["risk_contribution"] for row in result["holdings"]), 1)


class APITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)
        self.market = FixtureMarket()
        self.client = TestClient(create_app(self.path, self.market), base_url="http://127.0.0.1")

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def test_saved_portfolio_revision_and_private_persistence(self):
        created = self.client.post("/api/portfolios", json=PORTFOLIO)
        self.assertEqual(created.status_code, 201)
        saved = created.json()
        self.assertEqual(saved["revision"], 1)
        self.assertEqual(Store(self.path).list_portfolios()[0]["id"], saved["id"])
        changed = self.client.put("/api/portfolios/" + saved["id"], json={**PORTFOLIO, "name": "Changed", "revision": 1})
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(changed.json()["revision"], 2)
        self.assertEqual(self.client.put("/api/portfolios/" + saved["id"], json={**PORTFOLIO, "revision": 1}).status_code, 409)
        self.assertEqual(self.client.delete(f"/api/portfolios/{saved['id']}?revision=1").status_code, 409)
        self.assertEqual(self.client.delete(f"/api/portfolios/{saved['id']}?revision=2").status_code, 200)
        self.assertEqual(self.client.get("/api/portfolios").json(), {"portfolios": []})

    def test_analysis_works_without_saving_holdings(self):
        response = self.client.post("/api/analyze", json={"portfolio": PORTFOLIO, "benchmark": "SPY", "range": "1y"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["portfolio"], PORTFOLIO)
        self.assertEqual(self.client.get("/api/portfolios").json()["portfolios"], [])
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_bad_quantities_currency_and_duplicates(self):
        for entry in ({"ticker": "AAA", "shares": -1}, {"ticker": "AAA", "shares": 0}, {"ticker": "../secret", "shares": 1}):
            self.assertEqual(self.client.post("/api/portfolios", json={**PORTFOLIO, "holdings": [entry]}).status_code, 422)
        self.assertEqual(self.client.post("/api/analyze", json={"portfolio": {**PORTFOLIO, "base_currency": "EUR"}}).status_code, 422)
        result = self.client.post("/api/portfolios", json={**PORTFOLIO, "holdings": [{"ticker": " aaa ", "shares": 1}, {"ticker": "AAA", "shares": 2}]}).json()
        self.assertEqual(result["holdings"], [{"ticker": "AAA", "shares": 3}])

    def test_errors_do_not_drop_tickers_and_scenarios_keep_currency(self):
        failed = self.client.post("/api/analyze", json={"portfolio": {**PORTFOLIO, "holdings": [*PORTFOLIO["holdings"], {"ticker": "MISSING", "shares": 1}]}})
        self.assertEqual(failed.status_code, 422)
        self.assertIn("Unpriced", failed.json()["detail"])
        scenario = self.client.post("/api/scenario", json={"baseline": PORTFOLIO, "scenario": {**PORTFOLIO, "base_currency": "CAD"}})
        self.assertEqual(scenario.status_code, 422)

    def test_browser_origin_and_resource_endpoints(self):
        denied = self.client.post("/api/portfolios", json=PORTFOLIO, headers={"Origin": "https://external.example"})
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(len(self.client.get("/api/examples").json()["examples"]), 3)
        self.assertTrue(self.client.get("/api/assets/search?q=AAA").json()["results"])
        asset = self.client.get("/api/assets/AAA")
        self.assertEqual(asset.status_code, 200)
        self.assertNotIn("records", asset.json())


def chart_response(currency="USD", instrument="EQUITY"):
    now = datetime.now(timezone.utc)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    timestamps = [int((today - timedelta(days=2-i)).timestamp()) for i in range(3)]
    return {"chart": {"error": None, "result": [{
        "meta": {"symbol": "AAA", "currency": currency, "instrumentType": instrument, "longName": "Alpha",
                 "exchangeTimezoneName": "UTC", "currentTradingPeriod": {"regular": {"start": int(today.timestamp()), "end": int((today + timedelta(days=1)).timestamp())}}},
        "timestamp": timestamps, "indicators": {"quote": [{"close": [100, 102, 999]}], "adjclose": [{"adjclose": [98, 100, 998]}]},
    }]}}


class MarketTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name))
        self.market = Market(self.store)

    def tearDown(self):
        self.temp.cleanup()

    def test_adjusted_close_and_completed_day_only_are_preserved(self):
        with patch.object(self.market, "request", return_value=chart_response()) as source:
            result = self.market.chart("AAA")
            self.assertEqual(result["price"], 102)
            self.assertEqual(result["records"][-1]["adjusted_close"], 100)
            self.assertEqual(len(result["records"]), 2)
            cached = self.market.chart("AAA")
            self.assertEqual(cached["fetched_at"], result["fetched_at"])
            source.assert_called_once()
            self.market.chart("AAA", refresh=True)
            self.assertEqual(source.call_count, 2)

    def test_missing_adjustment_and_unsupported_currency_fail_closed(self):
        response = chart_response()
        del response["chart"]["result"][0]["indicators"]["adjclose"]
        with patch.object(self.market, "request", return_value=response), self.assertRaisesRegex(MarketUnavailable, "No unadjusted fallback"):
            self.market.chart("AAA")
        with patch.object(self.market, "request", return_value=chart_response(currency="GBP")), self.assertRaisesRegex(UnsupportedAsset, "GBP"):
            self.market.chart("AAA")

    def test_provider_failure_retains_existing_market_cache(self):
        with patch.object(self.market, "request", return_value=chart_response()):
            old = self.market.chart("AAA")
        with patch.object(self.market, "request", side_effect=MarketUnavailable("Rate limited")):
            with self.assertRaises(MarketUnavailable):
                self.market.chart("AAA", refresh=True)
            self.assertEqual(self.market.chart("AAA")["fetched_at"], old["fetched_at"])

    def test_invalid_timestamp_is_a_provider_error(self):
        response = chart_response()
        response["chart"]["result"][0]["timestamp"][0] = None
        with patch.object(self.market, "request", return_value=response), self.assertRaisesRegex(MarketUnavailable, "timestamp"):
            self.market.chart("AAA")

    def test_only_verified_fx_alias_is_accepted(self):
        response = chart_response(currency="CAD", instrument="CURRENCY")
        response["chart"]["result"][0]["meta"]["symbol"] = "CAD=X"
        with patch.object(self.market, "request", return_value=response):
            self.assertEqual(self.market.chart("USDCAD=X")["provider_symbol"], "CAD=X")
        wrong = chart_response()
        wrong["chart"]["result"][0]["meta"]["symbol"] = "MSFT"
        with patch.object(self.market, "request", return_value=wrong), self.assertRaisesRegex(MarketUnavailable, "instead of AAA"):
            self.market.chart("AAA")

    def test_sector_failure_is_explicit_unknown_not_invented(self):
        with patch.object(self.market, "chart", return_value={**chart_response()["chart"]["result"][0]["meta"], "ticker": "AAA", "instrument": "EQUITY", "warnings": []}), \
                patch.object(self.market, "search", side_effect=MarketUnavailable("Unavailable")):
            asset = self.market.asset("AAA")
        self.assertIsNone(asset["sector"])
        self.assertTrue(any("Unknown" in warning for warning in asset["warnings"]))

    @patch("backend.market.requests.get")
    def test_provider_requests_contain_market_identifiers_not_portfolio_quantities(self, request):
        response = Mock()
        response.json.return_value = chart_response()
        request.return_value = response
        self.market.chart("AAA")
        args, kwargs = request.call_args
        self.assertEqual(args[0], "https://query1.finance.yahoo.com/v8/finance/chart/AAA")
        self.assertEqual(set(kwargs["params"]), {"interval", "range", "includeAdjustedClose"})
        self.assertNotIn("data", kwargs)
        self.assertNotIn("json", kwargs)

    @patch("backend.market.requests.get", side_effect=requests.exceptions.Timeout("timeout"))
    def test_network_timeout_is_explicit(self, request):
        with self.assertRaisesRegex(MarketUnavailable, "unavailable"):
            self.market.chart("AAA")
