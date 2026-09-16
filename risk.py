"""
Portfolio Risk Explainer — metrics layer.

Reads a brokerage holdings CSV and, optionally, a price history CSV,
then computes the risk numbers the narration layer will explain.

Usage:
    python risk.py data/sample_holdings.csv --prices data/sample_prices.csv
"""

import argparse
import numpy as np
import pandas as pd

TRADING_DAYS = 252


def load_holdings(path):
    """Read a holdings CSV and derive portfolio weights.

    Expected columns: ticker, shares, price. A sector column is optional.
    """
    df = pd.read_csv(path)
    required = {"ticker", "shares", "price"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"holdings file is missing columns: {sorted(missing)}")

    df["market_value"] = df["shares"] * df["price"]
    total = df["market_value"].sum()
    if total <= 0:
        raise ValueError("total market value must be positive")
    df["weight"] = df["market_value"] / total
    return df.sort_values("weight", ascending=False).reset_index(drop=True)


def concentration(holdings, top_n=3):
    """How much of the portfolio sits in too few places.

    HHI is the sum of squared weights: 1.0 is everything in one position,
    1/n is a perfectly even split across n positions.
    """
    weights = holdings["weight"].to_numpy()
    out = {
        "positions": int(len(weights)),
        "hhi": float(np.sum(weights ** 2)),
        "effective_positions": float(1.0 / np.sum(weights ** 2)),
        "largest_position": holdings.loc[0, "ticker"],
        "largest_weight": float(weights[0]),
        f"top_{top_n}_weight": float(np.sort(weights)[::-1][:top_n].sum()),
    }
    if "sector" in holdings.columns:
        by_sector = holdings.groupby("sector")["weight"].sum().sort_values(ascending=False)
        out["largest_sector"] = str(by_sector.index[0])
        out["largest_sector_weight"] = float(by_sector.iloc[0])
    return out


def returns_from_prices(path):
    """Daily percentage returns from a wide price history (date + one column per ticker)."""
    prices = pd.read_csv(path, parse_dates=["date"]).set_index("date").sort_index()
    return prices.pct_change().dropna(how="all")


def volatility_and_beta(holdings, returns, benchmark="SPY"):
    """Annualised volatility of the portfolio, and its beta to the benchmark."""
    tickers = [t for t in holdings["ticker"] if t in returns.columns]
    if not tickers:
        raise ValueError("no overlap between holdings tickers and price history columns")

    weights = holdings.set_index("ticker").loc[tickers, "weight"]
    weights = weights / weights.sum()
    portfolio_returns = returns[tickers].mul(weights, axis=1).sum(axis=1)

    result = {
        "days_of_history": int(len(portfolio_returns)),
        "daily_volatility": float(portfolio_returns.std()),
        "annual_volatility": float(portfolio_returns.std() * np.sqrt(TRADING_DAYS)),
        "tickers_priced": len(tickers),
        "tickers_missing": sorted(set(holdings["ticker"]) - set(tickers)),
    }

    if benchmark in returns.columns:
        bench = returns[benchmark].loc[portfolio_returns.index]
        covariance = np.cov(portfolio_returns, bench)[0][1]
        result["beta"] = float(covariance / np.var(bench, ddof=1))
        result["benchmark"] = benchmark
    return result


def summarize(holdings_path, prices_path=None, benchmark="SPY"):
    holdings = load_holdings(holdings_path)
    report = {"concentration": concentration(holdings)}
    if prices_path:
        report["market_risk"] = volatility_and_beta(
            holdings, returns_from_prices(prices_path), benchmark
        )
    return holdings, report


def main():
    parser = argparse.ArgumentParser(description="Compute portfolio risk metrics.")
    parser.add_argument("holdings", help="CSV with ticker, shares, price columns")
    parser.add_argument("--prices", help="optional wide CSV of daily prices")
    parser.add_argument("--benchmark", default="SPY")
    args = parser.parse_args()

    holdings, report = summarize(args.holdings, args.prices, args.benchmark)

    print("\nHoldings")
    print(holdings[["ticker", "market_value", "weight"]].to_string(index=False))

    for section, metrics in report.items():
        print(f"\n{section.replace('_', ' ').title()}")
        for key, value in metrics.items():
            if isinstance(value, float):
                print(f"  {key:<24} {value:,.4f}")
            else:
                print(f"  {key:<24} {value}")
    print()


if __name__ == "__main__":
    main()
