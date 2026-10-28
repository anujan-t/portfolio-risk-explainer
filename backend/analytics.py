from datetime import datetime, timezone
import math
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from risk import align_returns, concentration, normalize_holdings, price_returns
from .market import SOURCE

FUND_SECTOR = "Funds (no look-through)"
UNKNOWN_SECTOR = "Unknown"
# periods per year, horizon label, minimum aligned observations
FREQUENCIES = {"daily": (252, "day", 60), "weekly": (52, "week", 26)}
TIMEZONE_SPREAD_HOURS = 3
# Short windows fetch two years so trailing one-year holding returns are exact; analysis is trimmed back.
FETCH_RANGE = {"6mo": "2y", "1y": "2y"}
WINDOWS = {"6mo": pd.DateOffset(months=6), "1y": pd.DateOffset(years=1), "2y": pd.DateOffset(years=2),
           "5y": pd.DateOffset(years=5), "10y": pd.DateOffset(years=10), "max": None}


def number_or_none(value):
    return float(value) if value is not None and pd.notna(value) and np.isfinite(value) else None


def utc_offset_hours(zone_name, at):
    return at.astimezone(ZoneInfo(zone_name)).utcoffset().total_seconds() / 3600


def resolve_frequency(requested, assets, history_range, at=None):
    at = at or datetime.now(timezone.utc)
    if requested == "weekly" and history_range == "6mo":
        raise ValueError("Weekly analysis needs at least one year of history; choose 1Y or longer, or use daily returns.")
    if requested in ("daily", "weekly"):
        return requested, f"{requested.capitalize()} returns were requested."
    offsets = [utc_offset_hours(asset["exchange_timezone"], at) for asset in assets.values()]
    spread = max(offsets) - min(offsets)
    if spread < TIMEZONE_SPREAD_HOURS:
        return "daily", "All holdings and the benchmark close within the same time-zone band, so daily returns are synchronous."
    if history_range == "6mo":
        return "daily", (f"Markets close up to {spread:g} hours apart, but six months is too short for weekly returns. "
                         "Daily co-movement across these markets may be understated.")
    return "weekly", (f"Markets close up to {spread:g} hours apart. Weekly returns reduce distortions from "
                      "non-synchronous closing prices and different holidays.")


def adjusted_series(asset):
    return pd.Series({pd.Timestamp(row["date"]): row["adjusted_close"] for row in asset["records"]}, dtype=float).sort_index()


def prepare_market(portfolios, benchmark, history_range, market, refresh=False, frequency="auto"):
    base = portfolios[0]["base_currency"]
    if any(portfolio["base_currency"] != base for portfolio in portfolios):
        raise ValueError("Baseline and scenario must use the same reporting currency.")
    tickers = sorted({h["ticker"] for portfolio in portfolios for h in portfolio["holdings"]} | {benchmark})
    fetch = FETCH_RANGE.get(history_range, history_range)
    assets = {ticker: market.asset(ticker, fetch, refresh) for ticker in tickers}
    conversions = {}
    for asset in assets.values():
        iso = asset["currency_iso"]
        if iso != base and iso not in conversions:
            conversions[iso] = market.fx(iso, base, fetch, refresh)
    prices, rates, fx_series = {}, {}, {}
    for ticker, asset in assets.items():
        local = adjusted_series(asset) * asset["currency_scale"]
        if asset["currency_iso"] == base:
            prices[ticker] = local
            rates[ticker] = (1.0, asset["price_date"])
        else:
            conversion = conversions[asset["currency_iso"]]
            series = pd.Series({pd.Timestamp(day): rate for day, rate in conversion["series"].items()}, dtype=float).sort_index()
            fx_series[asset["currency_iso"]] = series
            # Same-date FX only: a missing rate leaves a missing converted price, never a filled one.
            prices[ticker] = local * series.reindex(local.index)
            rates[ticker] = (conversion["rate"], conversion["date"])
    daily = pd.DataFrame(prices).sort_index()
    if WINDOWS[history_range] is not None and len(daily.index):
        daily = daily[daily.index >= daily.index.max() - WINDOWS[history_range]]
    resolved, reason = resolve_frequency(frequency, assets, history_range)
    if resolved == "weekly":
        weekly = daily.resample("W-FRI").last()
        # Drop an unfinished final week so every observation is a complete week.
        frame = weekly[weekly.index <= daily.index.max()]
    else:
        frame = daily
    return {
        "assets": assets, "rates": rates, "fx": conversions, "fx_series": fx_series, "prices": frame,
        "returns": price_returns(frame), "benchmark": benchmark, "range": history_range, "base": base,
        "frequency": resolved, "requested_frequency": frequency, "frequency_reason": reason,
    }


def asof(series, day):
    eligible = series[series.index <= day].dropna()
    return float(eligible.iloc[-1]) if len(eligible) else None


def holding_session(asset, base, fx_series, market_value):
    valid = [row for row in asset["records"] if row["adjusted_close"] and row["close"]]
    if len(valid) < 2:
        return None
    last, previous = valid[-1], valid[-2]
    local_return = last["adjusted_close"] / previous["adjusted_close"] - 1
    base_return = local_return
    if asset["currency_iso"] != base:
        series = fx_series.get(asset["currency_iso"])
        now_rate = asof(series, pd.Timestamp(last["date"])) if series is not None else None
        then_rate = asof(series, pd.Timestamp(previous["date"])) if series is not None else None
        base_return = (1 + local_return) * now_rate / then_rate - 1 if now_rate and then_rate else None
    change = market_value * base_return / (1 + base_return) if base_return is not None else None
    return {"date": last["date"], "previous_date": previous["date"], "return_local": local_return,
            "return_base": base_return, "change_base": change}


def period_returns(asset):
    series = adjusted_series(asset).dropna()
    if len(series) < 2:
        return {"m1": None, "y1": None}
    end = series.index[-1]

    def since(offset):
        start = end - offset
        if series.index[0] > start:
            return None
        anchor = asof(series, start)
        return float(series.iloc[-1] / anchor - 1) if anchor else None

    return {"m1": since(pd.DateOffset(months=1)), "y1": since(pd.DateOffset(years=1))}


def explanations(holdings, conc, metrics, benchmark, observations, base, frequency):
    unit = "daily" if frequency == "daily" else "weekly"
    horizon = "one-day" if frequency == "daily" else "one-week"
    top = holdings[0]
    rows = [
        {"title": "Largest exposure",
         "text": f"{top['ticker']} is {top['weight']:.1%} of the portfolio's current value, and the three largest positions are "
                 f"{conc['top_3_weight']:.1%}. A dominant position can drive results even when the others behave differently.",
         "severity": "warning" if top["weight"] > 0.3 else "info", "metric": "Position weights"},
        {"title": "Position count versus concentration",
         "text": f"There are {conc['positions']} securities, but their weights are equivalent to {conc['effective_positions']:.2f} "
                 "equally weighted positions. This measure ignores correlations and the contents of funds.",
         "severity": "info", "metric": "HHI and effective positions"},
        {"title": "Historical variability",
         "text": f"Across {observations} aligned {unit} return observations, annualized volatility is {metrics['annual_volatility']:.1%}. "
                 "It describes how widely past returns varied; it is not a forecast of gains or losses.",
         "severity": "info", "metric": f"{unit.capitalize()} standard deviation, annualized"},
        {"title": "Market sensitivity",
         "text": (f"Beta to {benchmark} is {metrics['beta']:.2f} over the same observations, in {base}. It summarizes past co-movement, "
                  "not a guaranteed response to the next market move.") if metrics["beta"] is not None
                 else f"{benchmark} has effectively zero return variance in this sample, so beta is undefined.",
         "severity": "info", "metric": "Covariance ÷ benchmark variance"},
        {"title": "Historical downside reference",
         "text": f"The 95% historical {horizon} loss threshold is {metrics['historical_var_95']:.1%} (about {base} "
                 f"{metrics['var_amount']:,.0f} at today's value); losses beyond it averaged {metrics['historical_es_95']:.1%}. "
                 "Future losses can be larger.",
         "severity": "info", "metric": "Historical VaR and expected shortfall"},
        {"title": "Reading the simulated path",
         "text": f"The largest peak-to-trough decline in the simulated path is {metrics['max_drawdown']:.1%}. The path applies today's "
                 "weights to past returns with rebalancing each period; it is not your account's performance.",
         "severity": "info", "metric": "Constant-weight drawdown"},
    ]
    if conc["fund_weight"] > 0 or conc["unknown_sector_weight"] > 0:
        rows.append({"title": "Sector coverage limits",
                     "text": f"{conc['fund_weight']:.1%} is in funds without sector look-through and {conc['unknown_sector_weight']:.1%} "
                             "has no sector classification. Fund overlaps and underlying exposures are not inferred.",
                     "severity": "warning", "metric": "Sector-data coverage"})
    drivers = [h for h in holdings if h["risk_contribution"] is not None]
    if drivers:
        driver = max(drivers, key=lambda h: h["risk_contribution"])
        rows.append({"title": "Main source of measured risk",
                     "text": f"{driver['ticker']} contributes {driver['risk_contribution']:.1%} of modeled portfolio volatility, including "
                             "its co-movement with the other holdings. A negative contribution means a historical offset, not a riskless asset.",
                     "severity": "info", "metric": "Covariance-based risk contribution"})
    return rows


def analyze(portfolio, snapshot, common_index=None):
    base, benchmark, frequency = snapshot["base"], snapshot["benchmark"], snapshot["frequency"]
    periods, horizon, minimum = FREQUENCIES[frequency]
    assets = snapshot["assets"]
    rows = []
    for entry in portfolio["holdings"]:
        asset = assets[entry["ticker"]]
        rate, fx_date = snapshot["rates"][entry["ticker"]]
        row = {key: value for key, value in asset.items() if key not in ("records", "dividends", "splits", "provider_symbol")}
        row.update(shares=entry["shares"], fx_rate=rate, fx_date=fx_date,
                   price_base=asset["price"] * asset["currency_scale"] * rate)
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
    weights, aligned, dropped, candidates = align_returns(normalized, snapshot["returns"], benchmark, minimum=minimum)
    if common_index is not None:
        aligned = aligned.loc[common_index]
        dropped = candidates - len(aligned)
        if len(aligned) < minimum:
            raise ValueError(f"Baseline and scenario need at least {minimum} common {frequency} returns.")
    portfolio_returns = aligned[weights.index].mul(weights, axis=1).sum(axis=1, min_count=len(weights))
    bench_returns = aligned[benchmark]
    covariance = aligned[weights.index].cov().to_numpy()
    w = weights.to_numpy()
    variance = float(w @ covariance @ w)
    period_volatility = math.sqrt(max(0.0, variance))
    benchmark_variance = float(bench_returns.var(ddof=1))
    beta = float(portfolio_returns.cov(bench_returns) / benchmark_variance) if benchmark_variance > 1e-16 else None
    contributions = w * (covariance @ w) / variance if variance > 1e-16 else [None] * len(w)
    by_ticker = dict(zip(weights.index, contributions))
    for row in rows:
        series = aligned[row["ticker"]]
        asset = assets[row["ticker"]]
        row["annual_volatility"] = float(series.std(ddof=1) * math.sqrt(periods))
        row["beta"] = float(series.cov(bench_returns) / benchmark_variance) if benchmark_variance > 1e-16 else None
        row["risk_contribution"] = number_or_none(by_ticker[row["ticker"]])
        row["session"] = holding_session(asset, base, snapshot["fx_series"], row["market_value"])
        row["period_returns"] = period_returns(asset)
    portfolio_index = np.r_[100.0, 100.0 * np.cumprod(1 + portfolio_returns.to_numpy())]
    benchmark_index = np.r_[100.0, 100.0 * np.cumprod(1 + bench_returns.to_numpy())]
    drawdown = portfolio_index / np.maximum.accumulate(portfolio_index) - 1
    threshold = float(np.quantile(portfolio_returns, 0.05))
    tail = portfolio_returns[portfolio_returns <= threshold]
    var, es = max(0.0, -threshold), max(0.0, -float(tail.mean()))
    metrics = {
        "annual_volatility": period_volatility * math.sqrt(periods), "period_volatility": period_volatility,
        "beta": beta, "benchmark_volatility": math.sqrt(max(0.0, benchmark_variance) * periods),
        "benchmark_correlation": number_or_none(portfolio_returns.corr(bench_returns)) if period_volatility > 1e-8 and benchmark_variance > 1e-16 else None,
        "max_drawdown": float(drawdown.min()), "historical_return": float(portfolio_index[-1] / 100 - 1),
        "benchmark_return": float(benchmark_index[-1] / 100 - 1), "historical_var_95": var, "historical_es_95": es,
        "worst_period": float(portfolio_returns.min()), "best_period": float(portfolio_returns.max()),
        "var_amount": var * total, "es_amount": es * total,
    }
    conc = concentration(normalized)
    sectors, currencies, exchanges = {}, {}, {}
    unknown_weight = fund_weight = 0.0
    for row in rows:
        fund = row["instrument"] in ("ETF", "MUTUALFUND")
        sector = FUND_SECTOR if fund else row["sector"] or UNKNOWN_SECTOR
        sectors[sector] = sectors.get(sector, 0) + row["weight"]
        currencies[row["currency_iso"]] = currencies.get(row["currency_iso"], 0) + row["weight"]
        exchanges[row["exchange"]] = exchanges.get(row["exchange"], 0) + row["weight"]
        if fund:
            fund_weight += row["weight"]
        elif row["sector"] is None:
            unknown_weight += row["weight"]
    ordered = lambda mapping, key: [{key: name, "weight": value} for name, value in sorted(mapping.items(), key=lambda item: -item[1])]
    conc.update(sector_exposures=ordered(sectors, "sector"), currency_exposures=ordered(currencies, "currency"),
                exchange_exposures=ordered(exchanges, "label"), unknown_sector_weight=unknown_weight, fund_weight=fund_weight)
    prior = snapshot["prices"].index[snapshot["prices"].index < aligned.index[0]]
    if not len(prior):
        raise ValueError("The first aligned return has no prior price observation.")
    dates = [prior[-1], *aligned.index]
    series = [{"date": day.strftime("%Y-%m-%d"), "portfolio": float(portfolio_index[i]), "benchmark": float(benchmark_index[i]),
               "drawdown": float(drawdown[i]), "period_return": float(portfolio_returns.iloc[i - 1]) if i else 0.0}
              for i, day in enumerate(dates)]
    corr = aligned[weights.index].corr()
    sessions = [row for row in rows if row["session"] and row["session"]["change_base"] is not None]
    session_change = sum(row["session"]["change_base"] for row in sessions) if sessions else None
    covered_value = sum(row["market_value"] for row in sessions)
    used = [*{row["ticker"] for row in rows}, benchmark]
    warnings = list(dict.fromkeys(w for ticker in used for w in assets[ticker]["warnings"]))
    warnings.extend(w for item in snapshot["fx"].values() for w in item["warnings"])
    if dropped:
        warnings.append(f"{dropped} candidate {frequency} return rows were excluded because a required price, FX rate or prior observation "
                        "was missing. The simulated path skips those intervals.")
    if snapshot["fx"]:
        warnings.append(f"Foreign-currency holdings are converted to {base} with same-date FX closes for history and the latest completed "
                        "FX close for valuation. FX and equity closing times differ.")
    if any(assets[t]["currency_scale"] != 1 for t in used):
        warnings.append("Some securities are quoted in minor units (for example GBp pence); values are converted to whole currency units.")
    if len(aligned) < (126 if frequency == "daily" else 52):
        warnings.append(f"Only {len(aligned)} aligned {frequency} observations are available, so volatility, beta and tail estimates may be unstable.")
    if beta is None:
        warnings.append("Benchmark variance is effectively zero; beta and benchmark correlation are undefined.")
    if len(sessions) < len(rows):
        warnings.append("Latest-session moves are unavailable for some holdings because a previous close or exchange rate is missing.")
    warnings.append("Research only. Historical estimates can change sharply and do not cover liquidity, leverage, options, intraday gaps or future regimes.")
    fetched = [assets[t]["fetched_at"] for t in used] + [item["fetched_at"] for item in snapshot["fx"].values()]
    return {
        "portfolio": portfolio, "total_value": total, "holdings": rows, "concentration": conc, "risk": metrics,
        "benchmark": {"ticker": benchmark, "name": assets[benchmark]["name"], "currency": assets[benchmark]["currency_iso"]},
        "coverage": {
            "requested_range": snapshot["range"], "frequency": frequency, "requested_frequency": snapshot["requested_frequency"],
            "frequency_reason": snapshot["frequency_reason"], "periods_per_year": periods, "horizon": horizon,
            "start_date": dates[0].strftime("%Y-%m-%d"), "end_date": dates[-1].strftime("%Y-%m-%d"),
            "observations": len(aligned), "min_observations": minimum, "candidate_observations": candidates,
            "dropped_observations": dropped, "priced_weight": 1.0,
            "return_method": (f"{frequency.capitalize()} returns from adjacent observed adjusted closes in {base}; complete-case alignment; "
                              "no forward filling" + ("; weekly prices are each security's last close of the week" if frequency == "weekly" else "")),
        },
        "session": {
            "change_base": session_change,
            "return_base": session_change / (covered_value - session_change) if sessions and covered_value - session_change > 0 else None,
            "covered_weight": sum(row["weight"] for row in sessions),
            "latest_date": max(row["session"]["date"] for row in sessions) if sessions else None,
        },
        "fx": [{"currency": iso, "base": base, "rate": item["rate"], "date": item["date"], "method": item["method"], "pairs": item["pairs"]}
               for iso, item in sorted(snapshot["fx"].items())],
        "series": series, "correlations": {"tickers": list(weights.index), "matrix": [[number_or_none(v) for v in r] for r in corr.to_numpy()]},
        "explanations": explanations(rows, conc, metrics, benchmark, len(aligned), base, frequency),
        "explanation_method": "Deterministic explanations grounded in the computed metrics; not an LLM",
        "warnings": warnings,
        "assumptions": [
            "Long-only stocks, ETFs and mutual funds with fractional shares. No margin, shorts, derivatives, cash yield, taxes or fees.",
            "Valuation uses each security's latest completed close and the latest completed FX close — not real-time executable prices.",
            "History uses dividend- and split-adjusted closes. Today's weights are applied to past returns with rebalancing each period.",
            "Quote units such as GBp, ZAc and ILA are converted to GBP, ZAR and ILS before FX conversion.",
            "FX uses the provider's direct pair, the inverted reverse pair, or a cross through USD; the method is listed for each currency.",
            "When markets close in different time zones, weekly returns can be selected automatically to limit non-synchronous price effects.",
            "Beta, correlations and risk contributions share the same observations and reporting currency.",
            "95% historical VaR is the loss at the fifth return percentile; expected shortfall averages returns at or below it.",
            "Funds are not looked through; ETF and mutual-fund sector, country and overlap exposures are not inferred.",
            "Explanations are rule-based summaries, not generated by an external AI service. Share quantities, values and screenshots "
            "never leave this computer; only ticker symbols, company names and date ranges are sent to the market-data provider.",
        ],
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="microseconds"),
        "market_fetched_at": min(fetched, key=lambda value: datetime.fromisoformat(value)), "source": SOURCE,
    }


def compare_scenario(baseline, scenario, snapshot):
    needed = sorted({h["ticker"] for p in (baseline, scenario) for h in p["holdings"]} | {snapshot["benchmark"]})
    minimum = FREQUENCIES[snapshot["frequency"]][2]
    common = snapshot["returns"][needed].dropna().index
    if len(common) < minimum:
        raise ValueError(f"Scenario comparison needs at least {minimum} jointly observed {snapshot['frequency']} returns; found {len(common)}.")
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
