# LENS: portfolio risk explainer

LENS is a portfolio risk tool that runs on your own computer. You enter holdings
by ticker search or from a screenshot of a brokerage holdings page. LENS then
reports the portfolio's value, risk, concentration and price history in your
base currency, with sector news and news on the securities you hold. Holdings
stay on your computer.

**Stack:** Python, pandas, NumPy, FastAPI, RapidOCR (local), React, TypeScript,
Vite. The fonts (Source Serif 4, Source Sans 3 and IBM Plex Mono) are bundled
with the frontend, so nothing is loaded from a font CDN.

## Features

- **Global holdings.** Stocks, ETFs and mutual funds listed on exchanges that
  Yahoo Finance covers, for example NYSE, Nasdaq, TSX, LSE, XETRA, Euronext,
  Tokyo, Hong Kong, NSE, ASX, Johannesburg and Tel Aviv. Up to 25 positions.
- **Thirteen base currencies:** USD, CAD, EUR, GBP, JPY, AUD, CHF, HKD, SGD,
  INR, CNY, SEK and NZD. Prices quoted in minor units, such as GBp, ZAc and ILA,
  are converted to whole currency units before currency conversion.
- **Screenshot import.** Paste or drop a screenshot of your holdings. An offline
  OCR model reads the text on your computer. LENS checks the proposed tickers
  and share quantities against market data and lists them for review. Nothing
  is added until you confirm each row.
- **Daily news.** Performance and headlines for all 11 GICS sectors, using US
  Select Sector and iShares Global sector ETFs as proxies, with 1-day, 1-week,
  1-month and year-to-date moves. Sector data refreshes automatically every few
  hours. LENS also collects news on the securities you hold.
- **Risk analysis.** Annualized volatility, beta, correlation, maximum drawdown,
  historical 95% value at risk and expected shortfall, covariance-based risk
  contribution, a correlation matrix and concentration measures (HHI, effective
  number of positions, and sector, currency and exchange exposure). Each figure
  comes with a short written note.
- **History** from six months to the full daily record of each listing, with
  dividends and splits.
- **What-if scenarios**, compared with the current portfolio on identical dates,
  and a library of saved portfolios with revision checks.

## Run locally

Python 3.12 or newer and Node.js 22 LTS are recommended.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-lock.txt
Set-Location frontend
npm ci
npm run build
Set-Location ..
.\Start.ps1
```

Open **http://127.0.0.1:8766/**. The API reference is at `/docs`. `RUNNING.txt`
covers options, methods and limitations.

## Data, methods and limitations

- **Market data and news** come from Yahoo Finance's public chart and search
  endpoints. These endpoints are unofficial and unlicensed; they can be delayed,
  change without notice or be rate-limited. LENS reports failures and never
  fills gaps with synthetic data.
- **Valuations** use each security's latest *completed* close and the latest
  completed exchange-rate close. They are neither real-time nor executable
  prices.
- **Exchange rates** come from the provider's direct pair, the inverted reverse
  pair or a cross rate through USD. LENS verifies each pair's quote currency
  before use and shows the method for every currency.
- **Returns** come from dividend- and split-adjusted closes. Historical prices
  are converted at same-date exchange rates and are never forward-filled. When
  holdings trade in time zones three or more hours apart, *Auto* frequency uses
  weekly returns to limit distortions from different closing times.
- The historical path applies **today's weights** to past returns, so it differs
  from your account's actual performance. Risk figures are historical estimates
  and do not forecast future results.
- **News** is shown with its publisher and time and links to the original
  story. LENS does not score sentiment or likely price impact.
- **Risk notes** are produced by fixed rules from the computed figures. No
  portfolio data is sent to an AI service.
- Funds are not looked through to their underlying holdings.

## Privacy

Portfolios and cached public market data are stored in
`%LOCALAPPDATA%\PortfolioRiskExplainer` (override with `PORTFOLIO_DATA_DIR`).
Only ticker symbols, company names and date ranges are sent to the data
provider. Share quantities, values and screenshots are never sent. Uploaded
screenshots are processed in memory and discarded after the request. The server
listens on `127.0.0.1` only and is meant for use on one computer; do not expose
it on a public network.

## Development

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
Set-Location frontend; npm run build
```

The original metrics command still works with the CSV fixtures:

```powershell
.\.venv\Scripts\python.exe risk.py data\sample_holdings.csv --prices data\sample_prices.csv
```

For research and education. Not investment advice.
