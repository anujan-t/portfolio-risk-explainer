from contextlib import asynccontextmanager
import os
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .analytics import analyze, compare_scenario, prepare_market
from .market import Market, MarketUnavailable, clean_symbol
from .news import NewsService
from .screenshot import MAX_BYTES, OcrUnavailable, ScreenshotError, analyze_screenshot
from .storage import RevisionConflict, Store

ROOT = Path(__file__).resolve().parent.parent
HistoryRange = Literal["6mo", "1y", "2y", "5y", "10y", "max"]
Frequency = Literal["auto", "daily", "weekly"]
MAX_HOLDINGS = 25
BASE_CURRENCIES = ["USD", "CAD", "EUR", "GBP", "JPY", "AUD", "CHF", "HKD", "SGD", "INR", "CNY", "SEK", "NZD"]
IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/bmp", "image/gif"}
BENCHMARKS = [
    {"ticker": "SPY", "name": "S&P 500 (SPDR ETF)", "region": "United States"},
    {"ticker": "VTI", "name": "US total market (Vanguard ETF)", "region": "United States"},
    {"ticker": "QQQ", "name": "Nasdaq-100 (Invesco ETF)", "region": "United States"},
    {"ticker": "ACWI", "name": "MSCI ACWI (iShares ETF)", "region": "Global"},
    {"ticker": "VT", "name": "FTSE Global All Cap (Vanguard ETF)", "region": "Global"},
    {"ticker": "EFA", "name": "MSCI EAFE developed ex-US (iShares ETF)", "region": "International"},
    {"ticker": "EEM", "name": "MSCI Emerging Markets (iShares ETF)", "region": "Emerging markets"},
    {"ticker": "XIU.TO", "name": "S&P/TSX 60 (iShares ETF)", "region": "Canada"},
    {"ticker": "VFV.TO", "name": "S&P 500 in CAD (Vanguard ETF)", "region": "Canada"},
    {"ticker": "ISF.L", "name": "FTSE 100 (iShares ETF)", "region": "United Kingdom"},
    {"ticker": "EXS1.DE", "name": "DAX (iShares ETF)", "region": "Germany"},
    {"ticker": "1306.T", "name": "TOPIX (NEXT FUNDS ETF)", "region": "Japan"},
    {"ticker": "2800.HK", "name": "Hang Seng (Tracker Fund)", "region": "Hong Kong"},
    {"ticker": "STW.AX", "name": "S&P/ASX 200 (SPDR ETF)", "region": "Australia"},
]
EXAMPLES = [
    {"name": "Example / Core and satellites", "base_currency": "USD", "holdings": [
        {"ticker": "VTI", "shares": 12}, {"ticker": "AAPL", "shares": 10}, {"ticker": "MSFT", "shares": 8}, {"ticker": "JPM", "shares": 10},
    ]},
    {"name": "Example / Global blue chips", "base_currency": "USD", "holdings": [
        {"ticker": "AAPL", "shares": 10}, {"ticker": "VOD.L", "shares": 400}, {"ticker": "7203.T", "shares": 50},
        {"ticker": "SAP.DE", "shares": 5}, {"ticker": "RY.TO", "shares": 8}, {"ticker": "0700.HK", "shares": 20},
    ]},
    {"name": "Example / Canada and US", "base_currency": "CAD", "holdings": [
        {"ticker": "XIU.TO", "shares": 60}, {"ticker": "RY.TO", "shares": 15}, {"ticker": "VTI", "shares": 10},
    ]},
]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Holding(StrictModel):
    ticker: str
    shares: float = Field(gt=0, le=1e9)

    @field_validator("ticker")
    @classmethod
    def valid_ticker(cls, value):
        return clean_symbol(value)


class Portfolio(StrictModel):
    name: str = Field(min_length=1, max_length=80)
    base_currency: str = "USD"
    holdings: list[Holding] = Field(min_length=1, max_length=MAX_HOLDINGS)

    @field_validator("name")
    @classmethod
    def valid_name(cls, value):
        value = value.strip()
        if not value or any(ord(char) < 32 for char in value):
            raise ValueError("Portfolio name must contain text without control characters.")
        return value

    @field_validator("base_currency")
    @classmethod
    def valid_base(cls, value):
        if value not in BASE_CURRENCIES:
            raise ValueError(f"Reporting currency must be one of {', '.join(BASE_CURRENCIES)}.")
        return value

    @model_validator(mode="after")
    def aggregate_positions(self):
        shares = {}
        for holding in self.holdings:
            shares[holding.ticker] = shares.get(holding.ticker, 0.0) + holding.shares
        if any(total > 1e9 for total in shares.values()):
            raise ValueError("Combined share quantity for a ticker cannot exceed 1 billion.")
        self.holdings = [Holding(ticker=ticker, shares=quantity) for ticker, quantity in shares.items()]
        return self


class PortfolioUpdate(Portfolio):
    revision: int = Field(ge=1)


class Benchmarked(StrictModel):
    benchmark: str = "SPY"
    range: HistoryRange = "1y"
    frequency: Frequency = "auto"
    refresh: bool = False

    @field_validator("benchmark")
    @classmethod
    def valid_benchmark(cls, value):
        return clean_symbol(value)


class AnalysisRequest(Benchmarked):
    portfolio: Portfolio


class ScenarioRequest(Benchmarked):
    baseline: Portfolio
    scenario: Portfolio

    @model_validator(mode="after")
    def same_currency(self):
        if self.baseline.base_currency != self.scenario.base_currency:
            raise ValueError("Baseline and scenario must use the same reporting currency.")
        return self


class NewsHolding(StrictModel):
    ticker: str
    name: str | None = Field(default=None, max_length=160)

    @field_validator("ticker")
    @classmethod
    def valid_ticker(cls, value):
        return clean_symbol(value)


class NewsRequest(StrictModel):
    holdings: list[NewsHolding] = Field(min_length=1, max_length=MAX_HOLDINGS)
    refresh: bool = False


def create_app(data_dir=None, market_client=None, news_service=None, background=None):
    store = Store(data_dir)
    market = market_client or Market(store)
    hours = float(os.environ.get("LENS_NEWS_REFRESH_HOURS", "3"))
    news = news_service or NewsService(store, market, refresh_hours=hours)
    if background is None:
        background = os.environ.get("LENS_BACKGROUND", "1") != "0"

    @asynccontextmanager
    async def lifespan(_):
        if background:
            news.start()
        try:
            yield
        finally:
            if background:
                news.stop()

    app = FastAPI(title="LENS / Portfolio Risk Explainer", version="2.0.0", lifespan=lifespan)
    app.state.store, app.state.market, app.state.news = store, market, news
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("origin")
            if origin and (urlparse(origin).hostname not in ("localhost", "127.0.0.1") or origin not in {
                str(request.base_url).rstrip("/"), "http://127.0.0.1:5174", "http://localhost:5174",
            }):
                return JSONResponse(status_code=403, content={"detail": "Cross-origin requests cannot change this local portfolio app."})
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    def guarded(call):
        try:
            return call()
        except MarketUnavailable as exc:
            raise HTTPException(502, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.get("/api/config")
    def config():
        return {"base_currencies": BASE_CURRENCIES, "ranges": ["6mo", "1y", "2y", "5y", "10y", "max"],
                "frequencies": ["auto", "daily", "weekly"], "benchmarks": BENCHMARKS, "max_holdings": MAX_HOLDINGS,
                "news_refresh_hours": hours}

    @app.get("/api/examples")
    def examples():
        return {"examples": EXAMPLES}

    @app.get("/api/assets/search")
    def search(q: str = Query(min_length=1, max_length=80)):
        return guarded(lambda: {"results": market.search(q)})

    @app.get("/api/assets/{ticker}/history")
    def history(ticker: str, range: HistoryRange = "5y"):
        return guarded(lambda: market.history(clean_symbol(ticker), range))

    @app.get("/api/assets/{ticker}")
    def asset(ticker: str):
        return guarded(lambda: {key: value for key, value in market.asset(clean_symbol(ticker)).items()
                                if key not in ("records", "dividends", "splits", "provider_symbol")})

    @app.get("/api/portfolios")
    def portfolios():
        return {"portfolios": store.list_portfolios()}

    @app.post("/api/portfolios", status_code=201)
    def create_portfolio(body: Portfolio):
        return store.save_portfolio(body.model_dump())

    @app.put("/api/portfolios/{portfolio_id}")
    def update_portfolio(portfolio_id: str, body: PortfolioUpdate):
        try:
            return store.save_portfolio(body.model_dump(exclude={"revision"}), portfolio_id, body.revision)
        except KeyError as exc:
            raise HTTPException(404, "Portfolio not found.") from exc
        except RevisionConflict as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.delete("/api/portfolios/{portfolio_id}")
    def delete_portfolio(portfolio_id: str, revision: int = Query(ge=1)):
        try:
            store.delete_portfolio(portfolio_id, revision)
            return {"deleted": True}
        except KeyError as exc:
            raise HTTPException(404, "Portfolio not found.") from exc
        except RevisionConflict as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/analyze")
    def run_analysis(body: AnalysisRequest):
        portfolio = body.portfolio.model_dump()
        return guarded(lambda: analyze(portfolio, prepare_market([portfolio], body.benchmark, body.range, market, body.refresh, body.frequency)))

    @app.post("/api/scenario")
    def scenario(body: ScenarioRequest):
        baseline, alternative = body.baseline.model_dump(), body.scenario.model_dump()
        return guarded(lambda: compare_scenario(baseline, alternative,
                                                prepare_market([baseline, alternative], body.benchmark, body.range, market, body.refresh, body.frequency)))

    @app.get("/api/news/sectors")
    def sector_news():
        return news.sector_board()

    @app.get("/api/news/status")
    def news_status():
        return news.status()

    @app.post("/api/news/refresh")
    def refresh_news():
        return news.request_refresh()

    @app.post("/api/news/holdings")
    def holdings_news(body: NewsRequest):
        holdings = [holding.model_dump() for holding in body.holdings]
        return guarded(lambda: news.holdings_news(holdings, body.refresh))

    @app.post("/api/import/screenshot")
    async def import_screenshot(request: Request):
        content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if content_type not in IMAGE_TYPES:
            raise HTTPException(415, "Upload a PNG, JPEG, WebP, BMP or GIF screenshot.")
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_BYTES:
            raise HTTPException(413, "Screenshots must be 8 MB or smaller.")
        chunks, size = [], 0
        # Read into memory only; the image is never written to disk or kept after the request.
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_BYTES:
                raise HTTPException(413, "Screenshots must be 8 MB or smaller.")
            chunks.append(chunk)
        try:
            return await run_in_threadpool(analyze_screenshot, b"".join(chunks), market)
        except ScreenshotError as exc:
            raise HTTPException(422, str(exc)) from exc
        except OcrUnavailable as exc:
            raise HTTPException(503, str(exc)) from exc

    dist = ROOT / "frontend" / "dist"
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
    else:
        @app.get("/")
        def missing_build():
            return JSONResponse(status_code=503, content={"detail": "Build frontend assets using npm run build in frontend, then restart the server."})
    return app


app = create_app()
