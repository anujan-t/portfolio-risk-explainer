# LENS — Portfolio Risk Explainer

A private, local portfolio-intelligence app. Build a portfolio by ticker search
or from a screenshot of your brokerage holdings, then see its value, risk,
concentration and historical behaviour in your own currency — alongside daily
sector and holdings news. Holdings never leave your computer.

**Stack:** Python, pandas, NumPy, FastAPI, RapidOCR (local), React, TypeScript, Vite.

## What it does

- **Global holdings.** Stocks, ETFs and mutual funds from exchanges covered by
  Yahoo Finance (for example NYSE, Nasdaq, TSX, LSE, XETRA, Euronext, Tokyo,
  Hong Kong, NSE, ASX, Johannesburg, Tel Aviv). Up to 25 positions.
- **Thirteen reporting currencies** (USD, CAD, EUR, GBP, JPY, AUD, CHF, HKD,
  SGD, INR, CNY, SEK, NZD). Minor-unit quotes such as GBp, ZAc and ILA are
  converted to whole currency units before FX conversion.
- **Screenshot import.** Paste or drop a screenshot of your holdings. Text is
  read on your computer by an offline OCR model; proposed tickers and share
  quantities are checked against market data and shown for review. Nothing is
  added until you confirm each row.
- **Daily news.** Sector briefings for all 11 GICS sectors (US Select Sector
  and iShares Global sector ETFs as proxies, with 1-day, 1-week, 1-month and
  year-to-date moves) refresh automatically every few hours, plus news for the
  securities you hold.
- **Risk analysis.** Annualised volatility, beta, correlation, maximum
  drawdown, historical 95% VaR and expected shortfall, covariance-based risk
  contribution, correlation matrix and concentration (HHI, effective positions,
  sector, currency and exchange exposure), with plain-English explanations.
- **History** from six months to the full daily record of each listing, with
  dividends and splits.
- **What-if scenarios** compared on identical dates, and a private portfolio
  library with revision checks.

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

Open **http://127.0.0.1:8766/**. API reference: `/docs`. See `RUNNING.txt` for
options, methodology and limitations.

## Data, methods and limits

- **Market data and news** come from Yahoo Finance's public chart/search
  endpoints. They are unofficial, can be delayed, change or be rate-limited, and
  are not a licensed market feed. Failures are reported; nothing is filled in
  with synthetic data.
- **Valuation** uses each security's latest *completed* close and the latest
  completed FX close — not real-time executable prices.
- **FX** uses the provider's direct pair, the inverted reverse pair, or a cross
  through USD; each pair's quote currency is verified before use, and the method
  is shown for every currency.
- **Returns** come from dividend- and split-adjusted closes. Historical prices
  are converted with same-date FX and never forward-filled. When holdings trade
  in time zones three or more hours apart, *Auto* frequency uses weekly returns
  to limit distortions from non-synchronous closing prices.
- The historical path applies **today's weights** to past returns; it is not
  your account performance. Risk figures are historical estimates, not forecasts.
- **News** is shown with publisher and timestamp and links to the original
  story. There are no sentiment or "impact" scores.
- **Explanations** are rule-based summaries of the computed metrics. No portfolio
  data is sent to an AI service.
- Funds are not looked through to their underlying holdings.

## Privacy

Portfolios and cached public market data are stored in
`%LOCALAPPDATA%\PortfolioRiskExplainer` (override with `PORTFOLIO_DATA_DIR`).
Only ticker symbols, company names and date ranges are sent to the data
provider — never share quantities, values or screenshots. Uploaded screenshots
are processed in memory and discarded after the request. The server listens on
`127.0.0.1` only and is not designed for public hosting.

## Development

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
Set-Location frontend; npm run build
```

The original metrics command remains available for the CSV fixtures:

```powershell
.\.venv\Scripts\python.exe risk.py data\sample_holdings.csv --prices data\sample_prices.csv
```

Educational portfolio research only — not investment advice.
