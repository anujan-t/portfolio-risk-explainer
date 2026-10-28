"""Propose portfolio holdings from a brokerage screenshot.

Everything returned is a *proposal* that the user reviews and confirms. Nothing is guessed
silently: a value that cannot be read or cross-checked unambiguously is left null or carries an
issue so the UI forces a review. Images are processed in memory only and recognised text is never
logged.
"""

from __future__ import annotations

import io
import logging
import math
import re
import statistics
import threading
import unicodedata
import warnings
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Optional, Sequence

try:
    import numpy as np
    from PIL import Image, ImageOps
except ImportError:  # reported as OcrUnavailable when used, so the API module still imports
    np = None
    Image = ImageOps = None

try:
    from .market import MarketUnavailable, UnsupportedAsset
except Exception:  # keeps this module importable while market.py is being edited
    class MarketUnavailable(RuntimeError):
        """Fallback used only when backend.market cannot be imported."""

    class UnsupportedAsset(ValueError):
        """Fallback used only when backend.market cannot be imported."""


class ScreenshotError(ValueError):
    """The upload is not a usable screenshot (HTTP 422)."""


class OcrUnavailable(RuntimeError):
    """The local OCR engine or imaging libraries cannot be loaded (HTTP 503)."""


MAX_BYTES = 8 * 1024 * 1024
MAX_PIXELS = 40_000_000
ENGINE = "RapidOCR (local, offline)"
if Image is not None:
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS

OcrFunction = Callable[[Any], Sequence[tuple[Any, str, float]]]

_FORMATS = ("PNG", "JPEG", "WEBP", "BMP", "GIF")
_ACCEPTED_FORMATS = frozenset(_FORMATS) | {"MPO"}  # MPO is the multi-picture JPEG many phones write
_MIN_LONG_SIDE, _MIN_SHORT_SIDE, _MAX_ASPECT = 120, 60, 12.0
_UPSCALE_BELOW, _MAX_OCR_SIDE, _MAX_BOXES = 1400, 4000, 3000

_INTERNAL_TOLERANCE = 0.015
_MARKET_TOLERANCE = 0.20
_STRONG_MATCH = 0.03  # the row's own price pins one listing when it is this close to its latest close
_LISTING_AGREEMENT = 0.05
_LINE_TOLERANCE = 0.55
_ROW_MERGE = 1.6
_CLEARLY_CLOSER = 1.3
_MAX_ROWS = 40
_MAX_LOOKUPS = 25
_MAX_CANDIDATES = 5
_PRICED_CANDIDATES = 2
_MAX_IGNORED = 60
_MAX_ROW_NUMBERS = 24
_MAX_QUANTITY = 1e9
_LOW_CONFIDENCE = 0.85
_NAME_CONFIDENCE = 0.8

ISSUE_NAME_MATCH = "Matched by company name — confirm the security"
ISSUE_SINGLE_NUMBER = "Quantity inferred from the only unlabelled number — confirm"
ISSUE_DERIVED_LATEST = "Quantity estimated from market value ÷ latest close — enter the exact share count"
ISSUE_DERIVED_SHOWN = "Quantity estimated from market value ÷ price shown — enter the exact share count"
ISSUE_ENTER_QUANTITY = "Enter the share quantity"
ISSUE_NOT_FOUND = "Not found in market data — search manually"
ISSUE_MARKET_DOWN = "Market data unavailable; could not verify this symbol"
ISSUE_SEVERAL = "Several listings match — choose the exchange"
ISSUE_SEVERAL_NAMES = "Several securities match this name — choose one"
ISSUE_CONFUSABLE = "Check characters that OCR can confuse (0/O, 1/I)"
ISSUE_DUPLICATE = "Appears more than once — the UI will combine quantities"
ISSUE_LOW_OCR = "Low OCR confidence"
ISSUE_LOOKUP_LIMIT = "Symbol lookup limit reached — search manually"
ISSUE_UNSUPPORTED = "Listings were found but none can be priced for analysis — search manually"
ISSUE_AMBIGUOUS_FORMAT = "Number format is ambiguous (1,234 vs 1.234) — confirm the values"
ISSUE_RANGE = "The quantity read is outside the supported range — enter it manually"
ISSUE_SEVERAL_QUANTITIES = "Several numbers could be the quantity — enter the share quantity"
ISSUE_NEGATIVE = "The share count shown is zero or negative — enter the quantity"
ISSUE_LOOKS_LIKE_PRICE = "The only unlabelled number looks like a price, not a share count — enter the quantity"
ISSUE_NOT_RECONCILED = "Numbers on this line do not reconcile — check the quantity"
ISSUE_SEVERAL_SYMBOLS = "More than one symbol was read on this line — confirm the security"
ISSUE_NO_SHARES_CELL = "No number was read in the quantity column for this line"
ISSUE_MIXED_CURRENCIES = "The price and market value are shown in different currencies — the quantity was not estimated"

WARN_NO_ROWS = ("No holdings were recognised in this screenshot. Make sure the holdings table is visible "
                "and legible, or add the positions manually.")
WARN_NO_HEADER = "No column header found — values were matched by consistency checks only"
WARN_NO_TEXT = "No text could be read from the image."
WARN_MARKET_DOWN = "Market data is unavailable, so symbols, listings and prices could not be verified."
WARN_LOOKUP_LIMIT = f"Only the first {_MAX_LOOKUPS} symbols were looked up; search the remaining rows manually."
WARN_TRUNCATED = f"Only the first {_MAX_ROWS} holdings rows were processed; add any others manually."

_CURRENCY_SIGNS: dict[str, Optional[str]] = {
    "CA$": "CAD", "C$": "CAD", "US$": "USD", "AU$": "AUD", "A$": "AUD", "HK$": "HKD", "NZ$": "NZD",
    "$": None, "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR",
}
_CURRENCY_PREFIXES = sorted(_CURRENCY_SIGNS, key=len, reverse=True)
_CURRENCY_SUFFIXES = ("€", "$", "£", "¥", "₹")
_CURRENCY_CODES = frozenset({
    "USD", "CAD", "EUR", "GBP", "GBX", "JPY", "AUD", "CHF", "HKD", "NZD", "SGD", "SEK", "NOK", "DKK",
    "INR", "CNY", "KRW", "MXN", "BRL", "ZAR", "ILS", "TWD", "PLN",
})
_CODE_ALIASES = {"GBp": "GBX"}  # pence, as market-data providers write it
# currencies whose amounts are commonly shown with a bare "$"
_DOLLAR_CURRENCIES = frozenset({"USD", "CAD", "AUD", "NZD", "HKD", "SGD", "MXN", "TWD", "CLP", "COP", "ARS"})
_UNIT_WORDS = frozenset({"share", "shares", "shs", "sh", "unit", "units"})
_VENUE_HINTS = {
    "NYSE": "US", "NASDAQ": "US", "NMS": "US", "ARCA": "US", "NYSEARCA": "US", "AMEX": "US", "BATS": "US",
    "OTC": "US", "TSX": "TSX", "TORONTO": "TSX", "TSXV": "TSXV", "TSX-V": "TSXV", "NEO": "NEO", "CSE": "CSE",
    "LSE": "LSE", "LON": "LSE", "XETRA": "XETRA",
}
_VENUES = frozenset(_VENUE_HINTS.values())
# hint -> (listing suffixes that agree with it, the primary listing suffix or None when there is none)
_HINT_SUFFIXES: dict[str, tuple[tuple[str, ...], Optional[str]]] = {
    "USD": (("",), ""), "US": (("",), ""),
    "CAD": (("TO", "V", "NE", "CN"), "TO"), "TSX": (("TO",), "TO"), "TSXV": (("V",), "V"),
    "NEO": (("NE",), "NE"), "CSE": (("CN",), "CN"),
    "GBP": (("L", "IL"), "L"), "GBX": (("L", "IL"), "L"), "LSE": (("L", "IL"), "L"),
    "EUR": (("DE", "F", "PA", "AS", "MI", "MC", "BR", "LS", "VI", "HE", "IR", "BE", "DU", "HM", "HA", "MU", "SG"), None),
    "XETRA": (("DE",), "DE"), "JPY": (("T",), "T"), "HKD": (("HK",), "HK"), "AUD": (("AX",), "AX"),
    "CHF": (("SW",), "SW"), "NZD": (("NZ",), "NZ"), "SGD": (("SI",), "SI"), "SEK": (("ST",), "ST"),
    "NOK": (("OL",), "OL"), "DKK": (("CO",), "CO"), "INR": (("NS", "BO"), None), "KRW": (("KS", "KQ"), None),
    "CNY": (("SS", "SZ"), None), "TWD": (("TW", "TWO"), None), "BRL": (("SA",), "SA"), "MXN": (("MX",), "MX"),
    "ZAR": (("JO",), "JO"), "ILS": (("TA",), "TA"), "PLN": (("WA",), "WA"),
}
_EXCHANGE_SUFFIXES = frozenset({
    "TO", "V", "NE", "CN", "L", "IL", "DE", "F", "BE", "DU", "HM", "HA", "MU", "SG", "PA", "AS", "BR", "LS",
    "MI", "MC", "VI", "HE", "IR", "SW", "ST", "OL", "CO", "IC", "HK", "T", "AX", "NZ", "SI", "KS", "KQ", "SS",
    "SZ", "TW", "TWO", "NS", "BO", "JK", "BK", "KL", "SA", "MX", "BA", "SN", "JO", "TA", "IS", "WA", "PR",
    "AT", "BD", "RG", "VS", "TL", "QA", "SR", "SAU", "KW", "CA", "ME",
})

_HEADER_FAMILIES: dict[str, tuple[str, ...]] = {
    "symbol": ("symbol", "symbols", "ticker", "security", "securities", "holding", "holdings", "name", "asset",
               "assets", "description", "instrument", "investment", "investments", "company", "stock",
               "security name", "titre"),
    "shares": ("shares", "share", "qty", "quantity", "units", "position", "positions", "# of shares",
               "no of shares", "number of shares", "shares held", "share count", "quantité", "qté"),
    "price": ("price", "last", "last price", "current price", "market price", "mkt price", "share price",
              "unit price", "close", "closing price", "last trade", "quote", "price per share", "prix", "cours",
              "last close", "close price"),
    "value": ("market value", "value", "mkt val", "mkt value", "market val", "total value", "balance",
              "current value", "position value", "equity", "valeur", "valeur marchande"),
    "cost": ("avg cost", "average cost", "book cost", "cost basis", "book value", "avg price", "average price",
             "acb", "cost", "unit cost", "purchase price", "total cost", "cost/share", "cost per share",
             "avg buy price", "average buy price", "coût moyen", "valeur comptable", "prix moyen"),
    "gain": ("gain", "gains", "loss", "losses", "gain/loss", "gains/losses", "p&l", "p/l", "pnl", "return",
             "returns", "change", "chg", "today", "today's", "todays", "day", "day's", "unrealized", "unrealised",
             "total return", "%", "% change", "day change", "today's change", "rendement", "variation", "open p&l",
             "session", "1d", "5d", "1w", "1m", "3m", "6m", "1y", "3y", "5y", "10y", "ytd", "mtd", "qtd", "wtd"),
}
_CLASSIC_FAMILIES = frozenset(_HEADER_FAMILIES)
# Columns whose numbers are never a share count, a price or a market value (rates, weights, risk figures...)
# and text columns. They are recognised so their numbers are never mistaken for those.
_HEADER_FAMILIES["other"] = (
    "fx", "fx rate", "rate", "rates", "exchange rate", "exch rate", "conversion", "conversion rate", "conv rate",
    "weight", "weights", "weighting", "wt", "allocation", "alloc", "% of portfolio", "% of account", "% of acct",
    "% of total", "% of holdings", "% of port", "portfolio %", "share of portfolio", "% share", "volatility", "vol",
    "annual volatility", "annualized volatility", "annualised volatility", "beta", "risk", "risk share",
    "risk contrib", "risk contribution", "contribution", "contrib", "share of risk", "yield", "div yield",
    "dividend yield", "yld", "dividend", "dividends", "div", "income", "annual income", "est annual income",
    "expense ratio", "mer", "sharpe", "correlation", "corr", "drawdown", "max drawdown", "volume", "avg volume",
    "market cap", "mkt cap", "bid", "ask", "high", "low", "open", "day high", "day low", "day range",
    "prev close", "previous close", "p/e", "pe ratio", "eps",
)
_HEADER_FAMILIES["label"] = (
    "exchange", "exch", "venue", "listing", "currency", "ccy", "curr", "quote currency", "trading currency",
    "account", "acct", "account type", "type", "asset class", "sector", "industry", "country", "region", "status",
    "action", "actions", "notes",
)
_HEADER_PHRASES = {tuple(p.split()): family for family, phrases in _HEADER_FAMILIES.items() for p in phrases}
_HEADER_VOCAB = frozenset(word for key in _HEADER_PHRASES for word in key)
_HEADER_WORDS = frozenset(key[0] for key, family in _HEADER_PHRASES.items()
                          if len(key) == 1 and family in _CLASSIC_FAMILIES)
_ROW_FAMILIES = frozenset({"symbol", "shares", "price"})
_INERT_FAMILIES = frozenset({"cost", "gain", "other", "label"})  # numbers under these labels are never used
_ICON_CHARS = frozenset("1li|!")  # how OCR often reads sort arrows beside column labels

_TOTAL_PREFIXES = (
    "total", "totals", "subtotal", "sub-total", "sub total", "grand total", "cash", "buying power", "net deposits",
    "account value", "portfolio value", "account total", "portfolio total", "net liquidation", "net worth",
    "available", "balance", "market value", "settled cash", "total value",
)
_TOTAL_PHRASES = (
    "account value", "portfolio value", "buying power", "net deposits", "total value", "total market value",
    "cash balance", "account total", "portfolio total", "net liquidation", "available to trade", "available cash",
    "settled cash", "net worth", "total equity",
)
_TOTAL_WORDS = frozenset({"total", "totals", "subtotal", "cash"})
_NAME_STOP_WORDS = _HEADER_WORDS
_GENERIC_NAME_WORDS = frozenset({
    "inc", "corp", "corporation", "ltd", "limited", "plc", "the", "company", "group", "holdings", "holding", "etf",
    "fund", "trust", "class", "shares", "share", "common", "ordinary", "and", "of", "index", "new", "del", "adr",
})

_SOFT_STOP = frozenset({"ALL", "LOW", "DAY", "OPEN", "HIGH", "PM", "AM", "ET", "SA", "AG", "NA", "NEO", "VAL",
                        "COST", "GAIN", "UNIT", "ACB", "CAN", "USA", "GIC", "DRIP", "PCT", "CBOE"})
_SPEC_STOP = frozenset({
    "USD", "CAD", "EUR", "GBP", "JPY", "AUD", "CHF", "HKD", "ETF", "BUY", "SELL", "HOLD", "TOTAL", "CASH",
    "NYSE", "NASDAQ", "TSX", "TSXV", "NEO", "ARCA", "AMEX", "LSE", "OTC", "INC", "LTD", "CORP", "CO", "PLC",
    "AG", "SA", "NV", "THE", "AND", "OF", "US", "CA", "UK", "AM", "PM", "EST", "EDT", "ET", "YTD", "N/A", "NA",
    "QTY", "AVG", "MKT", "VAL", "P/L", "ALL", "DAY", "OPEN", "CLOSE", "HIGH", "LOW", "CLASS", "SHARES", "UNITS",
})
_EXTRA_STOP = frozenset({
    "TFSA", "RRSP", "FHSA", "RESP", "RRIF", "LIRA", "LIF", "IRA", "ROTH", "HSA", "RDSP", "GIC", "ETFS", "ADR",
    "DRIP", "PCT", "YOY", "MTD", "QTD", "UTC", "GMT", "PST", "PDT", "CST", "CDT", "MST", "MDT", "USA", "CAN",
    "MENU", "LOGIN", "SEARCH", "HELP", "FILTER", "SORT", "TRADE", "ORDERS", "ACCOUNT", "SUMMARY", "DETAILS",
    "TO", "IN", "AT", "BY", "FROM", "WITH", "YOUR", "MY", "NOT", "NEW", "VIEW", "BATS", "CBOE", "NMS", "XETRA",
    "LON", "CSE", "NYSEARCA",
})
_HARD_STOP = frozenset(
    (_SPEC_STOP | _EXTRA_STOP | _CURRENCY_CODES | {word.upper() for word in _HEADER_WORDS}) - _SOFT_STOP
)

_SYMBOL = re.compile(r"[A-Z][A-Z0-9]{0,5}(?:[.\-][A-Z0-9]{1,4}){0,2}")
_ASIAN_SYMBOL = re.compile(r"\d{3,6}\.[A-Z]{1,3}")
_PAREN_SYMBOL = re.compile(r"\(([A-Z0-9][A-Z0-9.\-]{0,11})\)")
_CONFUSABLE = re.compile(r"[0O1IL5S8B]")
_SEGMENT_BREAK = re.compile(r"\s{2,}|\s*[|·•]\s*|\s+[\u2013\u2014]\s+")
_UNIT_SUFFIX = re.compile(r"(.*\d)\s*(?:shares?|shs?|units?)", re.IGNORECASE)
_PLAIN_NUMBER = re.compile(r"\d+")
_AMBIGUOUS_DOT = re.compile(r"[1-9]\d{0,2}\.\d{3}")
_AMBIGUOUS_COMMA = re.compile(r"[1-9]\d{0,2},\d{3}")
_US_NUMBER = re.compile(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d{1,3}(?:'\d{3})+(?:\.\d+)?")
_EU_NUMBER = re.compile(r"\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+,\d+|\d{1,3}(?: \d{3})+(?:,\d+)?")
_FUSED_PERCENT = re.compile(r"(.*\d\.\d{2})([-+]?\d{1,3}(?:\.\d{1,2})?%)")
_DASH_MINUS = re.compile(r"[\u2013\u2014](?=[\d$€£¥(])")
_SPACES = re.compile(r"[^\S ]")


# --------------------------------------------------------------------------------------- image


def _load_image(data: bytes) -> tuple[Any, list[str]]:
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise ScreenshotError("Upload the screenshot as image bytes.")
    payload = bytes(data)
    if not payload:
        raise ScreenshotError("The uploaded screenshot is empty.")
    if len(payload) > MAX_BYTES:
        raise ScreenshotError("Screenshots must be 8 MB or smaller.")
    notes: list[str] = []
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            image = _decode(payload, notes)
    except ScreenshotError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ScreenshotError("The image has too many pixels to process safely.") from exc
    except Exception as exc:  # Pillow raises many exception types for corrupt or unsupported files
        raise ScreenshotError("The file is not a readable PNG, JPEG, WebP, BMP or GIF image.") from exc
    return image, notes


def _decode(payload: bytes, notes: list[str]) -> Any:
    Image.init()
    image = Image.open(io.BytesIO(payload), formats=[name for name in _FORMATS if name in Image.OPEN])
    if image.format not in _ACCEPTED_FORMATS:
        raise ScreenshotError("Only PNG, JPEG, WebP, BMP and GIF screenshots are supported.")
    width, height = image.size
    if width * height > MAX_PIXELS:  # explicit check: warning filters are not thread-safe
        raise ScreenshotError("The image has too many pixels to process safely.")
    image.load()
    try:
        image = ImageOps.exif_transpose(image)
    except Exception:
        notes.append("The image orientation tag could not be applied; the screenshot was read as stored.")
    width, height = image.size
    if max(width, height) < _MIN_LONG_SIDE or min(width, height) < _MIN_SHORT_SIDE:
        raise ScreenshotError("The image is too small to read; upload a screenshot of at least 120 × 60 pixels.")
    if max(width, height) / min(width, height) > _MAX_ASPECT:
        raise ScreenshotError("The image is too narrow or too wide to be a holdings screenshot.")
    return _to_rgb(image)


def _to_rgb(image: Any) -> Any:
    if image.mode in ("I", "F") or image.mode.startswith("I;16"):
        values = np.nan_to_num(np.asarray(image, dtype=np.float64))
        top = 65535.0 if image.mode.startswith("I;16") else max(255.0, float(values.max(initial=0.0)))
        return Image.fromarray(np.clip(values * (255.0 / top), 0, 255).astype(np.uint8)).convert("RGB")
    if image.mode in ("RGBA", "LA", "PA", "RGBa", "La") or "transparency" in image.info:
        rgba = image.convert("RGBA")
        canvas = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        canvas.alpha_composite(rgba)
        return canvas.convert("RGB")
    return image.convert("RGB")


def _ocr_array(image: Any) -> tuple[Any, float, float]:
    """Return the RGB array given to OCR plus the x/y scale factors from original pixels."""
    width, height = image.size
    longest = max(width, height)
    factor = 2.0 if longest < _UPSCALE_BELOW else min(1.0, _MAX_OCR_SIDE / longest)
    if factor != 1.0:
        size = (max(1, round(width * factor)), max(1, round(height * factor)))
        image = image.resize(size, Image.Resampling.LANCZOS)
    array = np.ascontiguousarray(np.asarray(image, dtype=np.uint8))
    return array, array.shape[1] / width, array.shape[0] / height


# ----------------------------------------------------------------------------------------- OCR

_ENGINE_LOCK = threading.Lock()
_engine: Any = None


def _quiet_ocr_logging() -> None:
    for name in ("RapidOCR", "rapidocr"):
        logging.getLogger(name).setLevel(logging.WARNING)


def _create_engine() -> Any:
    _quiet_ocr_logging()
    try:
        from rapidocr import RapidOCR
    except Exception as exc:
        raise OcrUnavailable(
            "Screenshot import needs the local OCR engine (rapidocr with onnxruntime), which is not installed."
        ) from exc
    params = {"Global.log_level": "warning", "Global.use_cls": False, "Global.max_side_len": _MAX_OCR_SIDE}
    try:
        engine = RapidOCR(params=params)
        for loader in ("_load_det_model", "_load_rec_model"):  # load models now so failures surface here
            method = getattr(engine, loader, None)
            if callable(method):
                method()
    except Exception as exc:
        raise OcrUnavailable("The local OCR engine could not start; its model files may be missing or damaged.") from exc
    finally:
        _quiet_ocr_logging()
    return engine


def _rapidocr(array: Any) -> list[tuple[Any, str, float]]:
    global _engine
    with _ENGINE_LOCK:  # the engine is not thread-safe, so creation and calls are serialised
        if _engine is None:
            _engine = _create_engine()
        try:
            result = _engine(np.ascontiguousarray(array[:, :, ::-1]))  # RapidOCR expects BGR arrays
        except Exception as exc:
            raise OcrUnavailable("The local OCR engine failed while reading the screenshot.") from exc
    boxes, texts, scores = (getattr(result, name, None) for name in ("boxes", "txts", "scores"))
    if boxes is None or texts is None or scores is None:
        return []
    return [(box, str(text), float(score)) for box, text, score in zip(boxes, texts, scores)]


@dataclass(frozen=True)
class _Box:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    score: float


def _clamp(value: float, low: float, high: float) -> float:
    return min(max(float(value), low), high)


def _normalise_text(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).replace("\u2212", "-").replace("\u2010", "-").replace("\u2011", "-")
    text = _DASH_MINUS.sub("-", text)
    return _SPACES.sub(" ", text).strip()


def _read_boxes(raw: Any, sx: float, sy: float, width: int, height: int) -> list[_Box]:
    boxes: list[_Box] = []
    for item in list(raw if raw is not None else [])[:_MAX_BOXES]:
        try:
            points = np.asarray(item[0], dtype=float).reshape(-1, 2)
            text = _normalise_text(str(item[1]))
            score = float(item[2])
        except (TypeError, ValueError, IndexError):
            continue
        if not text or len(points) < 2 or not np.isfinite(points).all() or not math.isfinite(score):
            continue
        x0, x1 = (_clamp(v / sx, 0.0, width) for v in (points[:, 0].min(), points[:, 0].max()))
        y0, y1 = (_clamp(v / sy, 0.0, height) for v in (points[:, 1].min(), points[:, 1].max()))
        if x1 - x0 >= 1 and y1 - y0 >= 1:
            boxes.append(_Box(text, x0, y0, x1, y1, _clamp(score, 0.0, 1.0)))
    return boxes


# -------------------------------------------------------------------------------------- tokens


@dataclass
class _Num:
    value: float
    alt: Optional[float]
    style: str  # plain | us | eu | ambiguous
    monetary: bool = False
    currency: Optional[str] = None
    percent: bool = False
    signed: bool = False
    negative: bool = False
    unit: bool = False
    uncertain: bool = False


@dataclass
class _Token:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    score: float
    num: Optional[_Num] = None
    phrase: bool = False
    weak: bool = False  # ticker-shaped first word split from a mixed-case company name
    source: int = -1  # index of the OCR box the token came from

    @property
    def xc(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def yc(self) -> float:
        return (self.y0 + self.y1) / 2

    @property
    def height(self) -> float:
        return self.y1 - self.y0


@dataclass
class _Item:
    kind: str  # number | currency | unit | percent | dash | text
    start: int
    end: int
    text: str
    num: Optional[_Num] = None
    code: Optional[str] = None


Piece = tuple[int, int, str, Optional[_Num], bool, bool]


def _read_body(body: str) -> Optional[tuple[float, Optional[float], str]]:
    if _PLAIN_NUMBER.fullmatch(body):
        return float(body), None, "plain"
    if _AMBIGUOUS_DOT.fullmatch(body):
        return float(body), float(body.replace(".", "")), "ambiguous"
    if _AMBIGUOUS_COMMA.fullmatch(body):
        return float(body.replace(",", "")), float(body.replace(",", ".")), "ambiguous"
    if _US_NUMBER.fullmatch(body):
        return float(body.replace(",", "").replace("'", "")), None, "us"
    if _EU_NUMBER.fullmatch(body):
        return float(body.replace(".", "").replace(" ", "").replace(",", ".")), None, "eu"
    return None


def _parse_number(word: str) -> Optional[_Num]:
    """Parse one number with optional sign, parentheses, currency, percent and share-unit markers."""
    s = word.strip()
    if not any(ch.isdigit() for ch in s):
        return None
    negative = signed = monetary = percent = unit = False
    currency: Optional[str] = None
    while True:
        before = s
        if len(s) > 2 and s[0] == "(" and s[-1] == ")":
            s, negative, signed = s[1:-1].strip(), True, True
        if s[:1] in ("+", "-"):
            negative, signed, s = negative or s[0] == "-", True, s[1:].lstrip()
        if not monetary:
            prefix = next((p for p in _CURRENCY_PREFIXES if s.startswith(p)), None)
            if prefix:
                monetary, currency, s = True, _CURRENCY_SIGNS[prefix], s[len(prefix):].lstrip()
        if s == before:
            break
    if s.endswith("%"):
        percent, s = True, s[:-1].rstrip()
    if not monetary:
        suffix = next((p for p in _CURRENCY_SUFFIXES if s.endswith(p)), None)
        if suffix:
            monetary, currency, s = True, _CURRENCY_SIGNS[suffix], s[: -len(suffix)].rstrip()
    if not monetary and re.fullmatch(r".*\dp", s):  # '118.90p': a UK price in pence
        monetary, currency, s = True, "GBX", s[:-1]
    match = _UNIT_SUFFIX.fullmatch(s)
    if match:
        unit, s = True, match.group(1)
    if len(s) > 2 and s[0] == "(" and s[-1] == ")":
        s, negative, signed = s[1:-1].strip(), True, True
    parsed = _read_body(s)
    if parsed is None:
        return None
    value, alt, style = parsed
    # a space-grouped number ('1 234,56') may really be two numbers that OCR put in one box
    return _Num(value, alt, style, monetary, currency, percent, signed, negative, unit, uncertain=" " in s)


def _symbol_shape(text: str) -> bool:
    if _ASIAN_SYMBOL.fullmatch(text):
        return True
    if not _SYMBOL.fullmatch(text):
        return False
    base, *suffixes = re.split(r"[.\-]", text)
    digits = sum(ch.isdigit() for ch in base)
    return digits <= len(base) - digits and all(any(ch.isalpha() for ch in part) for part in suffixes)


def _symbol_kind(text: str) -> Optional[str]:
    if not _symbol_shape(text):
        return None
    if text in _SOFT_STOP:
        return "soft"
    return None if text in _HARD_STOP else "hard"


def _segments(text: str) -> list[tuple[int, int]]:
    spans, start = [], 0
    for match in _SEGMENT_BREAK.finditer(text):
        if match.start() > start:
            spans.append((start, match.start()))
        start = max(start, match.end())
    if start < len(text):
        spans.append((start, len(text)))
    return spans


def _merge_digit_groups(words: list[tuple[int, int, str]]) -> list[tuple[int, int, str]]:
    """Join French-style grouped numbers such as '1 234,56' that OCR splits on the group space."""
    merged, i = [], 0
    while i < len(words):
        j = i + 1
        if re.fullmatch(r"\d{1,3}", words[i][2]):
            while j < len(words) and re.fullmatch(r"\d{3}", words[j][2]):
                j += 1
            if j < len(words) and re.fullmatch(r"\d{3},\d{1,4}[€$£%]?", words[j][2]):
                merged.append((words[i][0], words[j][1], " ".join(w[2] for w in words[i:j + 1])))
                i = j + 1
                continue
        merged.append(words[i])
        i += 1
    return merged


def _unfuse(word: tuple[int, int, str]) -> list[tuple[int, int, str]]:
    """Split an amount that OCR joined to the percentage beside it ('4,250.6432.8%' → '4,250.64', '32.8%').

    The cut assumes the amount has two decimals, so it is only made for amounts of 100 or more: any
    other reading of the digits would change such an amount by less than 0.1%.
    """
    start, end, text = word
    match = _FUSED_PERCENT.fullmatch(text)
    if match is None or _parse_number(text) is not None:
        return [word]
    amount, percent = _parse_number(match.group(1)), _parse_number(match.group(2))
    if amount is None or percent is None or amount.percent or amount.signed or amount.value < 100:
        return [word]
    cut = start + match.end(1)
    return [(start, cut, match.group(1)), (cut, end, match.group(2))]


def _classify_word(start: int, end: int, word: str) -> _Item:
    core = word.rstrip(",;:*\u2020\u2021") or word  # trailing punctuation and footnote markers (SPAXX**)
    num = _parse_number(core)
    if num is not None:
        return _Item("number", start, start + len(core), core, num)
    if core in _CURRENCY_SIGNS:
        return _Item("currency", start, end, core, code=_CURRENCY_SIGNS[core])
    if core in _CODE_ALIASES:
        return _Item("currency", start, end, core, code=_CODE_ALIASES[core])
    if core in _CURRENCY_CODES:
        return _Item("currency", start, end, core, code=core)
    if core.lower() in _UNIT_WORDS and not (core.isupper() and len(core) <= 3):
        return _Item("unit", start, end, core)
    if core == "%":
        return _Item("percent", start, end, core)
    if core in ("-", "\u2013", "\u2014"):
        return _Item("dash", start, end, core)
    return _Item("text", start, start + len(core), core)


def _attach_prefixes(items: list[_Item]) -> list[_Item]:
    out, i = [], 0
    while i < len(items):
        item = items[i]
        if item.kind == "dash":
            j = i + 1 + (i + 1 < len(items) and items[i + 1].kind == "currency")
            if j < len(items) and items[j].kind == "number" and not items[j].num.signed:
                items[j].num.signed = items[j].num.negative = True
                items[j].start = item.start
                i += 1
                continue
        if item.kind == "currency" and i + 1 < len(items) and items[i + 1].kind == "number" \
                and _absorbs(items[i + 1].num, item.code):
            number = items[i + 1]
            number.num.monetary, number.num.currency = True, item.code or number.num.currency
            number.start = min(number.start, item.start)
            i += 1
            continue
        out.append(item)
        i += 1
    return out


def _absorbs(num: _Num, code: Optional[str]) -> bool:
    """Whether a currency marker beside a number belongs to it; a code also names a bare '$' ('$660.00 CAD')."""
    return not num.monetary or (num.currency is None and code in _DOLLAR_CURRENCIES)


def _attach_suffixes(items: list[_Item]) -> list[_Item]:
    out: list[_Item] = []
    for item in items:
        previous = out[-1] if out else None
        if previous is not None and previous.kind == "number":
            num = previous.num
            if item.kind == "currency" and _absorbs(num, item.code):
                num.monetary, num.currency, previous.end = True, item.code or num.currency, item.end
                continue
            if item.kind == "text" and item.text == "p" and not (num.monetary or num.percent):  # '118.90 p'
                num.monetary, num.currency, previous.end = True, "GBX", item.end
                continue
            if item.kind == "percent" and not num.percent:
                num.percent, previous.end = True, item.end
                continue
            if item.kind == "unit" and not num.unit:
                num.unit, previous.end = True, item.end
                continue
        out.append(item)
    return out


def _bare_integer(item: _Item) -> bool:
    num = item.num
    return (item.kind == "number" and num.style == "plain" and item.text.isdigit()
            and not (num.monetary or num.percent or num.unit or num.signed))


def _glue_name_numbers(items: list[_Item]) -> list[_Item]:
    """Keep integers that belong to names ('S&P 500 Index', 'Nasdaq 100') inside the text."""
    for i, item in enumerate(items):
        if not _bare_integer(item):
            continue
        before, j = 0, i - 1
        while j >= 0 and items[j].kind == "text":
            before, j = before + 1, j - 1
        followed = i + 1 < len(items) and items[i + 1].kind == "text"
        if before and (followed or (i + 1 == len(items) and before >= 2)):
            item.kind, item.num = "text", None
    return items


def _text_pieces(text: str, run: list[_Item]) -> list[Piece]:
    def single(item: _Item, label: Optional[str] = None, weak: bool = False) -> Piece:
        return item.start, item.end, label or item.text, None, False, weak

    words = [item.text for item in run]
    if len(run) == 1:
        match = _PAREN_SYMBOL.fullmatch(words[0])
        return [single(run[0], match.group(1) if match and _symbol_shape(match.group(1)) else None)]
    first, rest = words[0], words[1:]
    if _symbol_shape(first) and first not in _HARD_STOP:
        if re.search(r"[.\-]", first) or all(w.strip("()").upper() in _VENUE_HINTS or w.strip("()") in _CURRENCY_CODES
                                             for w in rest):
            return [single(run[0])] + _text_pieces(text, run[1:])
        if any(ch.islower() for w in rest for ch in w):
            return [single(run[0], weak=True)] + _text_pieces(text, run[1:])
    match = _PAREN_SYMBOL.fullmatch(words[-1])
    if match and _symbol_shape(match.group(1)):
        return _text_pieces(text, run[:-1]) + [single(run[-1], match.group(1))]
    return [(run[0].start, run[-1].end, text[run[0].start:run[-1].end], None, True, False)]


def _assemble(text: str, items: list[_Item]) -> list[Piece]:
    pieces: list[Piece] = []
    run: list[_Item] = []
    for item in [*items, None]:
        if item is not None and item.kind == "text":
            run.append(item)
            continue
        if run:
            pieces.extend(_text_pieces(text, run))
            run = []
        if item is None or item.kind == "dash":
            continue
        if item.kind == "number":
            pieces.append((item.start, item.end, text[item.start:item.end], item.num, False, False))
        else:
            pieces.append((item.start, item.end, item.text, None, False, False))
    return pieces


def _split_text(text: str) -> list[Piece]:
    pieces: list[Piece] = []
    for seg_start, seg_end in _segments(text):
        words = [part for m in re.finditer(r"\S+", text[seg_start:seg_end])
                 for part in _unfuse((seg_start + m.start(), seg_start + m.end(), m.group()))]
        items = [_classify_word(*word) for word in _merge_digit_groups(words)]
        pieces.extend(_assemble(text, _glue_name_numbers(_attach_suffixes(_attach_prefixes(items)))))
    return pieces


def _box_tokens(box: _Box, source: int = -1) -> list[_Token]:
    """Split one OCR box into tokens, estimating each token's x-span from character positions."""
    length, span = len(box.text), box.x1 - box.x0
    tokens = []
    for start, end, label, num, phrase, weak in _split_text(box.text):
        x0 = box.x0 + span * start / length
        x1 = max(box.x0 + span * end / length, x0 + 1.0)
        tokens.append(_Token(label, x0, box.y0, x1, box.y1, box.score, num, phrase, weak, source))
    return tokens


def _apply_number_locale(tokens: list[_Token]) -> None:
    """Settle '1,234' / '1.234' using the unambiguous numbers elsewhere in the image."""
    styles = [t.num.style for t in tokens if t.num is not None]
    us, eu = styles.count("us"), styles.count("eu")
    for token in tokens:
        num = token.num
        if num is None or num.style != "ambiguous":
            continue
        if eu and not us:
            num.value = num.alt
        elif not (us and not eu):
            num.uncertain = True


def _currency_codes_in(text: str) -> list[str]:
    return [word for word in re.findall(r"(?<![A-Za-z])[A-Z]{3}(?![A-Za-z])", text) if word in _CURRENCY_CODES]


def _amount(token: _Token) -> float:
    """A number in ISO currency units (prices shown in pence become pounds)."""
    return token.num.value * (0.01 if token.num.currency == "GBX" else 1.0)


def _marker(num: _Num) -> Optional[str]:
    """The currency a number is shown in: an ISO code, '$' for a bare dollar sign, or None."""
    if not num.monetary:
        return None
    if num.currency is None:
        return "$"
    return "GBP" if num.currency == "GBX" else num.currency


def _named_dollar(markers: Iterable[str]) -> Optional[str]:
    named = {marker for marker in markers if marker in _DOLLAR_CURRENCIES}
    return named.pop() if len(named) == 1 else None


def _markers(tokens: Iterable[_Token], phrases: bool = True) -> list[str]:
    """Currency markers on a line or row; a bare '$' counts as the only dollar currency named there."""
    found: list[str] = []
    for token in tokens:
        if token.num is not None:
            marker = _marker(token.num)
            found += [marker] if marker else []
        elif phrases or not token.phrase:
            found += ["GBP" if code == "GBX" else code for code in _currency_codes_in(token.text)]
    dollar = _named_dollar(found)
    return [dollar if marker == "$" and dollar else marker for marker in found]


def _compatible(marker: str, currency_iso: Optional[str]) -> bool:
    if marker == "$":
        return currency_iso in _DOLLAR_CURRENCIES
    return currency_iso is not None and marker == currency_iso


def _same_currency(a: _Token, b: _Token) -> bool:
    """Whether two amounts on a row are in the same currency, as far as the row shows (unmarked agrees)."""
    first, second = _marker(a.num), _marker(b.num)
    if first is None or second is None or first == second:
        return True
    if "$" in (first, second):
        return (second if first == "$" else first) in _DOLLAR_CURRENCIES
    return False


def _currency_label(marker: Optional[str]) -> str:
    return "dollars" if marker == "$" else marker or "an unstated currency"


def _currency_hint(lines: Iterable[list[_Token]]) -> Optional[str]:
    """The currency that clearly dominates the image: ≥3× every marker that contradicts it.

    A bare '$' contradicts non-dollar currencies (4× '$' and 2× '£' give no hint) but not CAD or USD.
    """
    counts: dict[str, int] = {}
    for tokens in lines:
        for marker in _markers(tokens):
            counts[marker] = counts.get(marker, 0) + 1
    codes = [marker for marker in counts if marker != "$"]
    if not codes:
        return None
    top = max(codes, key=lambda code: counts[code])
    rival = max((count for marker, count in counts.items()
                 if marker != top and not (marker == "$" and top in _DOLLAR_CURRENCIES)), default=0)
    return top if counts[top] >= 3 * rival else None


# --------------------------------------------------------------------------------------- lines


@dataclass(frozen=True)
class _Column:
    family: str
    x0: float
    x1: float
    currency: Optional[str] = None  # from a label such as "Value (USD)"; '$' for a bare dollar sign


@dataclass
class _Header:
    yc: float
    columns: list[_Column]
    gap: float

    def has(self, family: str) -> bool:
        return any(column.family == family for column in self.columns)

    def column_for(self, token: _Token) -> Optional[_Column]:
        """The nearest column label; None when far away or between two columns that are used differently."""
        def distance(column: _Column) -> float:
            return min(abs(token.x0 - column.x0), abs(token.xc - (column.x0 + column.x1) / 2), abs(token.x1 - column.x1))

        ranked = sorted(self.columns, key=distance)
        best = distance(ranked[0])
        if best > 0.6 * self.gap:
            return None
        if (len(ranked) > 1 and ranked[1].family != ranked[0].family and best > 0.75 * distance(ranked[1])
                and not {ranked[0].family, ranked[1].family} <= _INERT_FAMILIES):
            return None
        return ranked[0]

    def family_for(self, token: _Token) -> Optional[str]:
        column = self.column_for(token)
        return column.family if column else None


@dataclass
class _Line:
    tokens: list[_Token]
    yc: float
    height: float
    header: Optional[_Header] = None
    total: bool = False
    symbol: Optional[_Token] = None
    symbol_kind: str = ""
    strong_symbols: frozenset = frozenset()

    @property
    def text(self) -> str:
        return " ".join(token.text for token in self.tokens)

    @property
    def numbers(self) -> list[_Token]:
        return [token for token in self.tokens if token.num is not None]

    @property
    def has_values(self) -> bool:
        return any(not token.num.percent for token in self.numbers)

    @property
    def data(self) -> bool:
        return self.header is None and not self.total


def _cluster_lines(tokens: list[_Token]) -> list[_Line]:
    if not tokens:
        return []
    tolerance = _LINE_TOLERANCE * statistics.median(token.height for token in tokens)
    groups: list[list[_Token]] = []
    centres: list[float] = []
    for token in sorted(tokens, key=lambda t: t.yc):
        if groups and abs(token.yc - centres[-1]) <= tolerance:
            groups[-1].append(token)
            centres[-1] = statistics.fmean(t.yc for t in groups[-1])
        else:
            groups.append([token])
            centres.append(token.yc)
    return [_Line(sorted(group, key=lambda t: t.x0), centre, statistics.median(t.height for t in group))
            for group, centre in zip(groups, centres)]


def _norm_word(word: str) -> str:
    return word.lower().replace("\u2019", "'").strip(".,:;()[]{}*\"")


def _token_words(token: _Token) -> list[tuple[str, float, float]]:
    length, span = len(token.text), token.x1 - token.x0
    return [(_norm_word(m.group()), token.x0 + span * m.start() / length, token.x0 + span * m.end() / length)
            for m in re.finditer(r"\S+", token.text)]


@dataclass(frozen=True)
class _HeaderWord:
    text: str  # vocabulary form; '' for a currency word
    currency: Optional[str]  # for words such as 'USD', '(€)' or '$' that qualify the label before them
    x0: float
    x1: float
    source: int


def _icon_noise(token: _Token) -> bool:
    """Sort arrows beside a column label are often read as '1', '11' or '↑1' rather than as symbols."""
    num = token.num
    return (num is not None and num.style == "plain" and not (num.monetary or num.percent or num.signed)
            and re.fullmatch(r"1+", token.text.split()[0]) is not None)


def _header_currency(raw: str) -> Optional[str]:
    core = raw.strip(".,:;()[]{}*\"")
    if core in _CODE_ALIASES or core.upper() == "GBX" or raw == "(p)":
        return "GBX"
    if core in _CURRENCY_SIGNS:
        return _CURRENCY_SIGNS[core] or "$"
    return core.upper() if core.isalpha() and core.upper() in _CURRENCY_CODES else None


def _icon_char(ch: str) -> bool:
    return ch in _ICON_CHARS or not (ch.isalnum() or ch in "%#&_")


def _clean_header_word(raw: str) -> str:
    """A header word in vocabulary form without sort-icon glyphs ('Name1↓', '1↓Shares' → 'name', 'shares');
    '' for pure noise."""
    word = re.sub(r"^[^\w%#&]+|[^\w%#&]+$", "", _norm_word(raw))
    if not word or word in _HEADER_VOCAB:
        return word
    for lead in range(4):
        for trail in range(4):
            core = word[lead:len(word) - trail]
            if core in _HEADER_VOCAB and all(_icon_char(ch) for ch in word[:lead] + word[len(word) - trail:]):
                return core
    return "" if all(_icon_char(ch) for ch in word) else word


def _header_words(line: _Line) -> Optional[list[_HeaderWord]]:
    """The words of a possible header line, or None when it holds numbers that a header would not."""
    numbers = [t for t in line.numbers if not _icon_noise(t)]
    if len(numbers) > 2 or any(t.num.style != "plain" or t.num.monetary or t.num.percent or t.num.signed for t in numbers):
        return None
    words = []
    for token in line.tokens:
        length, span = len(token.text), token.x1 - token.x0
        for m in re.finditer(r"\S+", token.text):
            currency = _header_currency(m.group())
            text = "" if currency else _clean_header_word(m.group())
            if currency or text:
                words.append(_HeaderWord(text, currency, token.x0 + span * m.start() / length,
                                         token.x0 + span * m.end() / length, token.source))
    return words


def _header_phrase(words: list[_HeaderWord], i: int) -> tuple[int, Optional[str]]:
    """The longest column label starting at ``words[i]``, read within one OCR box ('Risk share' beats 'share')."""
    for size in (3, 2, 1):
        chunk = words[i:i + size]
        if len(chunk) == size and all(w.currency is None and w.source == chunk[0].source for w in chunk):
            family = _HEADER_PHRASES.get(tuple(w.text for w in chunk))
            if family:
                return size, family
    return 1, None


def _detect_header(line: _Line) -> Optional[_Header]:
    words = _header_words(line)
    if words is None:
        return None
    columns: list[dict[str, Any]] = []
    current: Optional[dict[str, Any]] = None  # the column label the previous word belonged to
    matched, i = 0, 0
    while i < len(words):
        word = words[i]
        if word.currency is not None:
            if current is not None and (word.source == current["source"] or word.x0 - current["x1"] <= 1.5 * line.height):
                current["x1"] = max(current["x1"], word.x1)
                current["currency"] = current["currency"] or word.currency
            i += 1
            continue
        size, family = _header_phrase(words, i)
        if family is None:
            current, i = None, i + 1
            continue
        end = words[i + size - 1].x1
        if current is not None and current["source"] == word.source and (
                family == current["family"] or (size == 1 and word.text == "%")):
            current["x1"] = end  # one label read as several phrases, or 'Weight %'
        else:
            current = {"family": family, "x0": word.x0, "x1": end, "source": word.source, "currency": None}
            columns.append(current)
        matched, i = matched + size, i + size
    families = {column["family"] for column in columns}
    alphabetic = sum(1 for w in words if w.currency is None and re.search(r"[a-z%#&]", w.text))
    if len(families & _CLASSIC_FAMILIES) < 2 or not families & _ROW_FAMILIES or matched * 2 < alphabetic:
        return None
    result = [_Column(c["family"], c["x0"], c["x1"], c["currency"]) for c in sorted(columns, key=lambda c: c["x0"])]
    centres = [(c.x0 + c.x1) / 2 for c in result]
    gaps = [b - a for a, b in zip(centres, centres[1:]) if b - a > 0]
    gap = statistics.median(gaps) if gaps else 4 * line.height
    return _Header(line.yc, result, max(gap, line.height))


def _line_symbol(line: _Line) -> tuple[Optional[_Token], str, frozenset]:
    words = [t for t in line.tokens if t.num is None and not t.phrase]
    strong = [t for t in words if not t.weak and _symbol_kind(t.text) == "hard"]
    if strong:
        return strong[0], "strong", frozenset(t.text for t in strong)
    weak = [t for t in words if t.weak and _symbol_kind(t.text) == "hard"]
    if weak:
        return weak[0], "weak", frozenset()
    first = line.tokens[0]
    if first.num is None and not first.phrase and _symbol_kind(first.text) == "soft":
        return first, "soft", frozenset()
    return None, "", frozenset()


def _is_total(line: _Line) -> bool:
    if line.symbol is not None and line.symbol_kind in ("strong", "weak"):
        return False
    words = [w for t in line.tokens if t.num is None for w, _, _ in _token_words(t) if re.search(r"[a-z]", w)]
    if not words:
        return False
    joined = " ".join(words)
    if any(joined == p or joined.startswith(p + " ") for p in _TOTAL_PREFIXES):
        return True
    if any(f" {p} " in f" {joined} " for p in _TOTAL_PHRASES):
        return True
    others = [w for w in words if w not in _TOTAL_WORDS and w.upper() not in _CURRENCY_CODES]
    return any(w in _TOTAL_WORDS for w in words) and len(others) <= 1


def _analyse_line(line: _Line) -> None:
    line.header = _detect_header(line)
    if line.header is None:
        line.symbol, line.symbol_kind, line.strong_symbols = _line_symbol(line)
        line.total = _is_total(line)


def _name_text_ok(text: str) -> bool:
    words = [w for w in text.split() if any(ch.isalpha() for ch in w)]
    chars = [ch for ch in text if not ch.isspace()]
    if len(words) < 2 or not chars or sum(ch.isalpha() for ch in chars) < 0.6 * len(chars):
        return False
    return sum(1 for w in words if _norm_word(w) in _NAME_STOP_WORDS) * 2 < len(words)


def _name_line(line: _Line) -> bool:
    if not line.data or line.numbers or (line.symbol is not None and line.symbol_kind != "weak"):
        return False
    return _name_text_ok(line.text)


# -------------------------------------------------------------------------------------- groups


def _group_lines(lines: list[_Line]) -> list[list[_Line]]:
    """Merge two-line rows: ticker over numbers (or the reverse), share-count lines and name lines."""
    n = len(lines)
    used = [False] * n
    groups: list[list[int]] = []

    def gap(a: int, b: int) -> float:
        return abs(lines[a].yc - lines[b].yc)

    def near(a: int, b: int) -> bool:
        return gap(a, b) <= _ROW_MERGE * max(lines[a].height, lines[b].height)

    def numbers_without_symbol(j: int) -> bool:
        return lines[j].data and lines[j].symbol is None and lines[j].has_values

    def closest(i: int, options: list[int]) -> Optional[int]:
        if len(options) < 2:
            return options[0] if options else None
        a, b = options
        if gap(i, a) * _CLEARLY_CLOSER <= gap(i, b):
            return a
        if gap(i, b) * _CLEARLY_CLOSER <= gap(i, a):
            return b
        return None

    for i in range(n):
        if used[i] or not lines[i].data or lines[i].symbol is None or lines[i].has_values:
            continue
        options = [j for j in (i - 1, i + 1) if 0 <= j < n and not used[j] and numbers_without_symbol(j) and near(i, j)]
        j = closest(i, options)
        if j is not None:
            used[i] = used[j] = True
            groups.append(sorted((i, j)))

    groups += [[i] for i in range(n) if not used[i] and lines[i].data and lines[i].symbol is not None]
    for group in groups:
        for i in group:
            used[i] = True
    for group in groups:
        last, j = group[-1], group[-1] + 1
        if j < n and not used[j] and numbers_without_symbol(j) and near(last, j) \
                and any(t.num.unit for t in lines[j].numbers):
            if not (j + 1 < n and lines[j + 1].symbol is not None and near(j, j + 1)
                    and gap(j, j + 1) * _CLEARLY_CLOSER <= gap(last, j)):
                used[j] = True
                group.append(j)
    for group in groups:
        last, j = group[-1], group[-1] + 1
        if j < n and not used[j] and _name_line(lines[j]) and near(last, j):
            if not (j + 1 < n and not used[j + 1] and near(j, j + 1) and gap(j, j + 1) * _CLEARLY_CLOSER <= gap(last, j)):
                used[j] = True
                group.append(j)
    groups += [[i] for i in range(n) if not used[i]]
    return [[lines[i] for i in group] for group in sorted(groups, key=lambda g: g[0])]


@dataclass
class _Proposal:
    lines: list[_Line]
    header: Optional[_Header]
    symbol: Optional[_Token]
    kind: str  # strong | weak | soft | name
    name: Optional[str]
    name_tokens: list[_Token]
    several_symbols: bool

    @property
    def tokens(self) -> list[_Token]:
        return [token for line in self.lines for token in line.tokens]

    @property
    def numbers(self) -> list[_Token]:
        return [token for token in self.tokens if token.num is not None][:_MAX_ROW_NUMBERS]

    @property
    def symbol_only(self) -> bool:
        return not any(not t.num.percent for t in self.numbers)


def _usable(token: _Token) -> bool:
    num = token.num
    return num is not None and num.value > 0 and not num.percent and not num.signed


def _header_for(lines: list[_Line], headers: list[_Header]) -> Optional[_Header]:
    above = [header for header in headers if header.yc < lines[0].yc]
    return max(above, key=lambda header: header.yc) if above else None


def _group_name(lines: list[_Line], symbol: Optional[_Token]) -> tuple[Optional[str], list[_Token]]:
    for line in lines:
        for token in line.tokens:
            if token.phrase and _name_text_ok(token.text):
                if symbol is not None and symbol.weak and symbol in line.tokens:
                    return f"{symbol.text} {token.text}", [symbol, token]
                return token.text, [token]
    for line in lines[1:]:
        if _name_line(line):
            return line.text, list(line.tokens)
    return None, []


def _soft_symbol_ok(symbol: _Token, line: _Line, numbers: list[_Token], header: Optional[_Header]) -> bool:
    positioned = line.tokens[0] is symbol or (header is not None and header.family_for(symbol) == "symbol")
    usable = [t for t in numbers if _usable(t)]
    plain = any(not t.num.monetary for t in usable)
    money = any(t.num.monetary or (header is not None and header.family_for(t) in ("price", "value")) for t in usable)
    return positioned and ((plain and money) or any(t.num.unit for t in numbers))


def _classify_group(lines: list[_Line], header: Optional[_Header]) -> Optional[_Proposal]:
    if any(not line.data for line in lines):
        return None
    ranked = sorted((line for line in lines if line.symbol is not None),
                    key=lambda line: ("strong", "weak", "soft").index(line.symbol_kind))
    symbol_line = ranked[0] if ranked else None
    symbol = symbol_line.symbol if symbol_line else None
    kind = symbol_line.symbol_kind if symbol_line else "name"
    numbers = [token for line in lines for token in line.numbers]
    if numbers and all(token.num.percent for token in numbers):
        return None
    if kind == "soft" and not _soft_symbol_ok(symbol, symbol_line, numbers, header):
        symbol, kind = None, "name"
    name, name_tokens = _group_name(lines, symbol)
    strong = frozenset().union(*(line.strong_symbols for line in lines))
    if symbol is not None:
        return _Proposal(lines, header, symbol, kind, name, name_tokens, len(strong) > 1)
    evidence = any(_usable(t) and (t.num.monetary or (header is not None and header.family_for(t) in ("price", "value")))
                   for t in numbers)
    if name and evidence:
        return _Proposal(lines, header, None, "name", name, name_tokens, False)
    return None


def _select_rows(groups: list[list[_Line]], headers: list[_Header]) -> tuple[list[_Proposal], list[_Line]]:
    proposals: list[_Proposal] = []
    pending: list[_Proposal] = []
    ignored: list[_Line] = []
    for lines in groups:
        proposal = _classify_group(lines, _header_for(lines, headers))
        if proposal is None:
            ignored.extend(lines)
        elif proposal.symbol_only:
            pending.append(proposal)
        else:
            proposals.append(proposal)
    anchors = [p.symbol.x0 for p in proposals if p.symbol is not None]
    heights = [p.symbol.height for p in proposals if p.symbol is not None]
    for proposal in pending:
        header = proposal.header
        in_column = header is not None and header.family_for(proposal.symbol) == "symbol"
        aligned = bool(anchors) and abs(proposal.symbol.x0 - statistics.median(anchors)) <= 2 * statistics.median(heights)
        if proposal.kind == "strong" and (in_column or aligned):
            proposals.append(proposal)
        else:
            ignored.extend(proposal.lines)
    proposals.sort(key=lambda p: p.lines[0].yc)
    ignored.sort(key=lambda line: line.yc)
    return proposals, ignored


# -------------------------------------------------------------------------------------- market


# how a listing's latest close compares with the price the row itself shows or implies
_STRONG, _NEAR, _UNKNOWN, _CONFLICT = 0, 1, 2, 3


@dataclass
class _Listing:
    ticker: str
    name: str
    exchange: str
    instrument: str
    exact: bool
    order: int
    currency: str = ""
    currency_iso: Optional[str] = None
    scale: float = 1.0
    price: Optional[float] = None
    price_date: Optional[str] = None
    evidence: int = _UNKNOWN

    def unit_prices(self) -> list[float]:
        """Latest close in ISO units, plus the provider unit when it differs (e.g. GBp vs GBP)."""
        if self.price is None:
            return []
        prices = [self.price * self.scale]
        if self.scale != 1:
            prices.append(self.price)
        return prices

    def as_candidate(self) -> dict[str, Any]:
        return {"ticker": self.ticker, "name": self.name, "exchange": self.exchange, "currency": self.currency,
                "instrument": self.instrument, "price": self.price, "price_date": self.price_date}


def _positive_number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) and value > 0 else None


class _Lookup:
    """Bounded, cached access to the market for one screenshot."""

    def __init__(self, market: Any) -> None:
        self.market = market
        self.searches: dict[str, list[dict[str, str]]] = {}
        self.assets: dict[str, tuple[str, Optional[dict[str, Any]]]] = {}
        self.used = 0
        self.unavailable = market is None
        self.limited = False

    def search(self, query: str) -> tuple[str, list[dict[str, str]]]:
        key = query.casefold()
        if key in self.searches:
            return "ok", self.searches[key]
        if self.unavailable:
            return "unavailable", []
        if self.used >= _MAX_LOOKUPS:
            self.limited = True
            return "limit", []
        self.used += 1
        try:
            raw = self.market.search(query)
        except MarketUnavailable:
            self.unavailable = True
            return "unavailable", []
        except (UnsupportedAsset, ValueError):
            raw = []
        except (RuntimeError, OSError):
            self.unavailable = True
            return "unavailable", []
        self.searches[key] = _clean_results(raw)
        return "ok", self.searches[key]

    def asset(self, ticker: str) -> tuple[str, Optional[dict[str, Any]]]:
        if ticker in self.assets:
            return self.assets[ticker]
        if self.unavailable:
            return "unavailable", None
        try:
            data = self.market.asset(ticker)
            outcome = ("ok", data) if isinstance(data, dict) else ("unsupported", None)
        except MarketUnavailable:
            self.unavailable = True
            return "unavailable", None
        except (UnsupportedAsset, ValueError):
            outcome = ("unsupported", None)
        except (RuntimeError, OSError):
            self.unavailable = True
            return "unavailable", None
        self.assets[ticker] = outcome
        return outcome


def _clean_results(raw: Any) -> list[dict[str, str]]:
    results = []
    for item in raw if isinstance(raw, (list, tuple)) else []:
        ticker = item.get("ticker") if isinstance(item, dict) else None
        if isinstance(ticker, str) and ticker.strip():
            results.append({"ticker": ticker.strip().upper(), "name": str(item.get("name") or ticker),
                            "exchange": str(item.get("exchange") or ""), "instrument": str(item.get("instrument") or "")})
    return results


def _listing_suffix(ticker: str) -> str:
    head, dot, tail = ticker.rpartition(".")
    return tail if dot and head and tail in _EXCHANGE_SUFFIXES else ""


def _symbol_variants(symbol: str) -> set[str]:
    return {symbol, symbol.replace(".", "-"), symbol.replace("-", ".")}


def _matching_listings(symbol: str, results: list[dict[str, str]]) -> list[_Listing]:
    variants = _symbol_variants(symbol)
    listings = []
    for order, item in enumerate(results):
        ticker = item["ticker"]
        exact = ticker in variants
        if exact or any(ticker.startswith(v + ".") and ticker[len(v) + 1:] in _EXCHANGE_SUFFIXES for v in variants):
            listings.append(_Listing(ticker, item["name"], item["exchange"], item["instrument"], exact, order))
    return listings


def _hint_rank(listing: _Listing, hint: Optional[str]) -> tuple[int, int]:
    suffixes = _HINT_SUFFIXES.get(hint or "", ((), None))[0]
    suffix = _listing_suffix(listing.ticker)
    if suffix in suffixes:
        return 0, suffixes.index(suffix)
    return 1, 0


def _rank(listings: list[_Listing], symbol: Optional[str], hint: Optional[str]) -> list[_Listing]:
    explicit = bool(symbol and _listing_suffix(symbol))

    def key(listing: _Listing) -> tuple:
        agree, position = _hint_rank(listing, hint)
        return (0 if explicit and listing.exact else 1, listing.evidence, agree, 0 if listing.exact else 1,
                position, listing.order)

    return sorted(listings, key=key)


def _to_price(listings: list[_Listing]) -> list[_Listing]:
    """The top-ranked listings, always including the exact ticker so the row's own price can confirm it."""
    chosen = listings[:_PRICED_CANDIDATES]
    exact = next((listing for listing in listings if listing.exact), None)
    if exact is not None and all(listing is not exact for listing in chosen):
        chosen = chosen[:_PRICED_CANDIDATES - 1] + [exact]
    return chosen


def _price_listings(listings: list[_Listing], lookup: _Lookup) -> tuple[list[_Listing], bool, bool]:
    """Fetch latest prices for the top candidates; drop listings the market cannot price.

    Returns (listings kept, whether every listing was dropped, whether the market failed for any of them).
    """
    to_price = {id(listing) for listing in _to_price(listings)}
    kept, dropped, failed = [], False, False
    for listing in listings:
        if id(listing) not in to_price:
            kept.append(listing)
            continue
        status, data = lookup.asset(listing.ticker)
        if status == "unsupported":
            dropped = True
            continue
        failed = failed or status == "unavailable"
        if status == "ok" and data:
            listing.name = str(data.get("name") or listing.name)
            listing.exchange = str(data.get("exchange") or listing.exchange)
            listing.instrument = listing.instrument or str(data.get("instrument") or "")
            listing.currency = str(data.get("currency") or "")
            iso = data.get("currency_iso")
            listing.currency_iso = iso if isinstance(iso, str) and iso else None
            listing.scale = _positive_number(data.get("currency_scale")) or 1.0
            listing.price = _positive_number(data.get("price"))
            date = data.get("price_date")
            listing.price_date = str(date) if date and listing.price is not None else None
        kept.append(listing)
    return kept, dropped and not kept, failed


def _near(value: float, reference: float, tolerance: float) -> bool:
    return reference > 0 and abs(value - reference) / reference <= tolerance


def _relative_gap(value: float, references: Iterable[float]) -> Optional[float]:
    gaps = [abs(value - ref) / ref for ref in references if ref > 0]
    return min(gaps) if gaps else None


@dataclass(frozen=True)
class _Clue:
    """A unit price the row shows or implies, in ISO units, with the currency markers shown on its numbers."""
    amount: float
    markers: frozenset[str]


def _clue(amount: float, sources: Iterable[_Token]) -> _Clue:
    return _Clue(amount, frozenset(marker for marker in (_marker(token.num) for token in sources) if marker))


def _clue_gap(clue: _Clue, listing: _Listing) -> Optional[float]:
    """Relative gap to the listing's latest close; infinite when the currency shown rules the listing out."""
    if listing.price is None or (clue.markers and listing.currency_iso is None):
        return None
    if not all(_compatible(marker, listing.currency_iso) for marker in clue.markers):
        return math.inf
    # with no currency shown, a price may be in the provider's unit (GBp) or in ISO units (GBP)
    return _relative_gap(clue.amount, [listing.price * listing.scale] if clue.markers else listing.unit_prices())


def _apply_evidence(listings: list[_Listing], clue: Optional[_Clue]) -> None:
    for listing in listings:
        gap = _clue_gap(clue, listing) if clue is not None else None
        if gap is None:
            listing.evidence = _UNKNOWN
        elif gap <= _STRONG_MATCH:
            listing.evidence = _STRONG
        else:
            listing.evidence = _NEAR if gap <= _MARKET_TOLERANCE else _CONFLICT


def _select_listing(listings: list[_Listing], symbol: str, hint: Optional[str]) -> Optional[_Listing]:
    if len(listings) == 1:
        return listings[0]
    if _listing_suffix(symbol):
        exact = [listing for listing in listings if listing.exact]
        if len(exact) == 1 and exact[0].evidence != _CONFLICT:
            return exact[0]
    strong = [listing for listing in listings if listing.evidence == _STRONG]
    if strong:
        # the row's own price and currency outweigh the image-wide hint, but not a venue named on the row
        venue_agrees = hint not in _VENUES or _hint_rank(strong[0], hint)[0] == 0
        return strong[0] if len(strong) == 1 and venue_agrees else None
    primary = _HINT_SUFFIXES.get(hint or "", ((), None))[1]
    if primary is None:
        return None
    first = listings[0]
    on_primary = [listing for listing in listings if _listing_suffix(listing.ticker) == primary]
    if len(on_primary) != 1 or on_primary[0] is not first:
        return None
    if first.exact and first.evidence != _CONFLICT:  # e.g. RY with a USD hint
        return first
    return first if first.evidence == _NEAR else None  # a different venue also needs the price shown to agree


def _row_hint(tokens: list[_Token], global_hint: Optional[str]) -> Optional[str]:
    venues = {_VENUE_HINTS[t.text.strip("()").upper()] for t in tokens
              if t.num is None and not t.phrase and t.text.strip("()").upper() in _VENUE_HINTS}
    if venues:
        return venues.pop() if len(venues) == 1 else None
    markers = set(_markers(tokens, phrases=False))
    if not markers:
        return global_hint
    if markers == {"$"}:  # a bare '$' supports a dollar hint for the whole image and contradicts any other
        return global_hint if global_hint in _DOLLAR_CURRENCIES else None
    return markers.pop() if len(markers) == 1 else None


# ----------------------------------------------------------------------------------------- rows


def _key(token: _Token) -> float:
    return round(token.num.value, 9)


@dataclass
class _Pick:
    quantity: Optional[float] = None
    source: str = "none"
    used: list[_Token] = field(default_factory=list)
    price: Optional[_Token] = None
    value: Optional[_Token] = None
    stop: bool = False


def _apply_column_currency(num: _Num, currency: str) -> None:
    """Amounts under a label such as 'Value (USD)' are in that currency unless the cell says otherwise."""
    if num.percent:
        return
    code = None if currency == "$" else currency
    if not num.monetary:
        num.monetary, num.currency = True, code
    elif num.currency is None and code in _DOLLAR_CURRENCIES:
        num.currency = code


class _RowNumbers:
    """The numbers of one row with their header-column mapping.

    ``constant`` holds the ids of numbers whose column shows that same number on every other row (an FX
    rate of 1.0000, say); such a number is never taken as an unlabelled share count.
    """

    def __init__(self, numbers: list[_Token], header: Optional[_Header], constant: frozenset[int] = frozenset()) -> None:
        self.numbers = numbers
        self.header = header
        self.constant = constant
        self.columns: dict[int, Optional[str]] = {}
        for token in numbers:
            column = header.column_for(token) if header is not None else None
            self.columns[id(token)] = column.family if column is not None else None
            if column is not None and column.currency and column.family in ("price", "value"):
                _apply_column_currency(token.num, column.currency)

    @property
    def shares_column(self) -> bool:
        return self.header is not None and self.header.has("shares")

    def column(self, token: _Token) -> Optional[str]:
        return self.columns.get(id(token))

    def free(self, token: _Token) -> bool:
        """An unlabelled number that does not repeat down its column on every row."""
        return self.column(token) is None and id(token) not in self.constant

    def mapped(self, family: str) -> list[_Token]:
        return [t for t in self.numbers if self.column(t) == family and _usable(t)]

    def money(self) -> list[_Token]:
        return [t for t in self.numbers if _usable(t) and self.column(t) in (None, "price", "value")
                and (t.num.monetary or self.column(t) in ("price", "value"))]

    def value_pool(self) -> list[_Token]:
        """Price/value candidates; all unlabelled numbers when the row shows no currency at all."""
        return self.money() or [t for t in self.numbers if _usable(t) and self.free(t)]

    def price_pool(self) -> list[_Token]:
        return [t for t in self.numbers if _usable(t) and self.column(t) in (None, "price")]

    def quantity_pools(self) -> tuple[list[_Token], list[_Token]]:
        """Possible share counts: only the labelled column when the header has one, else unlabelled numbers."""
        if self.shares_column:
            return [t for t in self.numbers if _usable(t) and self.column(t) == "shares" and not t.num.monetary], []
        plain = [t for t in self.numbers if _usable(t) and self.free(t) and not t.num.monetary]
        money = [t for t in self.numbers if _usable(t) and self.free(t) and t.num.monetary]
        return plain, money

    def triples(self, quantities: list[_Token]) -> list[tuple[float, _Token, _Token, _Token]]:
        found = []
        values = [t for t in self.value_pool() if self.column(t) != "price"]
        for q in quantities:
            for p in self.price_pool():
                if p is q:
                    continue
                for v in values:
                    if v is q or v is p or not _same_currency(p, v):
                        continue
                    if _key(q) == 1 and self.column(v) != "value":
                        continue  # 1 × price = price: the "value" may just be the price again
                    gap = abs(q.num.value * _amount(p) - _amount(v)) / _amount(v)
                    if gap <= _INTERNAL_TOLERANCE:
                        found.append((gap, q, p, v))
        return found


def _unique(tokens: list[_Token]) -> Optional[_Token]:
    return tokens[0] if len({_key(t) for t in tokens}) == 1 else None


def _labelled_quantity(rn: _RowNumbers, issues: list[str]) -> Optional[_Pick]:
    labelled = [t for t in rn.numbers if t.num.unit or rn.column(t) == "shares"]
    good = [t for t in labelled if t.num.value > 0 and not (t.num.percent or t.num.signed or t.num.monetary)]
    if not good:
        if any((t.num.negative or t.num.value <= 0) and not (t.num.percent or t.num.monetary) for t in labelled):
            issues.append(ISSUE_NEGATIVE)
            return _Pick(stop=True)
        return None
    if len({_key(t) for t in good}) > 1:
        issues.append(ISSUE_SEVERAL_QUANTITIES)
        return _Pick(stop=True)
    return _Pick(good[0].num.value, "column", [good[0]])


def _latest_refs(token: _Token, listing: Optional[_Listing]) -> list[float]:
    """The listing's latest close in units comparable with an amount shown on the row; [] when not comparable."""
    if listing is None or listing.price is None:
        return []
    marker = _marker(token.num)
    if marker is None:
        return listing.unit_prices()  # a price with no currency may be in pence (GBp) or in pounds
    if not _compatible(marker, listing.currency_iso):
        return []
    return [listing.price * listing.scale]


def _triple_quantity(rn: _RowNumbers, listing: Optional[_Listing], issues: list[str]) -> Optional[_Pick]:
    plain, money = rn.quantity_pools()
    for pool in (plain, money):
        found = rn.triples(pool)
        if not found:
            continue
        if len({_key(f[1]) for f in found}) > 1 and listing is not None:
            near = []
            for f in found:
                gap = _relative_gap(_amount(f[2]), _latest_refs(f[2], listing))
                if gap is not None and gap <= _MARKET_TOLERANCE:
                    near.append(f)
            found = near or found
        if len({_key(f[1]) for f in found}) > 1:
            issues.append(ISSUE_SEVERAL_QUANTITIES)
            return _Pick(stop=True)
        best = min(found, key=lambda f: f[0])
        price = best[2] if len({_key(f[2]) for f in found}) == 1 else None
        value = best[3] if len({_key(f[3]) for f in found}) == 1 else None
        return _Pick(best[1].num.value, "value_check", [best[1]], price, value)
    return None


def _market_quantity(rn: _RowNumbers, listing: Optional[_Listing], issues: list[str]) -> Optional[_Pick]:
    if listing is None or listing.price is None:
        return None
    values = [t for t in rn.value_pool() if rn.column(t) != "price"]
    for pool in rn.quantity_pools():
        hits: dict[float, list[tuple[float, _Token, _Token]]] = {}
        for q in pool:
            best = None
            for m in values:
                if m is q or (_key(q) == 1 and rn.column(m) != "value"):
                    continue  # 1 × latest close ≈ a price shown proves nothing about the share count
                gap = _relative_gap(_amount(m), [q.num.value * p for p in _latest_refs(m, listing)])
                if gap is not None and gap <= _MARKET_TOLERANCE and (best is None or gap < best[0]):
                    best = (gap, q, m)
            if best:
                hits.setdefault(_key(q), []).append(best)
        if len(hits) > 1:
            issues.append(ISSUE_SEVERAL_QUANTITIES)
            return _Pick(stop=True)
        if hits:
            _, q, m = min(next(iter(hits.values())), key=lambda h: h[0])
            return _Pick(q.num.value, "value_check", [q], None, m)
    return None


def _single_quantity(rn: _RowNumbers, price_refs: list[float], issues: list[str]) -> Optional[_Pick]:
    singles = [t for t in rn.numbers if _usable(t) and not t.num.monetary and rn.free(t)]
    if len(singles) != 1:
        return None
    single = singles[0]
    gap = _relative_gap(single.num.value, price_refs)
    if gap is not None and gap <= _MARKET_TOLERANCE:
        issues.append(ISSUE_LOOKS_LIKE_PRICE)
        return _Pick(stop=True)
    issues.append(ISSUE_SINGLE_NUMBER)
    return _Pick(single.num.value, "single_number", [single])


def _derived_quantity(rn: _RowNumbers, listing: Optional[_Listing], issues: list[str]) -> Optional[_Pick]:
    value = _unique(rn.mapped("value"))
    if value is None:
        return None
    shown = _unique(rn.mapped("price"))
    if shown is not None:
        if not _same_currency(shown, value):
            issues.append(ISSUE_MIXED_CURRENCIES)
            return None
        issues.append(ISSUE_DERIVED_SHOWN)
        return _Pick(round(_amount(value) / _amount(shown), 6), "derived_from_value", [value, shown], shown, value)
    if listing is None or listing.price is None:
        return None
    if not _latest_refs(value, listing):
        issues.append(f"The market value is shown in {_currency_label(_marker(value.num))} but {listing.ticker} trades "
                      f"in {listing.currency_iso or 'an unknown currency'}; the quantity was not estimated")
        return None
    issues.append(ISSUE_DERIVED_LATEST)
    return _Pick(round(_amount(value) / (listing.price * listing.scale), 6), "derived_from_value", [value], None, value)


def _choose_quantity(rn: _RowNumbers, listing: Optional[_Listing], price_refs: list[float], issues: list[str]) -> _Pick:
    """``listing`` supplies the trusted latest close; ``price_refs`` every candidate's (price-lookalike guard).

    When the header labels a quantity column, only that column can supply the quantity.
    """
    if rn.shares_column:
        pick = _labelled_quantity(rn, issues)
        if pick is None:
            issues.append(ISSUE_NO_SHARES_CELL)
            pick = _Pick(stop=True)
    else:
        for step in (lambda: _labelled_quantity(rn, issues), lambda: _triple_quantity(rn, listing, issues),
                     lambda: _market_quantity(rn, listing, issues), lambda: _single_quantity(rn, price_refs, issues),
                     lambda: _derived_quantity(rn, listing, issues)):
            pick = step()
            if pick is not None:
                break
        else:
            pick = _Pick(stop=True)
    if pick.quantity is not None and not 0 < pick.quantity <= _MAX_QUANTITY:
        issues.append(ISSUE_RANGE)
        return _Pick(stop=True)
    if pick.quantity is None:
        issues.append(ISSUE_ENTER_QUANTITY)
        return _Pick()
    return pick


def _fill_price_value(rn: _RowNumbers, pick: _Pick, listing: Optional[_Listing]) -> tuple[Optional[_Token], Optional[_Token]]:
    price, value = _unique(rn.mapped("price")), _unique(rn.mapped("value"))
    price = price or pick.price
    value = value or pick.value
    q = pick.quantity
    if q is None or (price is not None and value is not None) or round(q, 9) == 1:
        return price, value  # with one share an unlabelled price and value cannot be told apart
    exclude = {id(t) for t in pick.used}
    candidates_v = [t for t in rn.value_pool() if id(t) not in exclude and rn.column(t) != "price"]
    candidates_p = [t for t in rn.price_pool() if id(t) not in exclude]
    if price is None and value is None:
        pairs = [(p, v) for p in candidates_p for v in candidates_v if p is not v and _same_currency(p, v)
                 and abs(q * _amount(p) - _amount(v)) / _amount(v) <= _INTERNAL_TOLERANCE]
        if len({(_key(p), _key(v)) for p, v in pairs}) == 1:
            return pairs[0]
    if value is None and listing is not None:
        scored = []
        for token in candidates_v:
            gap = _relative_gap(_amount(token), [q * p for p in _latest_refs(token, listing)])
            if gap is not None:
                scored.append((gap, token))
        scored.sort(key=lambda item: item[0])
        if scored and scored[0][0] <= _MARKET_TOLERANCE \
                and (len(scored) == 1 or scored[1][0] > max(2 * scored[0][0], _MARKET_TOLERANCE)):
            value = scored[0][1]
    if price is None and value is not None:
        matches = [t for t in candidates_p if t is not value and _same_currency(t, value)
                   and abs(q * _amount(t) - _amount(value)) / _amount(value) <= _INTERNAL_TOLERANCE]
        price = _unique(matches)
    return price, value


def _money_text(amount: float) -> str:
    return f"{amount:,.2f}"


def _check(q: Optional[float], source: str, price: Optional[_Token], value: Optional[_Token],
           listing: Optional[_Listing], issues: list[str]) -> dict[str, str]:
    """Reconcile the quantity with the price and value read from the row, else with ``listing``'s latest close."""
    if q is None:
        return {"status": "unverified", "detail": "No quantity to verify."}
    if source == "derived_from_value":
        return {"status": "unverified", "detail": "The quantity was derived from the market value, so it cannot be cross-checked."}
    if price is not None and value is not None:
        if not _same_currency(price, value):
            return {"status": "unverified", "detail": f"The price ({_currency_label(_marker(price.num))}) and the market "
                                                      f"value ({_currency_label(_marker(value.num))}) are shown in "
                                                      "different currencies, so they were not reconciled."}
        shown_price, shown_value = _amount(price), _amount(value)
        gap = abs(q * shown_price - shown_value) / shown_value
        if gap <= _INTERNAL_TOLERANCE:
            return {"status": "consistent", "detail": "Quantity × price shown reconciles with the market value shown (within 1.5%)."}
        issues.append(ISSUE_NOT_RECONCILED)
        return {"status": "inconsistent", "detail": f"Quantity × price shown is {_money_text(q * shown_price)}, which differs "
                                                    f"from the market value shown ({_money_text(shown_value)}) by {gap:.1%}."}
    if value is not None and listing is not None and listing.price is not None:
        name = listing.ticker
        refs = _latest_refs(value, listing)
        if not refs and listing.currency_iso is None:
            return {"status": "unverified", "detail": f"The trading currency of {name} is unknown, so the market value "
                                                      "shown was not compared with its latest close."}
        if not refs:
            return {"status": "unverified", "detail": f"The market value is shown in a different currency "
                                                      f"({_currency_label(_marker(value.num))}) from {name}'s trading "
                                                      f"currency ({listing.currency_iso}), so they were not compared."}
        gap = _relative_gap(_amount(value), [q * p for p in refs])
        if gap <= _MARKET_TOLERANCE:
            return {"status": "consistent", "detail": f"Quantity × latest close of {name} is within {gap:.0%} of the market "
                                                      "value shown; prices may have moved since the screenshot."}
        return {"status": "inconsistent", "detail": f"Quantity × latest close of {name} differs from the market value shown "
                                                    f"by {gap:.0%} — check the quantity, listing or currency."}
    if value is None:
        return {"status": "unverified", "detail": "No market value was read to cross-check the quantity."}
    return {"status": "unverified", "detail": "No latest price is available to cross-check the quantity."}


def _name_words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z]{3,}", text.lower()) if w not in _GENERIC_NAME_WORDS}


def _names_agree(shown: str, listed: str) -> bool:
    """Whether a displayed name plausibly names the listing; spacing variants ("Exxon Mobil" / "ExxonMobil") agree."""
    shown_words, listed_words = _name_words(shown), _name_words(listed)
    if not shown_words or not listed_words or shown_words & listed_words:
        return True
    shown_compact, listed_compact = re.sub(r"[^a-z]", "", shown.lower()), re.sub(r"[^a-z]", "", listed.lower())
    return (any(len(word) >= 5 and word in listed_compact for word in shown_words)
            or any(len(word) >= 5 and word in shown_compact for word in listed_words))


@dataclass
class _Resolution:
    listings: list[_Listing] = field(default_factory=list)
    selected: Optional[_Listing] = None
    latest_listing: Optional[_Listing] = None


def _latest_listing(resolution: _Resolution) -> Optional[_Listing]:
    if resolution.selected is not None:
        return resolution.selected if resolution.selected.price is not None else None
    priced = [listing for listing in resolution.listings if listing.price is not None]
    if not priced:
        return None
    reference = priced[0].price * priced[0].scale
    if all(_near(listing.price * listing.scale, reference, _LISTING_AGREEMENT) for listing in priced):
        return priced[0]
    return None


class _Resolver:
    def __init__(self, lookup: _Lookup) -> None:
        self.lookup = lookup

    def resolve(self, query: str, symbol: Optional[str], hint: Optional[str], clue: Optional[_Clue],
                issues: list[str]) -> _Resolution:
        status, results = self.lookup.search(query[:80])
        if status == "unavailable":
            issues.append(ISSUE_MARKET_DOWN)
            return _Resolution()
        if status == "limit":
            issues.append(ISSUE_LOOKUP_LIMIT)
            return _Resolution()
        if symbol is not None:
            listings = _matching_listings(symbol, results)
        else:
            listings = [_Listing(r["ticker"], r["name"], r["exchange"], r["instrument"], False, i)
                        for i, r in enumerate(results)]
        if not listings:
            return _Resolution()
        listings = _rank(listings, symbol, hint)[:_MAX_CANDIDATES]
        listings, all_dropped, failed = _price_listings(listings, self.lookup)
        if failed and ISSUE_MARKET_DOWN not in issues:
            issues.append(ISSUE_MARKET_DOWN)
        if all_dropped:
            issues.append(ISSUE_UNSUPPORTED)
            return _Resolution()
        _apply_evidence(listings, clue)
        listings = _rank(listings, symbol, hint)
        if symbol is not None:
            selected = _select_listing(listings, symbol, hint)
        else:
            selected = listings[0] if len(listings) == 1 and listings[0].evidence != _CONFLICT else None
        resolution = _Resolution(listings, selected)
        resolution.latest_listing = _latest_listing(resolution)
        return resolution


def _price_clue(rn: _RowNumbers) -> Optional[_Clue]:
    """The unit price the row itself shows or implies; used only to rank, select and check listings.

    Sources, in order: the price column; an unambiguous quantity × price = value triple; the market value
    ÷ a labelled share count ("4 shares … $660.00"). Lone unlabelled numbers are never used.
    """
    price = _unique(rn.mapped("price"))
    if price is not None:
        return _clue(_amount(price), [price])
    plain, money = rn.quantity_pools()
    for pool in (plain, money):
        found = rn.triples(pool)
        if found and len({_key(f[1]) for f in found}) == 1 and len({_key(f[2]) for f in found}) == 1:
            return _clue(_amount(found[0][2]), [found[0][2], found[0][3]])
        if found:
            return None
    quantity = _unique([t for t in rn.numbers if _usable(t) and not t.num.monetary
                        and (t.num.unit or rn.column(t) == "shares")])
    if rn.header is not None and rn.header.has("value"):
        value = _unique(rn.mapped("value"))
    else:
        value = _unique([t for t in rn.money() if rn.column(t) is None])
    if quantity is None or value is None or value is quantity:
        return None
    return _clue(_amount(value) / quantity.num.value, [value])


def _resolve_dollars(tokens: list[_Token]) -> None:
    """Read a bare '$' as the dollar currency named in its own column on the row (e.g. 'Currency: CAD')."""
    named = {code for token in tokens if token.num is None and not token.phrase
             for code in _currency_codes_in(token.text)}
    dollar = _named_dollar(named)
    if dollar is None or len(named) != 1:
        return
    for token in tokens:
        if token.num is not None and token.num.monetary and token.num.currency is None:
            token.num.currency = dollar


def _confidence(tokens: Iterable[Optional[_Token]], factor: float) -> float:
    scores = [token.score for token in tokens if token is not None]
    return round(min(scores) * factor, 3) if scores else 0.0


def _box(tokens: list[_Token]) -> dict[str, int]:
    x0 = math.floor(min(t.x0 for t in tokens))
    y0 = math.floor(min(t.y0 for t in tokens))
    x1 = math.ceil(max(t.x1 for t in tokens))
    y1 = math.ceil(max(t.y1 for t in tokens))
    return {"x": int(x0), "y": int(y0), "width": max(1, int(x1 - x0)), "height": max(1, int(y1 - y0))}


def _lookup_blocked(issues: list[str]) -> bool:
    return any(issue in issues for issue in (ISSUE_MARKET_DOWN, ISSUE_LOOKUP_LIMIT, ISSUE_UNSUPPORTED))


def _build_row(index: int, proposal: _Proposal, resolver: _Resolver, global_hint: Optional[str],
               constant: frozenset[int] = frozenset()) -> dict[str, Any]:
    issues: list[str] = []
    _resolve_dollars(proposal.tokens)
    rn = _RowNumbers(proposal.numbers, proposal.header, constant)
    hint = _row_hint(proposal.tokens, global_hint)
    clue = _price_clue(rn)
    symbol = proposal.symbol.text if proposal.symbol is not None else None
    if proposal.kind == "soft":
        issues.append(f"“{symbol}” is also a common label — confirm it is the ticker")
    if proposal.several_symbols:
        issues.append(ISSUE_SEVERAL_SYMBOLS)
    by_name = symbol is None
    resolution = resolver.resolve(symbol or proposal.name or "", symbol, hint, clue, issues)
    if not resolution.listings and not _lookup_blocked(issues):
        if proposal.kind == "weak" and proposal.name:
            resolution = resolver.resolve(proposal.name, None, hint, clue, issues)
            by_name = bool(resolution.listings)
        if not resolution.listings and not _lookup_blocked(issues):
            issues.append(ISSUE_NOT_FOUND)
    if symbol is not None and not by_name and not any(listing.exact for listing in resolution.listings) \
            and _CONFUSABLE.search(symbol) and not _lookup_blocked(issues):
        issues.append(ISSUE_CONFUSABLE)
    if by_name and resolution.listings:
        issues.append(ISSUE_NAME_MATCH)
    if len(resolution.listings) > 1 and resolution.selected is None:
        issues.append(ISSUE_SEVERAL_NAMES if by_name else ISSUE_SEVERAL)

    latest_listing = resolution.latest_listing
    latest = latest_listing.unit_prices() if latest_listing else []
    price_refs = latest + [p for listing in resolution.listings for p in listing.unit_prices()]
    pick = _choose_quantity(rn, latest_listing, price_refs, issues)
    price_token, value_token = _fill_price_value(rn, pick, latest_listing)
    price = price_token.num.value if price_token is not None else None
    value = value_token.num.value if value_token is not None else None
    check = _check(pick.quantity, pick.source, price_token, value_token, latest_listing, issues)

    selected = resolution.selected
    if selected is not None and price_token is not None and selected.price is not None:
        gap = _clue_gap(_clue(_amount(price_token), [price_token]), selected)
        if gap == math.inf:
            issues.append(f"{selected.ticker} trades in {selected.currency_iso or 'an unknown currency'}, but the price "
                          "is shown in another currency — confirm the listing and currency")
        elif gap is not None and gap > _MARKET_TOLERANCE:
            issues.append(f"The price shown differs from the latest close of {selected.ticker} by {gap:.0%} — "
                          "confirm the listing and currency")
    if selected is not None and proposal.name and not by_name and not _names_agree(proposal.name, selected.name):
        issues.append(f"The name shown does not match {selected.ticker} ({selected.name}) — confirm the security")

    identity = proposal.name_tokens if by_name else [proposal.symbol]
    used = [*identity, *pick.used, price_token, value_token]
    if check["status"] != "consistent" and any(t is not None and t.num is not None and t.num.uncertain for t in used):
        issues.append(ISSUE_AMBIGUOUS_FORMAT)
    if _confidence(used, 1.0) < _LOW_CONFIDENCE:
        issues.append(ISSUE_LOW_OCR)
    return {
        "id": f"row-{index}",
        "line_text": " / ".join(line.text for line in proposal.lines),
        "box": _box(proposal.tokens),
        "detected_symbol": symbol,
        "detected_name": proposal.name,
        "candidates": [listing.as_candidate() for listing in resolution.listings],
        "selected_ticker": selected.ticker if selected is not None else None,
        "quantity": pick.quantity,
        "quantity_source": pick.source if pick.quantity is not None else "none",
        "screenshot_price": price,
        "screenshot_value": value,
        "check": check,
        "confidence": _confidence(used, _NAME_CONFIDENCE if by_name else 1.0),
        "issues": list(dict.fromkeys(issues)),
    }


def _overlaps(a: _Token, b: _Token) -> bool:
    return min(a.x1, b.x1) - max(a.x0, b.x0) > 0.5 * min(a.x1 - a.x0, b.x1 - b.x0)


def _constant_cells(proposals: list[_Proposal]) -> frozenset[int]:
    """Ids of numbers that every other row repeats in the same column (an FX rate of 1.0000, say)."""
    cells = sorted(((row, token) for row, proposal in enumerate(proposals) for token in proposal.numbers
                    if _usable(token)), key=lambda cell: cell[1].x0)
    neighbours: dict[int, list[_Token]] = {id(token): [] for _, token in cells}
    for i, (row, token) in enumerate(cells):
        for other_row, other in cells[i + 1:]:
            if other.x0 >= token.x1:
                break
            if other_row != row and _overlaps(token, other):
                neighbours[id(token)].append(other)
                neighbours[id(other)].append(token)
    return frozenset(id(token) for _, token in cells
                     if neighbours[id(token)] and all(_key(other) == _key(token) for other in neighbours[id(token)]))


def _mark_duplicates(rows: list[dict[str, Any]]) -> None:
    keys = [row["selected_ticker"] or row["detected_symbol"] for row in rows]
    for row, key in zip(rows, keys):
        if key is not None and keys.count(key) > 1:
            row["issues"].append(ISSUE_DUPLICATE)


def _timestamp(now: Optional[datetime]) -> str:
    moment = now or datetime.now(timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def analyze_screenshot(data: bytes, market: Any, *, ocr: Optional[OcrFunction] = None,
                       now: Optional[datetime] = None) -> dict[str, Any]:
    """Read a holdings screenshot and return proposed rows (``ScreenshotImport``) for user review.

    ``ocr`` may replace the RapidOCR engine: it receives the RGB array (possibly rescaled) and returns
    ``[(box, text, score), ...]`` with box corners in that array's pixels. Raises ScreenshotError for
    unusable images and OcrUnavailable when the OCR engine or imaging libraries cannot be loaded.
    """
    if Image is None or np is None:
        raise OcrUnavailable("Screenshot import needs the Pillow and numpy packages, which are not installed.")
    image, notes = _load_image(data)
    width, height = image.size
    array, sx, sy = _ocr_array(image)
    raw = (ocr or _rapidocr)(array)
    tokens = [token for index, box in enumerate(_read_boxes(raw, sx, sy, width, height))
              for token in _box_tokens(box, index)]
    _apply_number_locale(tokens)
    lines = _cluster_lines(tokens)
    currency_hint = _currency_hint(line.tokens for line in lines)
    for line in lines:
        _analyse_line(line)
    headers = [line.header for line in lines if line.header is not None]
    proposals, ignored = _select_rows(_group_lines(lines), headers)

    warnings_out = list(notes)
    if not tokens:
        warnings_out.append(WARN_NO_TEXT)
    if len(proposals) > _MAX_ROWS:
        proposals = proposals[:_MAX_ROWS]
        warnings_out.append(WARN_TRUNCATED)
    lookup = _Lookup(market)
    resolver = _Resolver(lookup)
    constant = _constant_cells(proposals)
    rows = [_build_row(i, proposal, resolver, currency_hint, constant) for i, proposal in enumerate(proposals, start=1)]
    _mark_duplicates(rows)
    if not rows:
        warnings_out.append(WARN_NO_ROWS)
    elif not headers:
        warnings_out.append(WARN_NO_HEADER)
    if any(ISSUE_MARKET_DOWN in row["issues"] for row in rows):
        warnings_out.append(WARN_MARKET_DOWN)
    if lookup.limited:
        warnings_out.append(WARN_LOOKUP_LIMIT)
    return {
        "image": {"width": int(width), "height": int(height)},
        "engine": ENGINE,
        "rows": rows,
        "ignored_lines": [{"text": line.text, "box": _box(line.tokens)} for line in ignored[:_MAX_IGNORED]],
        "currency_hint": currency_hint,
        "header_detected": bool(headers),
        "warnings": warnings_out,
        "processed_at": _timestamp(now),
    }
