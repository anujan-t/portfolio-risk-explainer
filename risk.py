"""Portfolio risk metrics shared by the web application and legacy CSV CLI."""

import argparse
import re

import numpy as np
import pandas as pd

TRADING_DAYS = 252


def normalize_holdings(frame):
    required = {"ticker", "shares", "price"}
    missing = required - set(frame.columns)
    if missing:
        raise ValueError(f"holdings are missing fields: {sorted(missing)}")
    if frame.empty:
        raise ValueError("at least one holding is required")
    frame = frame.copy()
    if frame["ticker"].isna().any():
        raise ValueError("ticker cannot be missing")
    frame["ticker"] = frame["ticker"].astype(str).str.strip().str.upper()
    if not frame["ticker"].map(lambda ticker: re.fullmatch(r"[A-Z0-9][A-Z0-9.^=-]{0,19}", ticker) is not None).all():
        raise ValueError("invalid ticker symbol")
    for column in ("shares", "price"):
        values = pd.to_numeric(frame[column], errors="raise")
        if not np.isfinite(values).all() or values.le(0).any():
            raise ValueError(f"{column} must contain finite positive numbers; short positions are not supported")
        frame[column] = values.astype(float)
    if "sector" in frame:
        frame["sector"] = frame["sector"].fillna("Unknown").astype(str).str.strip().replace("", "Unknown")
    if frame["ticker"].duplicated().any():
        if frame.groupby("ticker")["price"].nunique().gt(1).any():
            raise ValueError("duplicate ticker rows have inconsistent prices")
        if "sector" in frame and frame.groupby("ticker")["sector"].nunique().gt(1).any():
            raise ValueError("duplicate ticker rows have inconsistent sectors")
        aggregates = {"shares": "sum", "price": "first"}
        if "sector" in frame:
            aggregates["sector"] = "first"
        frame = frame.groupby("ticker", as_index=False).agg(aggregates)
    frame["market_value"] = frame["shares"] * frame["price"]
    total = float(frame["market_value"].sum())
    if not np.isfinite(total) or total <= 0:
        raise ValueError("total market value must be finite and positive")
    frame["weight"] = frame["market_value"] / total
    return frame.sort_values("weight", ascending=False).reset_index(drop=True)


def load_holdings(path):
    return normalize_holdings(pd.read_csv(path))


def holding_weights(holdings):
    if holdings.empty or not {"ticker", "weight"}.issubset(holdings.columns):
        raise ValueError("holdings need ticker and weight fields")
    if holdings["ticker"].duplicated().any():
        raise ValueError("aggregate duplicate tickers before computing risk")
    weights = pd.to_numeric(holdings.set_index("ticker")["weight"], errors="raise")
    if not np.isfinite(weights).all() or weights.le(0).any() or not np.isclose(weights.sum(), 1, rtol=0, atol=1e-8):
        raise ValueError("long-only portfolio weights must be positive and sum to one")
    return weights


def concentration(holdings, top_n=3):
    if isinstance(top_n, bool) or not isinstance(top_n, int) or top_n < 1:
        raise ValueError("top_n must be a positive integer")
    weights = holding_weights(holdings)
    ranked = weights.sort_values(ascending=False)
    hhi = float(np.sum(weights.to_numpy() ** 2))
    out = {
        "positions": len(weights), "hhi": hhi, "effective_positions": 1 / hhi,
        "largest_position": str(ranked.index[0]), "largest_weight": float(ranked.iloc[0]),
        f"top_{top_n}_weight": float(ranked.head(top_n).sum()),
    }
    if "sector" in holdings:
        sectors = holdings["sector"].fillna("Unknown").replace("", "Unknown")
        by_sector = holdings.assign(sector=sectors).groupby("sector")["weight"].sum().sort_values(ascending=False)
        out.update(largest_sector=str(by_sector.index[0]), largest_sector_weight=float(by_sector.iloc[0]))
    return out


def price_returns(prices):
    prices = prices.copy()
    if prices.empty or prices.columns.duplicated().any():
        raise ValueError("price history must have rows and unique ticker columns")
    if not isinstance(prices.index, pd.DatetimeIndex):
        prices.index = pd.to_datetime(prices.index, errors="raise")
    if prices.index.hasnans or prices.index.duplicated().any():
        raise ValueError("price dates must be valid and unique")
    prices = prices.sort_index().apply(pd.to_numeric, errors="raise")
    valid = prices.stack().to_numpy()
    if not np.isfinite(valid).all() or (valid <= 0).any():
        raise ValueError("observed prices must be finite and positive")
    # Calculate on the unfilled union calendar before alignment, avoiding fictitious
    # zero returns and multi-day returns mislabeled as one-day observations.
    return prices.pct_change(fill_method=None).replace([np.inf, -np.inf], np.nan).dropna(how="all")


def returns_from_prices(path):
    prices = pd.read_csv(path, parse_dates=["date"]).set_index("date")
    return price_returns(prices)


def align_returns(holdings, returns, benchmark=None, minimum=2):
    weights = holding_weights(holdings)
    missing = sorted(set(weights.index) - set(returns.columns))
    if missing:
        raise ValueError(f"cannot price the full portfolio; missing history for: {', '.join(missing)}")
    columns = list(weights.index)
    if benchmark is not None:
        if benchmark not in returns:
            raise ValueError(f"benchmark history is missing: {benchmark}")
        if benchmark not in columns:
            columns.append(benchmark)
    selected = returns.loc[:, columns].apply(pd.to_numeric, errors="raise")
    observations = selected.dropna(how="all").shape[0]
    aligned = selected.replace([np.inf, -np.inf], np.nan).dropna()
    if len(aligned) < minimum:
        raise ValueError(f"at least {minimum} common observed daily returns are required; found {len(aligned)}")
    return weights, aligned, observations - len(aligned), observations


def volatility_and_beta(holdings, returns, benchmark="SPY"):
    has_benchmark = benchmark in returns
    weights, aligned, dropped, _ = align_returns(holdings, returns, benchmark if has_benchmark else None)
    portfolio = aligned[weights.index].mul(weights, axis=1).sum(axis=1, min_count=len(weights))
    result = {
        "days_of_history": len(portfolio), "daily_volatility": float(portfolio.std(ddof=1)),
        "annual_volatility": float(portfolio.std(ddof=1) * np.sqrt(TRADING_DAYS)),
        "tickers_priced": len(weights), "tickers_missing": [], "dropped_observations": dropped,
    }
    if has_benchmark:
        bench = aligned[benchmark]
        variance = float(bench.var(ddof=1))
        result["beta"] = float(portfolio.cov(bench) / variance) if variance > 1e-16 else None
        result["benchmark"] = benchmark
        if result["beta"] is None:
            result["beta_warning"] = "benchmark variance is zero; beta is undefined"
    return result


def summarize(holdings_path, prices_path=None, benchmark="SPY"):
    holdings = load_holdings(holdings_path)
    report = {"concentration": concentration(holdings)}
    if prices_path:
        report["market_risk"] = volatility_and_beta(holdings, returns_from_prices(prices_path), benchmark)
    return holdings, report


def main():
    parser = argparse.ArgumentParser(description="Compute portfolio risk metrics (legacy CSV command).")
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
            print(f"  {key:<24} {value:,.4f}" if isinstance(value, float) else f"  {key:<24} {value}")
    print()


if __name__ == "__main__":
    main()
