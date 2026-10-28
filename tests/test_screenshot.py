"""Tests for backend.screenshot.

OCR is injected with hand-built boxes so the parser is tested offline and deterministically; one
optional end-to-end test runs the real local RapidOCR engine on a rendered table.
"""

from __future__ import annotations

import importlib.util
import io
import json
import struct
import sys
import time
import unittest
import zlib
from datetime import datetime, timezone
from unittest import mock

from backend import screenshot
from backend.screenshot import MAX_BYTES, OcrUnavailable, ScreenshotError, analyze_screenshot

try:
    from PIL import Image, ImageDraw, ImageFont, features
except ImportError:  # Pillow is optional for the API; these tests need it
    Image = ImageDraw = ImageFont = features = None

HAVE_RAPIDOCR = importlib.util.find_spec("rapidocr") is not None
NOW = datetime(2025, 6, 14, 15, 30, tzinfo=timezone.utc)
CHAR_WIDTH, BOX_HEIGHT = 14, 24
COLUMNS = (100, 400, 700, 1000)
HEADER = ("Symbol", "Quantity", "Price", "Market value")


class FakeMarketUnavailable(RuntimeError):
    pass


class FakeUnsupportedAsset(ValueError):
    pass


LISTINGS = {
    "AAPL": ("Apple Inc.", "NASDAQ", "USD", 350.0, "EQUITY"),
    "MSFT": ("Microsoft Corporation", "NASDAQ", "USD", 420.0, "EQUITY"),
    "TSLA": ("Tesla, Inc.", "NASDAQ", "USD", 250.0, "EQUITY"),
    "NVDA": ("NVIDIA Corporation", "NASDAQ", "USD", 120.0, "EQUITY"),
    "ALL": ("The Allstate Corporation", "NYSE", "USD", 190.0, "EQUITY"),
    "RY": ("Royal Bank of Canada", "NYSE", "USD", 208.0, "EQUITY"),
    "RY.TO": ("Royal Bank of Canada", "Toronto", "CAD", 285.0, "EQUITY"),
    "BRK-B": ("Berkshire Hathaway Inc.", "NYSE", "USD", 510.0, "EQUITY"),
    "SAP": ("SAP SE", "NYSE", "USD", 230.0, "EQUITY"),
    "SAP.DE": ("SAP SE", "XETRA", "EUR", 212.0, "EQUITY"),
    "ADS.DE": ("adidas AG", "XETRA", "EUR", 200.0, "EQUITY"),
    "SHEL.L": ("Shell plc", "LSE", "GBp", 2650.0, "EQUITY"),
    "VTI": ("Vanguard Total Stock Market Index Fund ETF Shares", "NYSE Arca", "USD", 270.0, "ETF"),
}


class FakeMarket:
    """Implements only the documented Market.search / Market.asset contract."""

    def __init__(self, listings: dict | None = None, down: bool = False) -> None:
        self.listings = dict(LISTINGS if listings is None else listings)
        self.down = down
        self.search_calls: list[str] = []
        self.asset_calls: list[str] = []

    def search(self, query: str) -> list[dict]:
        self.search_calls.append(query)
        if self.down:
            raise FakeMarketUnavailable("offline")
        text = query.strip()
        if not text:
            raise ValueError("empty query")
        upper, by_name = text.upper(), any(ch.islower() for ch in text)
        results = []
        for ticker, (name, exchange, _currency, _price, instrument) in self.listings.items():
            if (ticker == upper or ticker.split(".")[0] == upper.split(".")[0]
                    or ticker.replace("-", ".") == upper.replace("-", ".")
                    or (by_name and text.lower() in name.lower())):
                results.append({"ticker": ticker, "name": name, "exchange": exchange,
                                "instrument": instrument, "sector": None})
        return results

    def asset(self, ticker: str) -> dict:
        self.asset_calls.append(ticker)
        if self.down:
            raise FakeMarketUnavailable("offline")
        if ticker not in self.listings:
            raise FakeUnsupportedAsset(ticker)
        name, exchange, currency, price, instrument = self.listings[ticker]
        return {"ticker": ticker, "name": name, "exchange": exchange, "currency": currency,
                "currency_iso": "GBP" if currency == "GBp" else currency,
                "currency_scale": 0.01 if currency == "GBp" else 1.0, "instrument": instrument,
                "price": price, "price_date": "2025-06-13"}


class FakeOcr:
    def __init__(self, entries: list) -> None:
        self.entries = entries
        self.shapes: list[tuple] = []
        self.corner: tuple | None = None

    def __call__(self, array):
        self.shapes.append(tuple(array.shape))
        self.corner = tuple(int(v) for v in array[0, 0])
        return list(self.entries)


def box(x: float, y: float, text: str, score: float = 0.99) -> tuple:
    width = CHAR_WIDTH * len(text)
    return [[x, y], [x + width, y], [x + width, y + BOX_HEIGHT], [x, y + BOX_HEIGHT]], text, score


def table(*rows, columns=COLUMNS, top: int = 100, pitch: int = 60, score: float = 0.99) -> list:
    entries = []
    for index, row in enumerate(rows):
        y = top + index * pitch
        entries += [box(x, y, text, score) for x, text in zip(columns, row) if text]
    return entries


def image_bytes(width: int, height: int, mode: str = "RGB", color="white", fmt: str = "PNG", **options) -> bytes:
    buffer = io.BytesIO()
    Image.new(mode, (width, height), color).save(buffer, format=fmt, **options)
    return buffer.getvalue()


def png_claiming(width: int, height: int) -> bytes:
    """A PNG whose header claims the given size (no real pixel data)."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"\x00")) + chunk(b"IEND", b"")


@unittest.skipIf(Image is None, "Pillow is not installed")
class ScreenshotTestBase(unittest.TestCase):
    blank: bytes = b""

    @classmethod
    def setUpClass(cls) -> None:
        cls.blank = image_bytes(1600, 1600)  # longest side 1600: OCR coordinates equal image coordinates

    def setUp(self) -> None:
        patcher = mock.patch.multiple(screenshot, MarketUnavailable=FakeMarketUnavailable,
                                      UnsupportedAsset=FakeUnsupportedAsset)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.market = FakeMarket()

    def analyse(self, entries: list, market=None, image: bytes | None = None, use_market: bool = True) -> dict:
        market = (market or self.market) if use_market else None
        return analyze_screenshot(image or self.blank, market, ocr=FakeOcr(entries), now=NOW)

    def row(self, result: dict, symbol: str) -> dict:
        matches = [row for row in result["rows"] if row["detected_symbol"] == symbol]
        self.assertEqual(len(matches), 1, f"expected one row for {symbol}: {result['rows']}")
        return matches[0]


class HeaderTableTests(ScreenshotTestBase):
    def test_standard_header_table(self) -> None:
        result = self.analyse(table(HEADER,
                                    ("AAPL", "10", "$347.10", "$3,471.00"),
                                    ("RY.TO", "3", "$285.46", "$856.38"),
                                    ("BRK.B", "2.5", "$512.20", "$1,280.50")))
        json.dumps(result)
        self.assertEqual(set(result), {"image", "engine", "rows", "ignored_lines", "currency_hint",
                                       "header_detected", "warnings", "processed_at"})
        self.assertEqual(result["image"], {"width": 1600, "height": 1600})
        self.assertEqual(result["engine"], "RapidOCR (local, offline)")
        self.assertTrue(result["header_detected"])
        self.assertEqual(result["warnings"], [])
        self.assertIsNone(result["currency_hint"])
        self.assertEqual(result["processed_at"], "2025-06-14T15:30:00Z")
        self.assertEqual([line["text"] for line in result["ignored_lines"]], ["Symbol Quantity Price Market value"])

        rows = result["rows"]
        self.assertEqual([r["id"] for r in rows], ["row-1", "row-2", "row-3"])
        self.assertEqual([r["detected_symbol"] for r in rows], ["AAPL", "RY.TO", "BRK.B"])
        self.assertEqual([r["selected_ticker"] for r in rows], ["AAPL", "RY.TO", "BRK-B"])
        self.assertEqual([r["quantity"] for r in rows], [10.0, 3.0, 2.5])
        self.assertEqual({r["quantity_source"] for r in rows}, {"column"})
        self.assertEqual([r["screenshot_price"] for r in rows], [347.10, 285.46, 512.20])
        self.assertEqual([r["screenshot_value"] for r in rows], [3471.0, 856.38, 1280.5])
        self.assertEqual({r["check"]["status"] for r in rows}, {"consistent"})
        self.assertEqual([r["issues"] for r in rows], [[], [], []])
        self.assertEqual([r["confidence"] for r in rows], [0.99, 0.99, 0.99])

        aapl = rows[0]
        self.assertEqual(set(aapl), {"id", "line_text", "box", "detected_symbol", "detected_name", "candidates",
                                     "selected_ticker", "quantity", "quantity_source", "screenshot_price",
                                     "screenshot_value", "check", "confidence", "issues"})
        self.assertEqual(aapl["box"], {"x": 100, "y": 160, "width": 1026, "height": 24})
        self.assertEqual(aapl["line_text"], "AAPL 10 $347.10 $3,471.00")
        self.assertEqual(aapl["candidates"], [{"ticker": "AAPL", "name": "Apple Inc.", "exchange": "NASDAQ",
                                               "currency": "USD", "instrument": "EQUITY", "price": 350.0,
                                               "price_date": "2025-06-13"}])
        self.assertIn("reconciles", aapl["check"]["detail"])

    def test_name_spacing_variants_agree_but_other_names_are_flagged(self) -> None:
        market = FakeMarket({**LISTINGS, "XOM": ("ExxonMobil Holdings Corporation", "NYSE", "USD", 179.91, "EQUITY")})
        columns = (100, 300, 700, 900, 1150)
        header = ("Symbol", "Description", "Quantity", "Price", "Market value")
        same = self.row(self.analyse(table(header, ("XOM", "Exxon Mobil Corp", "30", "$179.91", "$5,397.30"), columns=columns),
                                     market=market), "XOM")
        self.assertEqual((same["selected_ticker"], same["quantity"], same["issues"]), ("XOM", 30.0, []))
        other = self.row(self.analyse(table(header, ("XOM", "Chevron Corp", "30", "$179.91", "$5,397.30"), columns=columns),
                                      market=FakeMarket({**LISTINGS, "XOM": market.listings["XOM"]})), "XOM")
        self.assertTrue(any("does not match XOM" in issue for issue in other["issues"]), other["issues"])

    def test_inconsistent_internal_check(self) -> None:
        result = self.analyse(table(HEADER, ("AAPL", "10", "$347.10", "$3,000.00")))
        row = self.row(result, "AAPL")
        self.assertEqual(row["quantity"], 10.0)
        self.assertEqual(row["check"]["status"], "inconsistent")
        self.assertIn(screenshot.ISSUE_NOT_RECONCILED, row["issues"])

    def test_quantity_bounds(self) -> None:
        result = self.analyse(table(HEADER,
                                    ("AAPL", "2,000,000,000", "$1.00", "$2,000,000,000.00"),
                                    ("MSFT", "0", "$415.20", "$0.00")))
        huge, zero = self.row(result, "AAPL"), self.row(result, "MSFT")
        self.assertIsNone(huge["quantity"])
        self.assertEqual(huge["quantity_source"], "none")
        self.assertIn(screenshot.ISSUE_RANGE, huge["issues"])
        self.assertIsNone(zero["quantity"])
        self.assertIn(screenshot.ISSUE_NEGATIVE, zero["issues"])

    def test_derived_from_value_and_price_shown(self) -> None:
        result = self.analyse(table(("Symbol", "Price", "Market value"), ("AAPL", "$347.10", "$3,471.00"),
                                    columns=(100, 700, 1000)))
        row = self.row(result, "AAPL")
        self.assertEqual(row["quantity"], 10.0)
        self.assertEqual(row["quantity_source"], "derived_from_value")
        self.assertIn(screenshot.ISSUE_DERIVED_SHOWN, row["issues"])
        self.assertEqual(row["check"]["status"], "unverified")

    def test_derived_from_value_and_latest_close(self) -> None:
        result = self.analyse(table(("Symbol", "Market value"),
                                    ("AAPL", "$3,500.00"),
                                    ("SHEL.L", "£2,650.00"),
                                    ("MSFT", "C$4,200.00"), columns=(100, 1000)))
        aapl, shell, msft = self.row(result, "AAPL"), self.row(result, "SHEL.L"), self.row(result, "MSFT")
        self.assertEqual((aapl["quantity"], aapl["quantity_source"]), (10.0, "derived_from_value"))
        self.assertIn(screenshot.ISSUE_DERIVED_LATEST, aapl["issues"])
        self.assertEqual(aapl["check"]["status"], "unverified")
        self.assertEqual(shell["quantity"], 100.0)  # 2,650 GBP / (2,650 GBp × 0.01)
        self.assertIsNone(msft["quantity"])  # value in CAD, listing in USD: no estimate
        self.assertIn(screenshot.ISSUE_ENTER_QUANTITY, msft["issues"])
        self.assertTrue(any("shown in CAD" in issue for issue in msft["issues"]))

    def test_european_number_format(self) -> None:
        result = self.analyse(table(HEADER,
                                    ("SAP.DE", "12,5", "210,40 €", "2.630,00 €"),
                                    ("ADS.DE", "1.000", "198,50 €", "198.500,00 €")))
        self.assertEqual(result["currency_hint"], "EUR")
        sap, adidas = self.row(result, "SAP.DE"), self.row(result, "ADS.DE")
        self.assertEqual((sap["quantity"], sap["screenshot_price"], sap["screenshot_value"]), (12.5, 210.4, 2630.0))
        self.assertEqual(sap["selected_ticker"], "SAP.DE")
        self.assertEqual(sap["check"]["status"], "consistent")
        self.assertEqual(adidas["quantity"], 1000.0)
        self.assertNotIn(screenshot.ISSUE_AMBIGUOUS_FORMAT, adidas["issues"])

    def test_ambiguous_number_format_is_flagged(self) -> None:
        result = self.analyse(table(("Symbol", "Quantity", "Price"), ("AAPL", "1,000", "350")))
        row = self.row(result, "AAPL")
        self.assertEqual(row["quantity"], 1000.0)
        self.assertIn(screenshot.ISSUE_AMBIGUOUS_FORMAT, row["issues"])
        self.assertEqual(row["check"]["status"], "unverified")

    def test_listing_choice_follows_currency_hint(self) -> None:
        result = self.analyse(table(HEADER, ("RY", "3", "C$285.46", "C$856.38")))
        self.assertEqual(result["currency_hint"], "CAD")
        row = self.row(result, "RY")
        self.assertEqual([c["ticker"] for c in row["candidates"]], ["RY.TO", "RY"])
        self.assertEqual(row["selected_ticker"], "RY.TO")
        self.assertNotIn(screenshot.ISSUE_SEVERAL, row["issues"])

        result = self.analyse(table(HEADER, ("RY", "3", "US$208.10", "US$624.30")))
        self.assertEqual(self.row(result, "RY")["selected_ticker"], "RY")

    def test_several_listings_need_the_row_price_to_agree(self) -> None:
        # $285.46 is within 3% of RY.TO's latest close and 37% from RY's: the row itself picks the listing
        result = self.analyse(table(HEADER, ("RY", "3", "$285.46", "$856.38")))
        self.assertIsNone(result["currency_hint"])
        row = self.row(result, "RY")
        self.assertEqual([c["ticker"] for c in row["candidates"]], ["RY.TO", "RY"])
        self.assertEqual(row["selected_ticker"], "RY.TO")
        self.assertNotIn(screenshot.ISSUE_SEVERAL, row["issues"])

        # 9% from RY.TO (prices moved, or another venue) is not enough to choose for the user
        result = self.analyse(table(HEADER, ("RY", "3", "$260.00", "$780.00")))
        row = self.row(result, "RY")
        self.assertEqual(row["candidates"][0]["ticker"], "RY.TO")
        self.assertIsNone(row["selected_ticker"])
        self.assertIn(screenshot.ISSUE_SEVERAL, row["issues"])
        self.assertEqual(row["quantity"], 3.0)

        result = self.analyse(table(("Symbol", "Quantity"), ("RY", "3")))  # no price on the row at all
        row = self.row(result, "RY")
        self.assertIsNone(row["selected_ticker"])
        self.assertIn(screenshot.ISSUE_SEVERAL, row["issues"])

    def test_listings_that_all_match_the_row_price_are_not_selected(self) -> None:
        market = FakeMarket({"XYZ": ("XYZ Corp", "NYSE", "USD", 10.00, "EQUITY"),
                             "XYZ.TO": ("XYZ Corp", "Toronto", "CAD", 10.10, "EQUITY")})
        row = self.row(self.analyse(table(HEADER, ("XYZ", "5", "$10.05", "$50.25")), market=market), "XYZ")
        self.assertIsNone(row["selected_ticker"])
        self.assertIn(screenshot.ISSUE_SEVERAL, row["issues"])

    def test_row_currency_must_be_compatible_with_the_listing(self) -> None:
        # €230.00 equals SAP's NYSE close in number only: a euro price cannot confirm a USD listing
        result = self.analyse(table(HEADER, ("SAP", "10", "€230.00", "€2,300.00")))
        row = self.row(result, "SAP")
        self.assertEqual(row["candidates"][0]["ticker"], "SAP.DE")
        self.assertIsNone(row["selected_ticker"])
        self.assertIn(screenshot.ISSUE_SEVERAL, row["issues"])
        self.assertEqual((row["quantity"], row["check"]["status"]), (10.0, "consistent"))

        # an explicit listing still gets selected, but a price in another currency is flagged
        row = self.row(self.analyse(table(HEADER, ("SHEL.L", "100", "$34.00", "$3,400.00"))), "SHEL.L")
        self.assertEqual(row["selected_ticker"], "SHEL.L")
        self.assertTrue(any("trades in GBP" in issue for issue in row["issues"]))

    def test_mixed_currency_table_selects_listings_by_row_price(self) -> None:
        market = FakeMarket({
            "AAPL": ("Apple Inc.", "NasdaqGS", "USD", 347.10, "EQUITY"),
            "AAPL.NE": ("Apple Inc. CDR", "NEO", "CAD", 29.80, "EQUITY"),
            "AAPL.MX": ("Apple Inc.", "Mexico", "MXN", 6420.0, "EQUITY"),
            "MSFT": ("Microsoft Corporation", "NasdaqGS", "USD", 531.33, "EQUITY"),
            "MSFT.NE": ("Microsoft Corporation CDR", "NEO", "CAD", 33.50, "EQUITY"),
            "VOD.L": ("Vodafone Group Plc", "LSE", "GBp", 118.90, "EQUITY"),
            "VOD": ("Vodafone Group Plc", "NasdaqGS", "USD", 9.40, "EQUITY"),
        })
        result = self.analyse(table(HEADER,
                                    ("AAPL", "10", "$347.10", "$3,471.00"),
                                    ("VOD.L", "400", "118.90p", "£475.60"),
                                    ("MSFT", "8", "$531.33", "$4,250.64")), market=market)
        self.assertIsNone(result["currency_hint"])  # four '$' amounts against two in pounds
        rows = result["rows"]
        self.assertEqual([r["selected_ticker"] for r in rows], ["AAPL", "VOD.L", "MSFT"])
        self.assertEqual([r["quantity"] for r in rows], [10.0, 400.0, 8.0])
        self.assertEqual({r["quantity_source"] for r in rows}, {"column"})
        self.assertEqual({r["check"]["status"] for r in rows}, {"consistent"})  # 400 × 118.90p = £475.60
        self.assertEqual([r["issues"] for r in rows], [[], [], []])
        self.assertEqual(rows[0]["candidates"][0]["ticker"], "AAPL")
        self.assertEqual((rows[1]["screenshot_price"], rows[1]["screenshot_value"]), (118.9, 475.6))

    def test_canadian_table_selects_toronto_listings_by_row_price(self) -> None:
        market = FakeMarket({"RY": ("Royal Bank of Canada", "NYSE", "USD", 95.0, "EQUITY"),
                             "RY.TO": ("Royal Bank of Canada", "Toronto", "CAD", 129.40, "EQUITY"),
                             "ENB": ("Enbridge Inc.", "NYSE", "USD", 44.0, "EQUITY"),
                             "ENB.TO": ("Enbridge Inc.", "Toronto", "CAD", 60.0, "EQUITY")})
        result = self.analyse(table(HEADER, ("RY", "15", "$129.40", "$1,941.00"),
                                    ("ENB", "20", "$60.10", "$1,202.00")), market=market)
        self.assertIsNone(result["currency_hint"])
        ry, enb = self.row(result, "RY"), self.row(result, "ENB")
        self.assertEqual((ry["selected_ticker"], ry["quantity"]), ("RY.TO", 15.0))
        self.assertEqual((enb["selected_ticker"], enb["quantity"]), ("ENB.TO", 20.0))
        self.assertEqual([c["ticker"] for c in ry["candidates"]], ["RY.TO", "RY"])
        self.assertEqual((ry["issues"], enb["issues"]), ([], []))
        self.assertEqual({ry["check"]["status"], enb["check"]["status"]}, {"consistent"})

    def test_row_price_outweighs_the_image_currency_hint(self) -> None:
        market = FakeMarket({**LISTINGS, "AAPL": ("Apple Inc.", "NASDAQ", "USD", 347.10, "EQUITY"),
                             "AAPL.NE": ("Apple Inc. CDR", "NEO", "CAD", 29.80, "EQUITY"),
                             "ENB": ("Enbridge Inc.", "NYSE", "USD", 44.0, "EQUITY"),
                             "ENB.TO": ("Enbridge Inc.", "Toronto", "CAD", 60.0, "EQUITY")})
        result = self.analyse(table(HEADER, ("RY", "3", "C$285.46", "C$856.38"),
                                    ("ENB", "20", "C$60.10", "C$1,202.00"),
                                    ("AAPL", "10", "$347.10", "$3,471.00")), market=market)
        self.assertEqual(result["currency_hint"], "CAD")
        aapl = self.row(result, "AAPL")
        self.assertEqual(aapl["selected_ticker"], "AAPL")  # a bare '$' price equal to the US close
        self.assertNotIn(screenshot.ISSUE_SEVERAL, aapl["issues"])
        self.assertEqual(self.row(result, "ENB")["selected_ticker"], "ENB.TO")

        uk = FakeMarket({**LISTINGS, "AAPL": ("Apple Inc.", "NASDAQ", "USD", 347.10, "EQUITY"),
                         "AAPL.NE": ("Apple Inc. CDR", "NEO", "CAD", 29.80, "EQUITY"),
                         "VOD.L": ("Vodafone Group Plc", "LSE", "GBp", 118.90, "EQUITY"),
                         "BP.L": ("BP p.l.c.", "LSE", "GBp", 480.0, "EQUITY")})
        result = self.analyse(table(HEADER, ("VOD.L", "400", "118.90p", "£475.60"),
                                    ("SHEL.L", "100", "£26.50", "£2,650.00"),
                                    ("BP.L", "50", "480.00p", "£240.00"),
                                    ("AAPL", "10", "$347.10", "$3,471.00")), market=uk)
        self.assertEqual(result["currency_hint"], "GBP")  # six pound amounts against two '$'
        self.assertEqual([r["selected_ticker"] for r in result["rows"]], ["VOD.L", "SHEL.L", "BP.L", "AAPL"])
        self.assertEqual({r["check"]["status"] for r in result["rows"]}, {"consistent"})

    def test_value_per_labelled_share_ranks_listings(self) -> None:
        market = FakeMarket({**LISTINGS, "SHOP": ("Shopify Inc.", "NYSE", "USD", 120.0, "EQUITY"),
                             "SHOP.TO": ("Shopify Inc.", "Toronto", "CAD", 165.0, "EQUITY")})
        result = self.analyse(table(("Symbol", "Shares", "Total value"), ("SHOP", "4", "$660.00 CAD"),
                                    columns=(100, 500, 900)), market=market)
        row = self.row(result, "SHOP")
        self.assertEqual(result["currency_hint"], "CAD")
        self.assertEqual([c["ticker"] for c in row["candidates"]], ["SHOP.TO", "SHOP"])
        self.assertEqual((row["selected_ticker"], row["quantity"]), ("SHOP.TO", 4.0))
        self.assertEqual(row["check"]["status"], "consistent")

        # $485.20 / 4 shares = 121.30: within 3% of the NYSE close and 26% from Toronto's, so the row picks SHOP
        result = self.analyse([box(100, 100, "SHOP"), box(900, 100, "$485.20"), box(100, 134, "4 shares")],
                              market=market)
        row = self.row(result, "SHOP")
        self.assertEqual([c["ticker"] for c in row["candidates"]], ["SHOP", "SHOP.TO"])
        self.assertEqual((row["selected_ticker"], row["quantity"]), ("SHOP", 4.0))
        self.assertNotIn(screenshot.ISSUE_SEVERAL, row["issues"])

        # $520.00 / 4 = 130 is 8% from SHOP and 21% from SHOP.TO: neither listing is confirmed
        result = self.analyse([box(100, 100, "SHOP"), box(900, 100, "$520.00"), box(100, 134, "4 shares")],
                              market=market)
        row = self.row(result, "SHOP")
        self.assertIsNone(row["selected_ticker"])
        self.assertIn(screenshot.ISSUE_SEVERAL, row["issues"])
        self.assertEqual(row["quantity"], 4.0)

    def test_mixed_currencies_give_no_hint(self) -> None:
        result = self.analyse(table(HEADER, ("RY.TO", "3", "C$285.46", "C$856.38"),
                                    ("AAPL", "10", "US$347.10", "US$3,471.00")))
        self.assertIsNone(result["currency_hint"])
        self.assertEqual(self.row(result, "RY.TO")["selected_ticker"], "RY.TO")

    def test_fund_names_and_footnote_markers(self) -> None:
        market = FakeMarket({**LISTINGS, "SPAXX": ("Fidelity Government Money Market", "NASDAQ", "USD", 1.0,
                                                   "MUTUALFUND")})
        result = self.analyse(table(("Symbol", "Description", "Quantity", "Price", "Market value"),
                                    ("VTI", "Vanguard Total Stock Mkt", "12", "$270.00", "$3,240.00"),
                                    ("SPAXX**", "Government money fund", "2,345.67", "$1.00", "$2,345.67"),
                                    columns=(100, 300, 800, 1000, 1200)), market=market)
        vti, spaxx = self.row(result, "VTI"), self.row(result, "SPAXX")
        self.assertEqual((vti["detected_name"], vti["quantity"]), ("Vanguard Total Stock Mkt", 12.0))
        self.assertEqual((spaxx["selected_ticker"], spaxx["quantity"]), ("SPAXX", 2345.67))
        self.assertEqual({vti["check"]["status"], spaxx["check"]["status"]}, {"consistent"})


class HeaderlessTests(ScreenshotTestBase):
    def test_quantities_resolved_by_value_checks(self) -> None:
        result = self.analyse(table(("MSFT", "4", "$415.20", "$1,660.80"),
                                    ("VTI", "12", "$270.00", "$3,240.00"),
                                    ("NVDA", "5", "$612.00")))
        self.assertFalse(result["header_detected"])
        self.assertIn(screenshot.WARN_NO_HEADER, result["warnings"])
        msft, vti, nvda = self.row(result, "MSFT"), self.row(result, "VTI"), self.row(result, "NVDA")
        self.assertEqual((msft["quantity"], msft["quantity_source"]), (4.0, "value_check"))
        self.assertEqual((msft["screenshot_price"], msft["screenshot_value"]), (415.2, 1660.8))
        self.assertEqual(vti["quantity"], 12.0)
        self.assertEqual({msft["check"]["status"], vti["check"]["status"]}, {"consistent"})
        # 5 × latest close 120 = 600 ≈ 612 shown (prices move): checked against the market, not the screenshot
        self.assertEqual((nvda["quantity"], nvda["quantity_source"]), (5.0, "value_check"))
        self.assertEqual((nvda["screenshot_price"], nvda["screenshot_value"]), (None, 612.0))
        self.assertEqual(nvda["check"]["status"], "consistent")
        self.assertIn("latest close", nvda["check"]["detail"])

    def test_single_unlabelled_number(self) -> None:
        result = self.analyse(table(("AAPL", "7", "$5,000.00")))
        row = self.row(result, "AAPL")
        self.assertEqual((row["quantity"], row["quantity_source"]), (7.0, "single_number"))
        self.assertIn(screenshot.ISSUE_SINGLE_NUMBER, row["issues"])
        self.assertEqual(row["check"]["status"], "unverified")  # $5,000 is not ≈ 7 × latest, so it is not taken as the value

    def test_number_that_looks_like_a_price_is_not_a_quantity(self) -> None:
        result = self.analyse(table(("AAPL", "349.50", "$9,999.00")))
        row = self.row(result, "AAPL")
        self.assertIsNone(row["quantity"])
        self.assertIn(screenshot.ISSUE_LOOKS_LIKE_PRICE, row["issues"])

    def test_price_lookalike_is_checked_against_every_listing(self) -> None:
        result = self.analyse(table(("RY", "285.46"), ("AAPL", "12")))  # a watchlist-style RY line
        ry = self.row(result, "RY")
        self.assertIsNone(ry["selected_ticker"])
        self.assertIsNone(ry["quantity"])
        self.assertIn(screenshot.ISSUE_LOOKS_LIKE_PRICE, ry["issues"])
        aapl = self.row(result, "AAPL")
        self.assertEqual((aapl["quantity"], aapl["quantity_source"]), (12.0, "single_number"))
        self.assertIn(screenshot.ISSUE_SINGLE_NUMBER, aapl["issues"])

    def test_two_line_rows(self) -> None:
        entries = [
            box(100, 100, "AAPL"), box(900, 100, "$3,471.00"),
            box(100, 134, "Apple Inc. · 10 shares"), box(900, 134, "+1.20%"),
            box(100, 200, "TSLA"), box(900, 200, "$1,250.00"),
            box(100, 234, "Tesla, Inc. · 5 shares"), box(900, 234, "-0.50%"),
            box(100, 300, "RY.TO"),
            box(100, 334, "Royal Bank of Canada"), box(500, 334, "3"), box(700, 334, "$285.46"),
            box(900, 334, "$856.38"),
        ]
        result = self.analyse(entries)
        self.assertEqual([r["detected_symbol"] for r in result["rows"]], ["AAPL", "TSLA", "RY.TO"])
        aapl, tsla, ry = result["rows"]
        self.assertEqual((aapl["quantity"], aapl["quantity_source"], aapl["detected_name"]), (10.0, "column", "Apple Inc."))
        self.assertEqual(aapl["screenshot_value"], 3471.0)
        self.assertEqual(aapl["check"]["status"], "consistent")
        self.assertEqual((tsla["quantity"], tsla["detected_name"]), (5.0, "Tesla, Inc."))
        self.assertEqual((ry["quantity"], ry["quantity_source"]), (3.0, "value_check"))
        self.assertEqual(ry["detected_name"], "Royal Bank of Canada")
        self.assertEqual(ry["box"], {"x": 100, "y": 300, "width": 898, "height": 58})

    def test_symbol_line_below_its_numbers(self) -> None:
        entries = [box(100, 100, "Royal Bank of Canada"), box(500, 100, "3"), box(700, 100, "$285.46"),
                   box(900, 100, "$856.38"), box(100, 134, "RY.TO")]
        result = self.analyse(entries)
        self.assertEqual(len(result["rows"]), 1)
        row = result["rows"][0]
        self.assertEqual((row["detected_symbol"], row["quantity"]), ("RY.TO", 3.0))

    def test_ticker_and_name_in_one_box(self) -> None:
        result = self.analyse(table(("AAPL Apple Inc.", "10", "$347.10", "$3,471.00"), columns=(100, 500, 700, 1000)))
        row = self.row(result, "AAPL")
        self.assertEqual((row["selected_ticker"], row["quantity"]), ("AAPL", 10.0))
        self.assertNotIn(screenshot.ISSUE_NAME_MATCH, row["issues"])

    def test_company_name_without_symbol(self) -> None:
        result = self.analyse(table(("Microsoft Corporation", "4", "$415.20", "$1,660.80"),
                                    columns=(100, 500, 700, 1000)))
        self.assertEqual(len(result["rows"]), 1)
        row = result["rows"][0]
        self.assertIsNone(row["detected_symbol"])
        self.assertEqual(row["detected_name"], "Microsoft Corporation")
        self.assertEqual(row["selected_ticker"], "MSFT")
        self.assertIn(screenshot.ISSUE_NAME_MATCH, row["issues"])
        self.assertLess(row["confidence"], 0.99)
        self.assertEqual(self.market.search_calls, ["Microsoft Corporation"])

    def test_percentage_columns_are_ignored(self) -> None:
        entries = table(("NVDA", "+2.50%", "5", "$120.00", "$600.00"), columns=(100, 300, 500, 700, 900))
        entries += [box(100, 200, "+1.25%"), box(400, 200, "-0.40%")]
        result = self.analyse(entries)
        self.assertEqual(len(result["rows"]), 1)
        row = self.row(result, "NVDA")
        self.assertEqual((row["quantity"], row["quantity_source"]), (5.0, "value_check"))
        self.assertIn("+1.25% -0.40%", [line["text"] for line in result["ignored_lines"]])

    def test_totals_and_cash_are_ignored(self) -> None:
        result = self.analyse(table(("AAPL", "10", "$347.10", "$3,471.00"),
                                    ("Cash", "", "", "$2,500.00"),
                                    ("CASH", "", "", "$100.00"),
                                    ("Buying power", "", "", "$2,500.00"),
                                    ("Account value", "", "", "$6,071.00"),
                                    ("Total", "", "", "$5,971.00")))
        self.assertEqual([r["detected_symbol"] for r in result["rows"]], ["AAPL"])
        ignored = [line["text"] for line in result["ignored_lines"]]
        for text in ("Cash $2,500.00", "CASH $100.00", "Buying power $2,500.00", "Account value $6,071.00",
                     "Total $5,971.00"):
            self.assertIn(text, ignored)

    def test_parenthesised_negatives_are_not_quantities(self) -> None:
        result = self.analyse(table(("AAPL", "10", "$347.10", "$3,471.00", "($125.40)"),
                                    ("MSFT", "(4)", "$415.20", "$1,660.80"), columns=(100, 300, 500, 700, 900)))
        aapl, msft = self.row(result, "AAPL"), self.row(result, "MSFT")
        self.assertEqual(aapl["quantity"], 10.0)
        self.assertIsNone(msft["quantity"])
        self.assertIn(screenshot.ISSUE_ENTER_QUANTITY, msft["issues"])

    def test_duplicate_symbols_are_flagged_and_lookups_cached(self) -> None:
        result = self.analyse(table(("AAPL", "10", "$347.10", "$3,471.00"), ("AAPL", "5", "$347.10", "$1,735.50")))
        self.assertEqual([r["quantity"] for r in result["rows"]], [10.0, 5.0])
        for row in result["rows"]:
            self.assertIn(screenshot.ISSUE_DUPLICATE, row["issues"])
        self.assertEqual(self.market.search_calls, ["AAPL"])
        self.assertEqual(self.market.asset_calls, ["AAPL"])

    def test_unresolved_and_confusable_symbols(self) -> None:
        result = self.analyse(table(("ZZZZ", "10", "$5.00", "$50.00"), ("B0X", "2", "$10.00", "$20.00")))
        unknown, confusable = self.row(result, "ZZZZ"), self.row(result, "B0X")
        for row in (unknown, confusable):
            self.assertEqual(row["candidates"], [])
            self.assertIsNone(row["selected_ticker"])
            self.assertIn(screenshot.ISSUE_NOT_FOUND, row["issues"])
        self.assertEqual(unknown["quantity"], 10.0)
        self.assertNotIn(screenshot.ISSUE_CONFUSABLE, unknown["issues"])
        self.assertIn(screenshot.ISSUE_CONFUSABLE, confusable["issues"])

    def test_market_unavailable(self) -> None:
        market = FakeMarket(down=True)
        result = self.analyse(table(("AAPL", "10", "$347.10", "$3,471.00"), ("MSFT", "4", "$415.20", "$1,660.80")),
                              market=market)
        self.assertEqual(market.search_calls, ["AAPL"])
        self.assertEqual(market.asset_calls, [])
        self.assertEqual(result["warnings"].count(screenshot.WARN_MARKET_DOWN), 1)
        for row in result["rows"]:
            self.assertEqual(row["candidates"], [])
            self.assertIsNone(row["selected_ticker"])
            self.assertIn(screenshot.ISSUE_MARKET_DOWN, row["issues"])
            self.assertNotIn(screenshot.ISSUE_NOT_FOUND, row["issues"])
        self.assertEqual([r["quantity"] for r in result["rows"]], [10.0, 4.0])

    def test_no_market(self) -> None:
        result = self.analyse(table(("AAPL", "10", "$347.10", "$3,471.00")), use_market=False)
        self.assertIn(screenshot.ISSUE_MARKET_DOWN, result["rows"][0]["issues"])
        self.assertIn(screenshot.WARN_MARKET_DOWN, result["warnings"])

    def test_soft_stop_word_needs_row_evidence(self) -> None:
        result = self.analyse(table(("ALL", "5", "$190.00", "$950.00"), ("ALL", "$950.00")))
        self.assertEqual(len(result["rows"]), 1)
        row = self.row(result, "ALL")
        self.assertEqual((row["selected_ticker"], row["quantity"]), ("ALL", 5.0))
        self.assertTrue(any("common label" in issue for issue in row["issues"]))

    def test_low_ocr_confidence(self) -> None:
        result = self.analyse(table(("AAPL", "10", "$347.10", "$3,471.00"), score=0.6))
        row = self.row(result, "AAPL")
        self.assertEqual(row["confidence"], 0.6)
        self.assertIn(screenshot.ISSUE_LOW_OCR, row["issues"])

    def test_lookup_limit(self) -> None:
        symbols = [f"Q{chr(65 + i)}" for i in range(26)] + ["XA", "XB", "XC", "XD"]
        result = self.analyse(table(*[(s, "2", "$5.00", "$10.00") for s in symbols], pitch=40))
        self.assertEqual(len(result["rows"]), 30)
        self.assertEqual(len(self.market.search_calls), 25)
        self.assertIn(screenshot.WARN_LOOKUP_LIMIT, result["warnings"])
        limited = [r["detected_symbol"] for r in result["rows"] if screenshot.ISSUE_LOOKUP_LIMIT in r["issues"]]
        self.assertEqual(limited, symbols[25:])

    def test_row_limit(self) -> None:
        symbols = [f"Q{chr(65 + i)}" for i in range(26)] + [f"X{chr(65 + i)}" for i in range(19)]
        result = self.analyse(table(*[(s, "2", "$5.00", "$10.00") for s in symbols], pitch=30))
        self.assertEqual(len(result["rows"]), 40)
        self.assertIn(screenshot.WARN_TRUNCATED, result["warnings"])

    def test_no_text(self) -> None:
        result = self.analyse([])
        self.assertEqual(result["rows"], [])
        self.assertIn(screenshot.WARN_NO_TEXT, result["warnings"])
        self.assertIn(screenshot.WARN_NO_ROWS, result["warnings"])
        self.assertTrue(screenshot.WARN_NO_ROWS.startswith("No holdings were recognised"))

    def test_malformed_ocr_output_is_skipped(self) -> None:
        entries = [(None, "AAPL", 0.9), ([[0, 0], [10, 0]], "", 0.9), ([[0, 0], [10, 0], [10, 10]], "X", float("nan")),
                   ("bad",), *table(("AAPL", "10", "$347.10", "$3,471.00"))]
        result = self.analyse(entries)
        self.assertEqual([r["detected_symbol"] for r in result["rows"]], ["AAPL"])


# LENS's own Holdings ledger as RapidOCR reads it: sort arrows beside each label come out as "↑↓", "1↓" or
# "11", numeric columns are right-aligned, and an FX column shows 1.0000 on every USD row.
LEDGER_COLUMNS = (  # (header text as read, alignment, anchor x)
    ("Ticker ↑↓", "left", 20), ("Name1↓", "left", 170), ("Exchange↑↓", "left", 420), ("Quote 11", "left", 600),
    ("11 Shares", "right", 860), ("↑1 Last close", "right", 1080), ("↑↓ FX → USD", "right", 1280),
    ("↑1 Value USD", "right", 1480), ("Weight", "right", 1620), ("11 Session", "right", 1800),
    ("1↓ 1M", "right", 1920), ("11 1Y", "right", 2040), ("↑1 Volatility", "right", 2260),
    ("↑↓ Risk share", "right", 2480),
)
LEDGER_ROWS = {
    "AAPL": ("AAPL", "Apple Inc.", "NASDAQ", "USD", "12", "347.10 USD", "1.0000", "4,165.20", "32.1%", "▲0.52%",
             "▲3.10%", "▲18.20%", "27.4%", "30.1%"),
    "MSFT": ("MSFT", "Microsoft Corp.", "NASDAQ", "USD", "8", "531.33 USD", "1.0000", "4,250.64", "32.8%", "▼0.31%",
             "▲1.20%", "▲12.40%", "22.9%", "26.0%"),
    "NVDA": ("NVDA", "NVIDIA Corp.", "NASDAQ", "USD", "10", "181.20 USD", "1.0000", "1,812.00", "14.0%", "▲1.84%",
             "▲6.75%", "▲35.10%", "48.2%", "28.4%"),
    "GOOGL": ("GOOGL", "Alphabet Inc.", "NASDAQ", "USD", "10", "274.70 USD", "1.0000", "2,747.00", "21.2%", "▼0.12%",
              "▲4.30%", "▲21.90%", "29.5%", "15.5%"),
}
LEDGER_FOOTER = ("Total", "4 holdings", "", "", "", "", "", "12,974.84", "100.0%", "▲0.21%", "", "", "22.1%", "100.0%")
LEDGER_LISTINGS = {
    "AAPL": ("Apple Inc.", "NASDAQ", "USD", 347.10, "EQUITY"),
    "MSFT": ("Microsoft Corporation", "NASDAQ", "USD", 531.33, "EQUITY"),
    "NVDA": ("NVIDIA Corporation", "NASDAQ", "USD", 181.20, "EQUITY"),
    "GOOGL": ("Alphabet Inc.", "NASDAQ", "USD", 274.70, "EQUITY"),
    "TSLA": ("Tesla, Inc.", "NASDAQ", "USD", 250.00, "EQUITY"),
    "RY": ("Royal Bank of Canada", "NYSE", "USD", 95.00, "EQUITY"),
    "RY.TO": ("Royal Bank of Canada", "Toronto", "CAD", 129.40, "EQUITY"),
}


def ledger(*rows, header: bool = True, top: int = 100, pitch: int = 56) -> list:
    lines = ([tuple(label for label, _, _ in LEDGER_COLUMNS)] if header else []) + list(rows)
    entries = []
    for index, cells in enumerate(lines):
        for (_, align, anchor), text in zip(LEDGER_COLUMNS, cells):
            if text:
                x = anchor if align == "left" else anchor - CHAR_WIDTH * len(text)
                entries.append(box(x, top + index * pitch, text))
    return entries


class NoCurrencyMarket(FakeMarket):
    """A market whose assets do not report an ISO currency."""

    def asset(self, ticker: str) -> dict:
        return {**super().asset(ticker), "currency_iso": None}


class LedgerTests(ScreenshotTestBase):
    wide: bytes = b""

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.wide = image_bytes(2600, 900)  # between 1400 and 4000 px: no rescaling

    def setUp(self) -> None:
        super().setUp()
        self.market = FakeMarket(LEDGER_LISTINGS)

    def analyse_ledger(self, *rows, header: bool = True) -> dict:
        return self.analyse(ledger(*rows, header=header), image=self.wide)

    def assert_no_currency_mismatch(self, row: dict) -> None:
        text = " ".join([row["check"]["detail"], *row["issues"]]).lower()
        self.assertNotIn("different currenc", text)
        self.assertNotIn("another currency", text)

    def test_quantities_come_from_the_shares_column(self) -> None:
        result = self.analyse_ledger(*LEDGER_ROWS.values(), LEDGER_FOOTER)
        self.assertTrue(result["header_detected"])
        self.assertEqual(result["currency_hint"], "USD")
        self.assertEqual([r["detected_symbol"] for r in result["rows"]], ["AAPL", "MSFT", "NVDA", "GOOGL"])
        self.assertEqual([r["quantity"] for r in result["rows"]], [12, 8, 10, 10])
        self.assertEqual({r["quantity_source"] for r in result["rows"]}, {"column"})
        self.assertEqual([r["screenshot_price"] for r in result["rows"]], [347.10, 531.33, 181.20, 274.70])
        self.assertEqual([r["screenshot_value"] for r in result["rows"]], [4165.20, 4250.64, 1812.00, 2747.00])
        for row in result["rows"]:
            with self.subTest(symbol=row["detected_symbol"]):
                self.assertEqual(row["selected_ticker"], row["detected_symbol"])
                self.assertEqual(row["check"]["status"], "consistent", row["check"])
                self.assertEqual(row["issues"], [])
                self.assert_no_currency_mismatch(row)
        self.assertTrue(any(line["text"].startswith("Total") for line in result["ignored_lines"]))

    def test_one_share_in_the_quantity_column(self) -> None:
        tesla = ("TSLA", "Tesla, Inc.", "NASDAQ", "USD", "1", "250.00 USD", "1.0000", "250.00", "5.7%")
        result = self.analyse_ledger(LEDGER_ROWS["AAPL"], tesla)
        row = self.row(result, "TSLA")
        self.assertEqual((row["quantity"], row["quantity_source"]), (1, "column"))
        self.assertEqual((row["screenshot_price"], row["screenshot_value"]), (250.0, 250.0))
        self.assertEqual(row["check"]["status"], "consistent")
        self.assertEqual(self.row(result, "AAPL")["quantity"], 12)

    def test_missing_shares_cell_leaves_the_quantity_empty(self) -> None:
        aapl = list(LEDGER_ROWS["AAPL"])
        aapl[4] = ""
        result = self.analyse_ledger(tuple(aapl), LEDGER_ROWS["MSFT"])
        row = self.row(result, "AAPL")
        self.assertIsNone(row["quantity"])
        self.assertEqual(row["quantity_source"], "none")
        self.assertIn(screenshot.ISSUE_NO_SHARES_CELL, row["issues"])
        self.assertIn(screenshot.ISSUE_ENTER_QUANTITY, row["issues"])
        self.assertEqual(row["check"]["status"], "unverified")
        self.assertEqual(self.row(result, "MSFT")["quantity"], 8)

    def test_fx_column_is_never_a_quantity_without_header(self) -> None:
        result = self.analyse_ledger(*LEDGER_ROWS.values(), LEDGER_FOOTER, header=False)
        self.assertFalse(result["header_detected"])
        self.assertEqual(len(result["rows"]), 4)
        for row in result["rows"]:
            with self.subTest(symbol=row["detected_symbol"]):
                self.assertIsNone(row["quantity"])
                self.assertIn(screenshot.ISSUE_ENTER_QUANTITY, row["issues"])
                self.assert_no_currency_mismatch(row)

    def test_one_times_the_price_is_not_a_value_check(self) -> None:
        result = self.analyse_ledger(LEDGER_ROWS["AAPL"], header=False)  # a single row: no column to compare
        row = self.row(result, "AAPL")
        self.assertNotEqual(row["quantity"], 1)
        self.assertNotEqual(row["quantity_source"], "value_check")

    def test_rate_weight_and_risk_columns_are_not_used(self) -> None:
        entries = table(("Symbol", "Price", "FX", "Market value", "Risk share"),
                        ("AAPL", "$347.10", "1.0000", "$3,471.00", "30.1%"), columns=(100, 400, 700, 1000, 1300))
        row = self.row(self.analyse(entries), "AAPL")
        self.assertEqual((row["quantity"], row["quantity_source"]), (10, "derived_from_value"))
        self.assertIn(screenshot.ISSUE_DERIVED_SHOWN, row["issues"])
        self.assertNotIn(screenshot.ISSUE_NO_SHARES_CELL, row["issues"])  # "Risk share" is not a share count

    def test_value_column_in_another_currency_is_not_reconciled(self) -> None:
        royal = ("RY", "Royal Bank", "TSX", "CAD", "10", "129.40 CAD", "0.7300", "944.62", "18.4%")
        result = self.analyse_ledger(LEDGER_ROWS["AAPL"], royal)
        row = self.row(result, "RY")
        self.assertEqual(row["selected_ticker"], "RY.TO")
        self.assertEqual((row["quantity"], row["quantity_source"]), (10, "column"))
        self.assertEqual((row["screenshot_price"], row["screenshot_value"]), (129.40, 944.62))
        self.assertEqual(row["check"]["status"], "unverified")
        self.assertIn("different currencies", row["check"]["detail"])
        self.assertNotIn(screenshot.ISSUE_NOT_RECONCILED, row["issues"])
        self.assert_no_currency_mismatch(self.row(result, "AAPL"))

    def test_currency_mismatch_is_reported_only_when_the_currency_differs(self) -> None:
        header = ("Symbol", "Quantity", "Market value")
        euro = self.row(self.analyse(table(header, ("AAPL", "10", "€3,200.00")), market=FakeMarket()), "AAPL")
        self.assertEqual(euro["check"]["status"], "unverified")
        self.assertIn("different currency (EUR)", euro["check"]["detail"])
        self.assertIn("(USD)", euro["check"]["detail"])
        dollars = self.row(self.analyse(table(header, ("AAPL", "10", "$3,500.00")), market=FakeMarket()), "AAPL")
        self.assertEqual(dollars["check"]["status"], "consistent")
        self.assert_no_currency_mismatch(dollars)
        unknown = self.row(self.analyse(table(header, ("AAPL", "10", "$3,500.00")), market=NoCurrencyMarket()), "AAPL")
        self.assertEqual(unknown["check"]["status"], "unverified")
        self.assertIn("unknown", unknown["check"]["detail"])
        self.assert_no_currency_mismatch(unknown)

    def test_sort_icons_and_cells_that_ocr_runs_together(self) -> None:
        # as RapidOCR read a real render: icons glued to labels, and each value run into the weight beside it
        header = ("Ticker 1↓", "Name ↑↓", "Exchange ↑↓", "Quote↑↓", "1↓Shares", "↑↓ Last close", "↑↓ FX → USD",
                  "1↓Value USD", "Weight↑↓", "1Session", "1↓1M", "1↓1Y", "11Volatility", "↑↓ Risk share")
        rows, fused = [], []
        for index, cells in enumerate(LEDGER_ROWS.values(), start=1):
            rows.append(cells[:7] + ("", "") + cells[9:])
            value_right = LEDGER_COLUMNS[7][2]
            fused.append(box(value_right - CHAR_WIDTH * len(cells[7]), 100 + index * 56, cells[7] + cells[8]))
        result = self.analyse(ledger(header, *rows, header=False) + fused, image=self.wide)
        self.assertTrue(result["header_detected"])
        self.assertEqual([r["quantity"] for r in result["rows"]], [12, 8, 10, 10])
        self.assertEqual({r["quantity_source"] for r in result["rows"]}, {"column"})
        self.assertEqual([r["screenshot_value"] for r in result["rows"]], [4165.20, 4250.64, 1812.00, 2747.00])
        for row in result["rows"]:
            with self.subTest(symbol=row["detected_symbol"]):
                self.assertEqual(row["check"]["status"], "consistent", row["check"])
                self.assertEqual(row["issues"], [])


class NumberParsingTests(unittest.TestCase):
    def test_parse_number_variants(self) -> None:
        parse = screenshot._parse_number
        cases = {
            "1,234.56": (1234.56, False, False, False), "$1,234.56": (1234.56, True, False, False),
            "C$12.50": (12.5, True, False, False), "US$7": (7.0, True, False, False),
            "(123.45)": (123.45, False, False, True), "-12.3": (12.3, False, False, True),
            "($1,234.56)": (1234.56, True, False, True), "12.5%": (12.5, False, True, False),
            "1.234,56": (1234.56, False, False, False), "1.234,56€": (1234.56, True, False, False),
            "£2,650.00": (2650.0, True, False, False),
        }
        for text, (value, monetary, percent, negative) in cases.items():
            with self.subTest(text=text):
                num = parse(text)
                self.assertIsNotNone(num)
                self.assertAlmostEqual(num.value, value)
                self.assertEqual((num.monetary, num.percent, num.negative), (monetary, percent, negative))
        self.assertEqual(parse("C$12.50").currency, "CAD")
        self.assertEqual(parse("1.234,56€").currency, "EUR")
        pence = parse("118.90p")
        self.assertEqual((pence.value, pence.monetary, pence.currency), (118.9, True, "GBX"))
        self.assertTrue(parse("10shares").unit)
        self.assertEqual(parse("1,234").style, "ambiguous")
        self.assertIsNone(parse("AAPL"))
        self.assertIsNone(parse("1,2,3"))

    def test_currency_codes_name_the_numbers_beside_them(self) -> None:
        def single_number(text: str):
            pieces = [piece for piece in screenshot._split_text(text) if piece[3] is not None]
            self.assertEqual(len(pieces), 1, pieces)
            return pieces[0][3]

        for text, currency in (("$660.00 CAD", "CAD"), ("USD $12.00", "USD"), ("118.90 GBp", "GBX"),
                               ("118.90 p", "GBX"), ("$5.00", None), ("€5.00 CAD", "EUR")):
            with self.subTest(text=text):
                num = single_number(text)
                self.assertTrue(num.monetary)
                self.assertEqual(num.currency, currency)

    def test_currency_hint_needs_a_clear_majority(self) -> None:
        def line(*texts: str) -> list:
            return [screenshot._Token(text, 0, 0, 1, 1, 1.0, screenshot._parse_number(text)) for text in texts]

        hint = screenshot._currency_hint
        self.assertIsNone(hint([line("$347.10", "$3,471.00"), line("118.90p", "£475.60"),
                                line("$531.33", "$4,250.64")]))
        self.assertEqual(hint([line("£1", "£2")] * 3 + [line("$1", "$2")]), "GBP")
        self.assertEqual(hint([line("C$1", "C$2"), line("$3", "$4"), line("$5", "$6")]), "CAD")  # '$' fits CAD
        self.assertIsNone(hint([line("C$1"), line("US$2")]))
        self.assertIsNone(hint([line("$1", "$2")]))

    def test_amount_run_into_a_percentage_is_split(self) -> None:
        def numbers(text: str) -> list:
            return [(piece[2], piece[3].value, piece[3].percent) for piece in screenshot._split_text(text)
                    if piece[3] is not None]

        self.assertEqual(numbers("4,250.6432.8%"), [("4,250.64", 4250.64, False), ("32.8%", 32.8, True)])
        self.assertEqual(numbers("$12,974.84100.0%"), [("$12,974.84", 12974.84, False), ("100.0%", 100.0, True)])
        self.assertEqual(numbers("1,234.56-1.2%"), [("1,234.56", 1234.56, False), ("-1.2%", 1.2, True)])
        # small amounts (where the cut could matter), signed amounts and ranges stay unread
        for text in ("12.3445.6%", "1.0000100.0%", "0.05-0.10%", "(4,250.64)32.8%", "+1,234.56+1.2%"):
            with self.subTest(text=text):
                self.assertEqual(numbers(text), [])

    def test_header_words_lose_sort_icons(self) -> None:
        for raw, word in (("Name1↓", "name"), ("1↓Shares", "shares"), ("↑↓Value", "value"), ("1↓1M", "1m"),
                          ("11Volatility", "volatility"), ("Weight↑↓", "weight"), ("11", ""), ("↑↓", ""),
                          ("S&P", "s&p")):
            with self.subTest(raw=raw):
                self.assertEqual(screenshot._clean_header_word(raw), word)

    def test_symbol_shapes(self) -> None:
        for text in ("AAPL", "BRK.B", "BRK-B", "RY.TO", "0700.HK", "7203.T", "SHOP.TO", "BF-B"):
            with self.subTest(text=text):
                self.assertTrue(screenshot._symbol_shape(text))
        for text in ("Apple", "12345", "A1234", "TOOLONGX", "AB.12"):
            with self.subTest(text=text):
                self.assertFalse(screenshot._symbol_shape(text))
        self.assertIsNone(screenshot._symbol_kind("USD"))
        self.assertIsNone(screenshot._symbol_kind("TOTAL"))
        self.assertEqual(screenshot._symbol_kind("ALL"), "soft")
        self.assertEqual(screenshot._symbol_kind("AAPL"), "hard")


@unittest.skipIf(Image is None, "Pillow is not installed")
class ImageTests(ScreenshotTestBase):
    def test_rejects_non_bytes_empty_and_oversize(self) -> None:
        for data in ("not bytes", b"", b"\x89PNG" + b"0" * MAX_BYTES):
            with self.subTest(size=len(data)), self.assertRaises(ScreenshotError):
                analyze_screenshot(data, self.market, ocr=FakeOcr([]))

    def test_rejects_garbage_and_unsupported_formats(self) -> None:
        for data in (b"definitely not an image", image_bytes(400, 300, fmt="TIFF")):
            with self.subTest(prefix=data[:4]), self.assertRaises(ScreenshotError):
                analyze_screenshot(data, self.market, ocr=FakeOcr([]))

    def test_rejects_tiny_and_extreme_aspect_images(self) -> None:
        for size in ((50, 30), (2000, 100)):
            with self.subTest(size=size), self.assertRaises(ScreenshotError):
                analyze_screenshot(image_bytes(*size), self.market, ocr=FakeOcr([]))

    def test_rejects_decompression_bombs(self) -> None:
        for size in ((50_000, 50_000), (7_000, 7_000)):
            with self.subTest(size=size), self.assertRaises(ScreenshotError) as caught:
                analyze_screenshot(png_claiming(*size), self.market, ocr=FakeOcr([]))
            self.assertIn("too many pixels", str(caught.exception))

    def test_accepts_supported_formats(self) -> None:
        formats = [("JPEG", {}), ("GIF", {}), ("BMP", {}), ("PNG", {})]
        if features.check("webp"):
            formats.append(("WEBP", {}))
        for fmt, options in formats:
            with self.subTest(fmt=fmt):
                result = analyze_screenshot(image_bytes(800, 500, fmt=fmt, **options), self.market, ocr=FakeOcr([]))
                self.assertEqual(result["image"], {"width": 800, "height": 500})

    def test_boxes_map_back_to_original_pixels_when_upscaled(self) -> None:
        ocr = FakeOcr([box(200, 200, "AAPL"), box(600, 200, "10"), box(800, 200, "$347.10"),
                       box(1000, 200, "$3,471.00")])
        result = analyze_screenshot(image_bytes(700, 400), self.market, ocr=ocr)
        self.assertEqual(ocr.shapes, [(800, 1400, 3)])
        self.assertEqual(result["image"], {"width": 700, "height": 400})
        row = self.row(result, "AAPL")
        self.assertEqual(row["box"], {"x": 100, "y": 100, "width": 463, "height": 12})
        self.assertEqual(row["quantity"], 10.0)

    def test_boxes_map_back_to_original_pixels_when_downscaled(self) -> None:
        ocr = FakeOcr([box(800, 400, "AAPL"), box(1200, 400, "10"), box(1600, 400, "$347.10"),
                       box(2000, 400, "$3,471.00")])
        result = analyze_screenshot(image_bytes(5000, 1000), self.market, ocr=ocr)
        self.assertEqual(ocr.shapes, [(800, 4000, 3)])
        self.assertEqual(self.row(result, "AAPL")["box"], {"x": 1000, "y": 500, "width": 1658, "height": 30})

    def test_transparency_is_composited_on_white(self) -> None:
        ocr = FakeOcr([])
        analyze_screenshot(image_bytes(1600, 900, mode="RGBA", color=(0, 0, 0, 0)), self.market, ocr=ocr)
        self.assertEqual(ocr.corner, (255, 255, 255))

    def test_exif_orientation_is_applied(self) -> None:
        exif = Image.Exif()
        exif[0x0112] = 6  # rotate 90° clockwise when displayed
        ocr = FakeOcr([])
        result = analyze_screenshot(image_bytes(1600, 900, fmt="JPEG", exif=exif), self.market, ocr=ocr)
        self.assertEqual(result["image"], {"width": 900, "height": 1600})
        self.assertEqual(ocr.shapes, [(1600, 900, 3)])

    def test_naive_now_is_treated_as_utc(self) -> None:
        result = analyze_screenshot(self.blank, self.market, ocr=FakeOcr([]), now=datetime(2025, 1, 2, 3, 4, 5))
        self.assertEqual(result["processed_at"], "2025-01-02T03:04:05Z")

    def test_missing_ocr_engine_raises_ocr_unavailable(self) -> None:
        with mock.patch.object(screenshot, "_engine", None), mock.patch.dict(sys.modules, {"rapidocr": None}):
            with self.assertRaises(OcrUnavailable):
                analyze_screenshot(self.blank, self.market)


@unittest.skipIf(Image is None or not HAVE_RAPIDOCR, "Pillow or rapidocr is not installed")
class RealOcrTests(ScreenshotTestBase):
    def test_reads_rendered_holdings_table(self) -> None:
        rows = [HEADER, ("AAPL", "10", "$347.10", "$3,471.00"), ("RY.TO", "3", "$285.46", "$856.38"),
                ("BRK.B", "2.5", "$512.20", "$1,280.50")]
        image = Image.new("RGB", (1500, 1000), "white")
        draw = ImageDraw.Draw(image)
        font = ImageFont.load_default(size=26)
        for index, cells in enumerate(rows):
            for x, text in zip((80, 420, 720, 1060), cells):
                draw.text((x, 80 + index * 70), text, fill="black", font=font)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")

        started = time.perf_counter()
        try:
            result = analyze_screenshot(buffer.getvalue(), self.market, now=NOW)
        except OcrUnavailable as exc:
            self.skipTest(f"OCR engine unavailable: {exc}")
        elapsed = time.perf_counter() - started

        self.assertTrue(result["header_detected"])
        self.assertEqual([r["detected_symbol"] for r in result["rows"]], ["AAPL", "RY.TO", "BRK.B"])
        self.assertEqual([r["selected_ticker"] for r in result["rows"]], ["AAPL", "RY.TO", "BRK-B"])
        self.assertEqual([r["quantity"] for r in result["rows"]], [10.0, 3.0, 2.5])
        self.assertEqual({r["check"]["status"] for r in result["rows"]}, {"consistent"})
        self.assertLess(elapsed, 15.0)


if __name__ == "__main__":
    unittest.main()
