from datetime import datetime, timezone
import math

import numpy as np
import pandas as pd

from risk import TRADING_DAYS, align_returns, concentration, normalize_holdings, price_returns
from .market import SOURCE

MIN_OBSERVATIONS = 60


def number_or_none(value):
    return float(value) if pd.notna(value) and np.isfinite(value) else None


def prepare_market(portfolios, benchmark, history_range, market, refresh=False):
    base = portfolios[0]["base_currency"]
    if any(portfolio["base_currency"] != base for portfolio in portfolios):
        raise ValueError("Baseline and scenario must use the same reporting currency.")
    tickers = sorted({h["ticker"] for portfolio in portfolios for h in portfolio["holdings"]} | {benchmark})
    assets = {ticker: market.asset(ticker, history_range, refresh) for ticker in tickers}
    fx = {}
    prices, rates = {}, {}
    for ticker, asset in assets.items():
        series = pd.Series(
            {pd.Timestamp(row["date"]): row["adjusted_close"] for row in asset["records"]}, dtype=float,
        ).sort_index()
        currency = asset["currency"]
        if currency == base:
            rates[ticker] = (1.0, asset["price_date"])
            prices[ticker] = series
        else:
            pair = f"{currency}{base}=X"
            if pair not in fx:
                fx[pair] = market.chart(pair, history_range, refresh)
            conversion = fx[pair]
            fx_series = pd.Series(
                {pd.Timestamp(row["date"]): row["adjusted_close"] for row in conversion["records"]}, dtype=float,
            ).sort_index()
            prices[ticker] = series * fx_series.reindex(series.index)
            rates[ticker] = (conversion["price"], conversion["price_date"])
    price_frame = pd.DataFrame(prices).sort_index()
    returns = price_returns(price_frame)
    return {
        "assets": assets, "rates": rates, "fx": fx, "prices": price_frame,
        "returns": returns, "benchmark": benchmark, "range": history_range, "base": base,
    }


def explanations(holdings, conc, metrics, benchmark, observations, base):
    top = holdings[0]
    rows = [
        {
            "title": "The portfolio's largest exposure",
            "text": f"{top['ticker']} represents {top['weight']:.1%} of the entered portfolio value. "
                    f"The top three positions account for {conc['top_3_weight']:.1%}; a large position can dominate results even when other holdings differ.",
            "severity": "warning" if top["weight"] > 0.3 else "info", "metric": "Position weights",
        },
        {
            "title": "Position count is not diversification",
            "text": f"There are {conc['positions']} distinct securities, but their weights are equivalent to "
                    f"{conc['effective_positions']:.2f} equally weighted positions by concentration. This measure does not account for correlations or ETF underlying holdings.",
            "severity": "info", "metric": "HHI and effective positions",
        },
        {
            "title": "Historical variability, not a loss forecast",
            "text": f"Across {observations} aligned daily return observations, annualized volatility is {metrics['annual_volatility']:.1%}. "
                    "It measures the spread of historical returns; it is not a prediction that this amount will be gained or lost.",
            "severity": "info", "metric": "Standard deviation × square root of 252",
        },
        {
            "title": "Market sensitivity",
            "text": (f"Beta to {benchmark} is {metrics['beta']:.2f} over the same observation window. "
                     "It describes historical co-movement, not a guaranteed response to the next market move.")
                    if metrics["beta"] is not None else f"{benchmark} has effectively zero return variance in this sample; beta is undefined.",
            "severity": "info", "metric": "Covariance / benchmark variance",
        },
        {
            "title": "A historical downside reference",
            "text": f"The 95% historical one-day loss threshold is {metrics['historical_var_95']:.1%} "
                    f"(about {base} {metrics['var_amount']:,.0f} at the current entered value). "
                    f"Average loss beyond that return threshold is {metrics['historical_es_95']:.1%}. Future losses can be larger.",
            "severity": "info", "metric": "Historical VaR and expected shortfall",
        },
        {
            "title": "Read the simulated path correctly",
            "text": f"The largest peak-to-trough decline in the simulated path is {metrics['max_drawdown']:.1%}. "
                    "The path applies today's weights to past adjusted daily returns, assuming daily rebalancing; it does not reconstruct your account performance.",
            "severity": "info", "metric": "Historical constant-weight drawdown",
        },
    ]
    if conc["fund_weight"] > 0 or conc["unknown_sector_weight"] > 0:
        rows.append({
            "title": "Look-through limits stay visible",
            "text": f"{conc['fund_weight']:.1%} is held in funds without underlying sector look-through, and "
                    f"{conc['unknown_sector_weight']:.1%} has unknown security-sector classification. ETF overlap and the full portfolio's sector mix cannot be inferred from ticker counts alone.",
            "severity": "warning", "metric": "Sector-data coverage",
        })
    drivers = [h for h in holdings if h["risk_contribution"] is not None]
    if drivers:
        driver = max(drivers, key=lambda h: h["risk_contribution"])
        rows.append({
            "title": "Where the measured risk comes from",
            "text": f"{driver['ticker']} contributes {driver['risk_contribution']:.1%} of modeled portfolio volatility in this sample. "
                    "Contribution includes co-movement with the other holdings; a negative contribution would indicate historical hedging behavior, not a risk-free asset.",
            "severity": "info", "metric": "Covariance-based Euler risk contribution",
        })
    return rows


def analyze(portfolio, snapshot, common_index=None):
    base, benchmark = snapshot["base"], snapshot["benchmark"]
    assets = snapshot["assets"]
    rows = []
    for entry in portfolio["holdings"]:
        asset = assets[entry["ticker"]]
        rate, fx_date = snapshot["rates"][entry["ticker"]]
        row = {key: value for key, value in asset.items() if key != "records"}
        row.update(shares=entry["shares"], fx_rate=rate, fx_date=fx_date, price_base=asset["price"] * rate)
        row["market_value"] = row["shares"] * row["price_base"]
        rows.append(row)
    normalized = normalize_holdings(pd.DataFrame([
        {"ticker": row["ticker"], "shares": row["shares"], "price": row["price_base"]} for row in rows
    ]))
    weight_map = dict(zip(normalized["ticker"], normalized["weight"]))
    rows.sort(key=lambda row: weight_map[row["ticker"]], reverse=True)
    for row in rows:
        row["weight"] = float(weight_map[row["ticker"]])
    total = float(normalized["market_value"].sum())
    returns = snapshot["returns"]
    weights, aligned, dropped, candidates = align_returns(normalized, returns, benchmark, minimum=MIN_OBSERVATIONS)
    if common_index is not None:
        aligned = aligned.loc[common_index]
        dropped = candidates - len(aligned)
        if len(aligned) < MIN_OBSERVATIONS:
            raise ValueError("Baseline and scenario need at least 60 common observed daily returns.")
    portfolio_returns = aligned[weights.index].mul(weights, axis=1).sum(axis=1, min_count=len(weights))
    bench_returns = aligned[benchmark]
    covariance = aligned[weights.index].cov().to_numpy()
    w = weights.to_numpy()
    variance = float(w @ covariance @ w)
    daily_volatility = math.sqrt(max(0.0, variance))
    benchmark_variance = float(bench_returns.var(ddof=1))
    beta = float(portfolio_returns.cov(bench_returns) / benchmark_variance) if benchmark_variance > 1e-16 else None
    contributions = w * (covariance @ w) / variance if variance > 1e-16 else [None] * len(w)
    by_ticker = dict(zip(weights.index, contributions))
    for row in rows:
        series = aligned[row["ticker"]]
        row["annual_volatility"] = float(series.std(ddof=1) * math.sqrt(TRADING_DAYS))
        row["beta"] = float(series.cov(bench_returns) / benchmark_variance) if benchmark_variance > 1e-16 else None
        row["risk_contribution"] = number_or_none(by_ticker[row["ticker"]])
    portfolio_index = np.r_[100.0, 100.0 * np.cumprod(1 + portfolio_returns.to_numpy())]
    benchmark_index = np.r_[100.0, 100.0 * np.cumprod(1 + bench_returns.to_numpy())]
    drawdown = portfolio_index / np.maximum.accumulate(portfolio_index) - 1
    threshold = float(np.quantile(portfolio_returns, 0.05))
    tail = portfolio_returns[portfolio_returns <= threshold]
    var, es = max(0.0, -threshold), max(0.0, -float(tail.mean()))
    metrics = {
        "annual_volatility": daily_volatility * math.sqrt(TRADING_DAYS), "daily_volatility": daily_volatility,
        "beta": beta, "benchmark_volatility": math.sqrt(max(0.0, benchmark_variance) * TRADING_DAYS),
        "benchmark_correlation": number_or_none(portfolio_returns.corr(bench_returns)) if daily_volatility > 1e-8 and benchmark_variance > 1e-16 else None,
        "max_drawdown": float(drawdown.min()), "historical_return": float(portfolio_index[-1] / 100 - 1),
        "benchmark_return": float(benchmark_index[-1] / 100 - 1),
        "historical_var_95": var, "historical_es_95": es, "worst_day": float(portfolio_returns.min()),
        "best_day": float(portfolio_returns.max()), "var_amount": var * total, "es_amount": es * total,
    }
    conc = concentration(normalized)
    sectors, currencies = {}, {}
    unknown_weight, fund_weight = 0.0, 0.0
    for row in rows:
        sector = "Funds (no look-through)" if row["instrument"] == "ETF" else row["sector"] or "Unknown"
        sectors[sector] = sectors.get(sector, 0) + row["weight"]
        currencies[row["currency"]] = currencies.get(row["currency"], 0) + row["weight"]
        if row["instrument"] == "ETF":
            fund_weight += row["weight"]
        elif row["sector"] is None:
            unknown_weight += row["weight"]
    conc.update(
        sector_exposures=[{"sector": key, "weight": value} for key, value in sorted(sectors.items(), key=lambda item: -item[1])],
        currency_exposures=[{"currency": key, "weight": value} for key, value in sorted(currencies.items(), key=lambda item: -item[1])],
        unknown_sector_weight=unknown_weight, fund_weight=fund_weight,
    )
    prior_dates = snapshot["prices"].index[snapshot["prices"].index < aligned.index[0]]
    if not len(prior_dates):
        raise ValueError("The first aligned return has no prior price observation.")
    dates = [prior_dates[-1], *aligned.index]
    series = [
        {"date": day.strftime("%Y-%m-%d"), "portfolio": float(portfolio_index[i]), "benchmark": float(benchmark_index[i]),
         "drawdown": float(drawdown[i]), "daily_return": float(portfolio_returns.iloc[i - 1]) if i else 0.0}
        for i, day in enumerate(dates)
    ]
    corr = aligned[weights.index].corr()
    matrix = [[number_or_none(value) for value in row] for row in corr.to_numpy()]
    warnings = list(dict.fromkeys([warning for asset in assets.values() for warning in asset["warnings"]]))
    warnings.extend(warning for item in snapshot["fx"].values() for warning in item["warnings"])
    if dropped:
        warnings.append(f"{dropped} candidate daily return rows were excluded because at least one required price, FX rate or prior observation was missing. The simulated path excludes these intervals; it is not continuous realized portfolio performance.")
    if snapshot["fx"]:
        warnings.append("USD/CAD exposures use observed same-date FX history; missing FX days are not filled. Equity and FX closes have different market conventions, and latest valuation dates can differ.")
    if len(aligned) < 126:
        warnings.append("Fewer than 126 aligned trading-day observations are available. Volatility, beta and tail estimates may be unstable.")
    if beta is None:
        warnings.append("Benchmark variance is effectively zero; beta and benchmark correlation are undefined.")
    warnings.append("Research only. Historical estimates can change sharply and do not cover liquidity, leverage, options, intraday gaps or future market regimes.")
    fetched = [a["fetched_at"] for a in assets.values()] + [item["fetched_at"] for item in snapshot["fx"].values()]
    return {
        "portfolio": portfolio, "total_value": total, "holdings": rows, "concentration": conc, "risk": metrics,
        "benchmark": {"ticker": benchmark, "name": assets[benchmark]["name"], "currency": assets[benchmark]["currency"]},
        "coverage": {
            "requested_range": snapshot["range"], "start_date": dates[0].strftime("%Y-%m-%d"),
            "end_date": dates[-1].strftime("%Y-%m-%d"), "observations": len(aligned),
            "candidate_observations": candidates, "dropped_observations": dropped, "priced_weight": 1.0,
            "return_method": "Adjacent observed adjusted-close returns; complete-case alignment; no forward filling",
        },
        "series": series, "correlations": {"tickers": list(weights.index), "matrix": matrix},
        "explanations": explanations(rows, conc, metrics, benchmark, len(aligned), base),
        "explanation_method": "Deterministic explanations grounded in the computed metrics; not an LLM",
        "warnings": warnings,
        "assumptions": [
            "Long-only equity/ETF positions; fractional shares supported. No margin, short positions, derivatives, cash yield or transaction costs.",
            "Valuation uses each security's most recent completed daily close, not a real-time executable quote.",
            "History uses dividend/split-adjusted closes. Current portfolio weights are applied to each historical daily return as if rebalanced daily.",
            "The simulated index starts at 100. It is not your account performance and excludes trades, deposits, withdrawals, taxes and fees.",
            "Beta, correlations and risk contributions share exactly the same complete observation window and base currency.",
            "95% historical VaR is the nonnegative loss corresponding to the fifth return percentile. ES averages all returns at or below that threshold.",
            "Sector buckets describe individual securities; fund holdings, ETF overlap and underlying geographic/currency exposures are not looked through.",
            "Explanations are transparent rule-based summaries, not generated by an external LLM. Holdings and share counts are never sent to the market provider.",
        ],
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="microseconds"),
        "market_fetched_at": min(fetched, key=lambda value: datetime.fromisoformat(value)), "source": SOURCE,
    }


def compare_scenario(baseline, scenario, snapshot):
    needed = sorted({h["ticker"] for p in (baseline, scenario) for h in p["holdings"]} | {snapshot["benchmark"]})
    common = snapshot["returns"][needed].dropna().index
    if len(common) < MIN_OBSERVATIONS:
        raise ValueError(f"Scenario comparison needs at least {MIN_OBSERVATIONS} jointly observed returns; found {len(common)}.")
    before, after = analyze(baseline, snapshot, common), analyze(scenario, snapshot, common)
    return {
        "baseline": before, "scenario": after,
        "delta": {
            "total_value": after["total_value"] - before["total_value"],
            "annual_volatility": after["risk"]["annual_volatility"] - before["risk"]["annual_volatility"],
            "beta": after["risk"]["beta"] - before["risk"]["beta"] if before["risk"]["beta"] is not None and after["risk"]["beta"] is not None else None,
            "max_drawdown": after["risk"]["max_drawdown"] - before["risk"]["max_drawdown"],
            "effective_positions": after["concentration"]["effective_positions"] - before["concentration"]["effective_positions"],
        },
    }
