from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .analytics import analyze, compare_scenario, prepare_market
from .market import Market, MarketUnavailable, clean_symbol
from .storage import RevisionConflict, Store

ROOT = Path(__file__).resolve().parent.parent
Currency = Literal["USD", "CAD"]
HistoryRange = Literal["6mo", "1y", "2y", "5y"]


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
    base_currency: Currency = "USD"
    holdings: list[Holding] = Field(min_length=1, max_length=20)

    @field_validator("name")
    @classmethod
    def valid_name(cls, value):
        value = value.strip()
        if not value or any(ord(char) < 32 for char in value):
            raise ValueError("Portfolio name must contain text without control characters.")
        return value

    @model_validator(mode="after")
    def aggregate_positions(self):
        shares = {}
        for holding in self.holdings:
            shares[holding.ticker] = shares.get(holding.ticker, 0.0) + holding.shares
        self.holdings = [Holding(ticker=ticker, shares=quantity) for ticker, quantity in shares.items()]
        return self


class PortfolioUpdate(Portfolio):
    revision: int = Field(ge=1)


class AnalysisRequest(StrictModel):
    portfolio: Portfolio
    benchmark: str = "SPY"
    range: HistoryRange = "1y"
    refresh: bool = False

    @field_validator("benchmark")
    @classmethod
    def valid_benchmark(cls, value):
        return clean_symbol(value)


class ScenarioRequest(StrictModel):
    baseline: Portfolio
    scenario: Portfolio
    benchmark: str = "SPY"
    range: HistoryRange = "1y"
    refresh: bool = False

    @field_validator("benchmark")
    @classmethod
    def valid_benchmark(cls, value):
        return clean_symbol(value)

    @model_validator(mode="after")
    def same_currency(self):
        if self.baseline.base_currency != self.scenario.base_currency:
            raise ValueError("Baseline and scenario must use the same reporting currency.")
        return self


EXAMPLES = [
    {"name": "Example / Core and satellites", "base_currency": "USD", "holdings": [
        {"ticker": "VTI", "shares": 12}, {"ticker": "AAPL", "shares": 10}, {"ticker": "MSFT", "shares": 8}, {"ticker": "JPM", "shares": 10},
    ]},
    {"name": "Example / Concentrated technology", "base_currency": "USD", "holdings": [
        {"ticker": "NVDA", "shares": 30}, {"ticker": "MSFT", "shares": 8}, {"ticker": "AAPL", "shares": 5},
    ]},
    {"name": "Example / Canada and US", "base_currency": "CAD", "holdings": [
        {"ticker": "XIU.TO", "shares": 60}, {"ticker": "RY.TO", "shares": 15}, {"ticker": "VTI", "shares": 10},
    ]},
]


def create_app(data_dir=None, market_client=None):
    app = FastAPI(title="LENS / Portfolio Risk Explainer", version="1.0.0")
    store = Store(data_dir)
    market = market_client or Market(store)
    app.state.store = store
    app.state.market = market
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

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.get("/api/examples")
    def examples():
        return {"examples": EXAMPLES}

    @app.get("/api/assets/search")
    def search(q: str = Query(min_length=1, max_length=80)):
        try:
            return {"results": market.search(q)}
        except MarketUnavailable as exc:
            raise HTTPException(502, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get("/api/assets/{ticker}")
    def asset(ticker: str):
        try:
            return {key: value for key, value in market.asset(clean_symbol(ticker)).items() if key != "records"}
        except MarketUnavailable as exc:
            raise HTTPException(502, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

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
        try:
            portfolio = body.portfolio.model_dump()
            snapshot = prepare_market([portfolio], body.benchmark, body.range, market, body.refresh)
            return analyze(portfolio, snapshot)
        except MarketUnavailable as exc:
            raise HTTPException(502, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.post("/api/scenario")
    def scenario(body: ScenarioRequest):
        try:
            baseline, scenario = body.baseline.model_dump(), body.scenario.model_dump()
            snapshot = prepare_market([baseline, scenario], body.benchmark, body.range, market, body.refresh)
            return compare_scenario(baseline, scenario, snapshot)
        except MarketUnavailable as exc:
            raise HTTPException(502, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    dist = ROOT / "frontend" / "dist"
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
    else:
        @app.get("/")
        def missing_build():
            return JSONResponse(status_code=503, content={"detail": "Build frontend assets using npm run build in frontend, then restart the server."})
    return app


app = create_app()
