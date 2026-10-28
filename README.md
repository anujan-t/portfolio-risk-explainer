# LENS / Portfolio Risk Explainer

Build a portfolio with ticker search and share quantities. Prices, adjusted
history and supported currency conversions come directly from market-data
endpoints; no CSV upload or brokerage credentials are required.

**Stack:** Python, pandas, NumPy, FastAPI, React, TypeScript and Vite.

The interface is a personal portfolio observatory: a proportional allocation
atlas with a holding inspector, followed by focused Performance, Risk &
relationships, Holdings and Field notes views. Portfolio construction and
what-if studies remain separate from the applied analysis. It runs locally,
with a private portfolio library, light/dark themes and responsive layouts.
Map area represents allocation weight; tile position and colour do not imply
risk, correlation or expected returns.

## What it does

- Searches equities and ETFs, resolves their most recent completed daily
  prices, and supports fractional share quantities.
- Reports in USD or CAD, including observed historical FX conversion for
  securities quoted in the other supported currency.
- Calculates weights, concentration, effective positions, sector-data coverage,
  annualized volatility, beta, correlations and covariance-based risk contributions.
- Shows hypothetical constant-current-weight history, drawdowns, and 95%
  historical one-day VaR and expected shortfall.
- Explains the actual computed metrics in plain English and compares hypothetical
  allocations on the same market snapshot and observation dates.
- Saves portfolios locally with revision checks to prevent overwriting edits
  made in another browser window.

The included example allocations are hypothetical, not the user's holdings.
Their market data is real historical provider data. The old synthetic CSV files
remain only as reproducible development fixtures and for the legacy CLI.

## Run locally

Python 3.12+ and Node.js 22 LTS are recommended.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-lock.txt
Set-Location frontend
npm ci
npm run build
Set-Location ..
.\Start.ps1
```

Open **http://127.0.0.1:8766/**. API reference is at `/docs`.
`Start.ps1 -Python <python.exe> -Port <port>` can use an existing environment.
The frontend build is generated locally and is not committed.

For frontend development, run `npm run dev` in `frontend`; Vite proxies API
requests to the Python service on port 8766.

## How the data and math work

Yahoo Finance public chart/search endpoints supply prices and security metadata.
They are unofficial, may be delayed or unavailable, and are not a guaranteed
commercial market feed. No API key is required. Only ticker/search/history
requests leave the machine; share quantities and portfolio names are not sent
to the provider.

The app supports long-only equities and ETFs quoted in USD or CAD. Other
currencies, derivatives, short positions and cash-only portfolios are outside
the model's current scope. ETF sector look-through is not implemented: fund
exposure is shown separately instead of inventing underlying sector weights.

Daily returns are computed from adjacent observed adjusted closes **before**
complete-case alignment. Prices and FX rates are never forward-filled. Every
holding and the benchmark must have usable history, with at least 60 aligned
daily observations. An unpriced ticker fails explicitly; remaining holdings
are not silently reweighted into a different portfolio.

The historical index applies current weights to past returns as if rebalanced
daily. It is **not actual account performance**, a trade backtest or a forecast.
When incomplete intervals are excluded, that limitation is reported alongside
the path. Beta, correlations, risk contributions and scenario comparisons use
matching dates and a common reporting currency.

## Explanations and privacy

Explanations are **deterministic, metric-grounded summaries, not LLM output**.
No external AI service receives the portfolio. LLM narration remains a future,
opt-in capability, not an implemented feature claim.

On Windows, saved portfolios and public market cache live under
`%LOCALAPPDATA%\PortfolioRiskExplainer`, outside the source directory and its
OneDrive sync. Override storage with `PORTFOLIO_DATA_DIR`. These are private
local SQLite records protected by OS account permissions, not an encrypted
brokerage vault. The app has no broker sync, trading or account-authentication
features. Keep it bound to loopback; it is not designed for public hosting.

## Development

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

The original command remains available:

```powershell
.\.venv\Scripts\python.exe risk.py data\sample_holdings.csv --prices data\sample_prices.csv
```

See `RUNNING.txt` for methodology, limitations and operating details.

Educational portfolio research only. Historical risk estimates are uncertain;
they are not investment advice or guarantees about future gains or losses.
