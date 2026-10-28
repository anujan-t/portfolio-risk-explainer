from io import StringIO
from pathlib import Path
import unittest

import numpy as np
import pandas as pd

import risk


class HoldingsTests(unittest.TestCase):
    def test_duplicate_positions_aggregate_and_tickers_normalize(self):
        holdings = risk.normalize_holdings(pd.DataFrame([
            {"ticker": " aaa ", "shares": 2, "price": 10},
            {"ticker": "AAA", "shares": 3, "price": 10},
            {"ticker": "BBB", "shares": 5, "price": 10},
        ]))
        self.assertEqual(len(holdings), 2)
        self.assertEqual(holdings["shares"].tolist(), [5, 5])
        self.assertEqual(risk.concentration(holdings)["effective_positions"], 2)
        self.assertEqual(risk.concentration(holdings)["top_3_weight"], 1)

    def test_short_nonfinite_and_inconsistent_values_rejected(self):
        base = pd.DataFrame([{"ticker": "AAA", "shares": 1, "price": 10}])
        for column, value in [("shares", -1), ("shares", 0), ("price", float("inf")), ("price", 0), ("ticker", None)]:
            frame = base.copy()
            frame[column] = frame[column].astype(object)
            frame.loc[0, column] = value
            with self.subTest(column=column, value=value), self.assertRaises(ValueError):
                risk.normalize_holdings(frame)
        with self.assertRaisesRegex(ValueError, "inconsistent prices"):
            risk.normalize_holdings(pd.DataFrame([{"ticker": "AAA", "shares": 1, "price": 10}, {"ticker": "AAA", "shares": 2, "price": 11}]))

    def test_concentration_does_not_assume_sorted_index(self):
        holdings = pd.DataFrame({"ticker": ["AAA", "BBB"], "weight": [0.2, 0.8]}, index=[100, 200])
        result = risk.concentration(holdings)
        self.assertEqual(result["largest_position"], "BBB")
        self.assertAlmostEqual(result["hhi"], 0.68)
        for top_n in (0, -1, 1.5, True):
            with self.assertRaises(ValueError):
                risk.concentration(holdings, top_n)


class ReturnTests(unittest.TestCase):
    def test_missing_prices_never_become_zero_or_multiday_returns(self):
        returns = risk.returns_from_prices(StringIO(
            "date,AAA,SPY\n2026-01-01,100,100\n2026-01-02,,101\n2026-01-03,110,102\n2026-01-04,121,103\n"
        ))
        self.assertTrue(pd.isna(returns.loc["2026-01-02", "AAA"]))
        self.assertTrue(pd.isna(returns.loc["2026-01-03", "AAA"]))
        self.assertAlmostEqual(returns.loc["2026-01-04", "AAA"], 0.1)

    def test_partial_portfolio_cannot_be_reweighted_and_reported_as_full_risk(self):
        holdings = pd.DataFrame({"ticker": ["AAA", "BBB"], "weight": [0.5, 0.5]})
        returns = pd.DataFrame({"AAA": [0.01, -0.02, 0.03], "SPY": [0.01, 0.02, -0.01]})
        with self.assertRaisesRegex(ValueError, "missing history for: BBB"):
            risk.volatility_and_beta(holdings, returns)

    def test_aligned_beta_uses_same_complete_sample(self):
        holdings = pd.DataFrame({"ticker": ["AAA"], "weight": [1.0]})
        returns = pd.DataFrame({"AAA": [0.02, -0.04, 0.06, 0.12], "SPY": [0.01, -0.02, 0.03, np.nan]})
        result = risk.volatility_and_beta(holdings, returns)
        self.assertAlmostEqual(result["beta"], 2)
        self.assertEqual(result["days_of_history"], 3)
        self.assertEqual(result["dropped_observations"], 1)

    def test_flat_benchmark_and_duplicate_dates(self):
        holdings = pd.DataFrame({"ticker": ["AAA"], "weight": [1.0]})
        result = risk.volatility_and_beta(holdings, pd.DataFrame({"AAA": [0.01, -0.01, 0.02], "SPY": [0, 0, 0]}))
        self.assertIsNone(result["beta"])
        with self.assertRaisesRegex(ValueError, "unique"):
            risk.returns_from_prices(StringIO("date,AAA\n2026-01-01,10\n2026-01-01,11\n"))

    def test_original_example_preserves_valid_results(self):
        root = Path(__file__).resolve().parent.parent
        _, report = risk.summarize(root / "data" / "sample_holdings.csv", root / "data" / "sample_prices.csv")
        self.assertAlmostEqual(report["concentration"]["hhi"], 0.1810, places=4)
        self.assertAlmostEqual(report["market_risk"]["annual_volatility"], 0.1769, places=4)
        self.assertAlmostEqual(report["market_risk"]["beta"], 1.0865, places=4)
