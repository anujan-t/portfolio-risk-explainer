from datetime import date, datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest

from backend.market import MarketUnavailable, UnsupportedAsset
from backend.news import (
    FRESH_REASON, RUNNING_REASON, SOURCE, NewsService, balanced, collapse, company_match, iso, month_before, normalise_item, related_tickers,
    sector_move,
)
from backend.sectors import SECTORS
from backend.storage import Store

NOW = datetime(2026, 10, 28, 15, 0, tzinfo=timezone.utc)  # a Wednesday
PROXIES = [sector[scope] for sector in SECTORS for scope in ("us", "global")]
SEARCH = "/v1/finance/search"


def raw_story(uuid, title, minutes_ago=60, tickers=(), publisher="Newswire", link=None, now=NOW):
    return {
        "uuid": uuid, "title": title, "publisher": publisher, "link": link or f"https://example.com/news/{uuid}", "type": "STORY",
        "providerPublishTime": int((now - timedelta(minutes=minutes_ago)).timestamp()), "relatedTickers": list(tickers),
    }


def story_at(moment):
    return {**raw_story("s", "Headline"), "providerPublishTime": int(moment.timestamp())}


def make_chart(proxy, last_day):
    records, day, level = [], last_day - timedelta(days=400), 100.0
    while day <= last_day:
        if day.weekday() < 5:
            level *= 1.0005
            records.append({"date": day.isoformat(), "close": level, "adjusted_close": level})
        day += timedelta(days=1)
    return {"name": f"{proxy} Fund", "currency": "USD", "records": records, "price_date": last_day.isoformat()}


def chart_of(closes, **extra):
    records = [{"date": day, "close": value, "adjusted_close": value} for day, value in sorted(closes.items())]
    return {"name": "Test Fund", "currency": "USD", "records": records, **extra}


def search_call(query):
    return ("request", SEARCH, {"q": query, "quotesCount": 0, "newsCount": 10})


def wait_until(predicate, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


class Clock:
    def __init__(self, now=NOW):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, **delta):
        self.now += timedelta(**delta)


class FakeMarket:
    """Scripted stand-in for backend.market.Market: charts by ticker, search news by query, every call recorded."""

    def __init__(self, now=lambda: NOW):
        self.now = now
        self.charts, self.news, self.calls = {}, {}, []
        self.delay, self.forbidden, self.before_call = 0.0, False, None
        self._lock = threading.Lock()

    def _enter(self, record):
        if self.forbidden:
            raise AssertionError(f"unexpected provider call: {record}")
        with self._lock:
            self.calls.append(record)
        if self.before_call:
            self.before_call(record)
        if self.delay:
            time.sleep(self.delay)

    @property
    def chart_calls(self):
        return [call for call in list(self.calls) if call[0] == "chart"]

    @property
    def queries(self):
        return [call[2]["q"] for call in list(self.calls) if call[0] == "request"]

    def chart(self, ticker, history_range="1y", refresh=False):
        self._enter(("chart", ticker, history_range, refresh))
        value = self.charts.get(ticker)
        if value is None and ticker in PROXIES:
            value = make_chart(ticker, (self.now() - timedelta(days=1)).date())
        if value is None:
            raise UnsupportedAsset(f"{ticker} was not found.")
        if isinstance(value, Exception):
            raise value
        return value

    def request(self, path, params):
        self._enter(("request", path, dict(params)))
        value = self.news.get(params["q"])
        if value is None:
            query = params["q"]
            value = [raw_story(f"{query}-1", f"{query} sector update one", 60, now=self.now()),
                     raw_story(f"{query}-2", f"{query} sector update two", 120, now=self.now())] if query in PROXIES else []
        if callable(value):
            value = value()
        if isinstance(value, Exception):
            raise value
        return value if isinstance(value, dict) else {"news": value}


class ServiceTestCase(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(temp.cleanup)
        self.store = Store(Path(temp.name))
        self.clock = Clock()
        self.market = FakeMarket(now=lambda: self.clock.now)
        self.sleeps = []

    def service(self, **options):
        options = {"clock": self.clock, "sleep": self.sleeps.append, **options}
        service = NewsService(self.store, self.market, **options)
        self.addCleanup(service.stop)
        return service

    def rows(self, sql, *args):
        with self.store.connect() as db:
            return [dict(row) for row in db.execute(sql, args).fetchall()]

    def sector(self, board, sector_id):
        return next(sector for sector in board["sectors"] if sector["id"] == sector_id)

    def fail_everything(self, message="offline", prices=True, news=True):
        for proxy in PROXIES:
            if prices:
                self.market.charts[proxy] = MarketUnavailable(message)
            if news:
                self.market.news[proxy] = MarketUnavailable(message)


class NormaliseTests(unittest.TestCase):
    def test_valid_story(self):
        raw = raw_story("abc-123", "Fed holds rates", 30, ["aapl", "MSFT", "AAPL"], "Reuters")
        self.assertEqual(normalise_item(raw, NOW, ["information_technology"]), {
            "id": "abc-123", "title": "Fed holds rates", "publisher": "Reuters", "url": "https://example.com/news/abc-123",
            "published_at": "2026-10-28T14:30:00Z", "tickers": ["AAPL", "MSFT"], "sectors": ["information_technology"], "source": SOURCE,
        })
        self.assertEqual(SOURCE, "Yahoo Finance (unofficial public endpoint)")

    def test_html_entities_and_whitespace_are_cleaned(self):
        item = normalise_item(raw_story("a", "  Tom &amp; Jerry&#39;s\n\t Q3 &lt;beat&gt;&nbsp; results  ", publisher=" Barron&#39;s "), NOW)
        self.assertEqual(item["title"], "Tom & Jerry's Q3 <beat> results")
        self.assertEqual(item["publisher"], "Barron's")

    def test_invisible_and_control_characters_are_removed(self):
        item = normalise_item(raw_story("a", "Zero\u200bwidth\u202e title\x00 here"), NOW)
        self.assertEqual(item["title"], "Zerowidth title here")

    def test_id_prefers_the_provider_uuid_then_hashes_the_link(self):
        link = "https://example.com/story?id=7"
        digest = hashlib.sha256(link.encode()).hexdigest()[:24]
        for uuid in (None, "", "has space", "x" * 65, 12, "a/b"):
            raw = raw_story("ignored", "Headline", link=link)
            raw["uuid"] = uuid
            self.assertEqual(normalise_item(raw, NOW)["id"], digest, uuid)
        del raw["uuid"]
        self.assertEqual(normalise_item(raw, NOW)["id"], digest)
        self.assertEqual(normalise_item(raw_story(" 4f1c-aa ", "Headline", link=link), NOW)["id"], "4f1c-aa")

    def test_unsafe_or_relative_links_are_rejected(self):
        rejected = (
            "javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<b>x</b>", "/relative/path", "//example.com/x", "ftp://example.com/x",
            "mailto:a@example.com", "http://", "https:///path", "https://user:pw@example.com/x", "https://exa mple.com/x",
            "https://example.com/a\nb", "https://example.com:99999/x", "http://[::1/x", "", "   ", None, 5, ["https://example.com"],
        )
        for link in rejected:
            raw = raw_story("a", "Headline")
            raw["link"] = link
            with self.subTest(link=link):
                self.assertIsNone(normalise_item(raw, NOW))
        raw = raw_story("a", "Headline")
        del raw["link"]
        self.assertIsNone(normalise_item(raw, NOW))
        for link in ("http://example.com/x", "HTTPS://Example.com/a?b=c#d", "https://example.com:8443/x"):
            raw["link"] = link
            with self.subTest(link=link):
                self.assertEqual(normalise_item(raw, NOW)["url"], link)

    def test_a_publish_time_is_required_and_must_be_a_number(self):
        for value in (None, "1793199000", True, float("nan"), float("inf"), -float("inf"), [], {}, 10**30, 10**400, -10**30):
            raw = raw_story("a", "Headline")
            raw["providerPublishTime"] = value
            with self.subTest(value=repr(value)[:20]):
                self.assertIsNone(normalise_item(raw, NOW))
        raw = raw_story("a", "Headline")
        del raw["providerPublishTime"]
        self.assertIsNone(normalise_item(raw, NOW))
        raw["providerPublishTime"] = (NOW - timedelta(minutes=5)).timestamp() + 0.4
        self.assertEqual(normalise_item(raw, NOW)["published_at"], "2026-10-28T14:55:00Z")

    def test_future_and_expired_stories_are_rejected(self):
        accepted = (NOW + timedelta(days=1), NOW + timedelta(hours=23), NOW, NOW - timedelta(days=21), NOW - timedelta(days=20, hours=23))
        rejected = (NOW + timedelta(days=1, seconds=1), NOW + timedelta(days=30), NOW - timedelta(days=21, seconds=1), NOW - timedelta(days=400))
        for moment in accepted:
            with self.subTest(accepted=moment):
                self.assertEqual(normalise_item(story_at(moment), NOW)["published_at"], iso(moment))
        for moment in rejected:
            with self.subTest(rejected=moment):
                self.assertIsNone(normalise_item(story_at(moment), NOW))

    def test_published_at_is_utc_with_a_z_suffix(self):
        local = datetime(2026, 10, 28, 9, 30, tzinfo=timezone(timedelta(hours=-5)))
        self.assertEqual(normalise_item(story_at(local), NOW)["published_at"], "2026-10-28T14:30:00Z")

    def test_title_length_bounds(self):
        for title, ok in (("", False), ("   ", False), ("&nbsp;", False), ("x", True), ("x" * 300, True), ("x" * 301, False), (None, False), (5, False)):
            with self.subTest(title=str(title)[:10], size=len(str(title))):
                self.assertEqual(normalise_item(raw_story("a", title), NOW) is not None, ok)

    def test_publisher_bounds(self):
        for publisher, expected in ((None, "Unknown publisher"), ("", "Unknown publisher"), ("  ", "Unknown publisher"), (7, "Unknown publisher"),
                                    ("p" * 120, "p" * 120), ("p" * 121, "Unknown publisher"), ("MT Newswires", "MT Newswires")):
            with self.subTest(publisher=str(publisher)[:10]):
                self.assertEqual(normalise_item(raw_story("a", "Headline", publisher=publisher), NOW)["publisher"], expected)
        raw = raw_story("a", "Headline")
        del raw["publisher"]
        self.assertEqual(normalise_item(raw, NOW)["publisher"], "Unknown publisher")

    def test_related_tickers_are_filtered_and_upper_cased(self):
        symbols = ["aapl", " msft ", "AAPL", "bad ticker", "TOOLONG" * 5, "^DJI", "CL=F", "BRK-B", "7203.T", "S&P", "ＡＡＰＬ", "", "x" * 26, 5, None]
        expected = ["AAPL", "MSFT", "^DJI", "CL=F", "BRK-B", "7203.T", "S&P"]
        self.assertEqual(normalise_item(raw_story("a", "Headline", tickers=symbols), NOW)["tickers"], expected)
        self.assertEqual(related_tickers(symbols), expected)

    def test_displayed_tickers_are_capped_but_relevance_sees_them_all(self):
        symbols = [f"T{index}" for index in range(15)]
        self.assertEqual(normalise_item(raw_story("a", "Headline", tickers=symbols), NOW)["tickers"], symbols[:12])
        self.assertEqual(related_tickers(symbols), symbols)
        for value in ("AAPL", None, {"a": 1}, 5):
            self.assertEqual(related_tickers(value), [])

    def test_non_dict_payloads_are_rejected(self):
        for raw in (None, "story", 5, ["a"]):
            self.assertIsNone(normalise_item(raw, NOW))


class HelperTests(unittest.TestCase):
    def test_collapse_by_link_and_by_publisher_and_title(self):
        stories = [
            {"id": "n1", "url": "https://x/1", "publisher": "MT Newswires", "title": "Sector Update: Energy"},
            {"id": "n2", "url": "https://x/2", "publisher": "mt newswires", "title": "SECTOR UPDATE: ENERGY"},
            {"id": "n3", "url": "https://x/1", "publisher": "Other", "title": "Different"},
            {"id": "n4", "url": "https://x/4", "publisher": "Other", "title": "Sector Update: Energy"},
            {"id": "n5", "url": "https://x/2", "publisher": "Third", "title": "Also the second link"},
        ]
        kept, alias = collapse(stories)
        self.assertEqual([story["id"] for story in kept], ["n1", "n4"])
        self.assertEqual(alias, {"n1": "n1", "n2": "n1", "n3": "n1", "n4": "n4", "n5": "n1"})

    def test_balanced_rotates_through_the_holdings(self):
        self.assertEqual(balanced({"A": ["a1", "a2", "a3"], "B": ["b1"], "C": ["c1", "c2"]}, 5), {"a1", "b1", "c1", "a2", "c2"})
        self.assertEqual(balanced({"A": ["a1", "a2"], "B": ["b1"]}, 10), {"a1", "a2", "b1"})
        self.assertEqual(balanced({"A": ["s", "a2"], "B": ["s", "b2"]}, 3), {"s", "a2", "b2"})
        self.assertEqual(balanced({"A": ["a1"]}, 0), set())
        self.assertEqual(balanced({}, 5), set())

    def test_month_before_clamps_to_the_shorter_month(self):
        for day, expected in ((date(2026, 3, 31), date(2026, 2, 28)), (date(2028, 3, 31), date(2028, 2, 29)), (date(2026, 1, 15), date(2025, 12, 15)),
                              (date(2026, 5, 31), date(2026, 4, 30)), (date(2026, 10, 27), date(2026, 9, 27)), (date(2026, 12, 31), date(2026, 11, 30)),
                              (date(2026, 3, 1), date(2026, 2, 1))):
            with self.subTest(day=day):
                self.assertEqual(month_before(day), expected)

    def test_company_match_builds_a_query_and_a_title_test(self):
        cases = (
            ("Toyota Motor Corporation", "7203.T", "Toyota Motor", ["Toyota lifts forecast", "Why TOYOTA is cutting output", "Toyota Motor shares jump"],
             ["Lithia & Driveway Q3 results", "Toyotas everywhere", "Motor trend"]),
            ("SAP SE", "SAP.DE", "SAP", ["SAP raises outlook", "Results from SAP: strong", "SAP's cloud push"], ["How to tap maple sap", "Sap flows early", "SAPPHIRE shines"]),
            ("Vodafone Group Plc", "VOD.L", "Vodafone Group", ["Vodafone sells unit"], ["Voda phone"]),
            ("The Coca-Cola Company", "KO", "Coca-Cola", ["Coca-Cola raises prices", "COCA-COLA beats"], ["Cocoa prices fall"]),
            ("Nestlé S.A.", "NESN.SW", "Nestlé", ["Nestle posts sales", "Nestlé posts sales"], ["Nest egg"]),
            ("Standard Chartered PLC", "STAN.L", "Standard Chartered", ["Standard Chartered cuts forecast"], ["Standard life", "Chartered accountants"]),
            ("Bank of America Corporation", "BAC", "Bank of America", ["Bank of America reports profit"], ["Bank of Canada holds rates", "America's banks"]),
            ("Rio Tinto plc", "RIO.L", "Rio Tinto", ["Rio Tinto output rises"], ["Rio de Janeiro floods", "Tinto wine"]),
            ("HSBC Holdings plc", "HSBA.L", "HSBC Holdings", ["HSBC to cut jobs", "Hsbc results"], ["Holdings rise"]),
            ("Hong Kong Exchanges and Clearing Ltd", "0388.HK", "Hong Kong Exchanges", ["Hong Kong Exchanges and Clearing profit rises"], ["Hong Kong stocks rally"]),
            ("Royal Bank of Canada", "RY.TO", "Royal Bank", ["Royal Bank of Canada earnings"], ["Royal wedding"]),
            ("Procter & Gamble Co.", "PG", "Procter & Gamble", ["Procter and Gamble raises prices", "Procter & Gamble earnings"], ["Gamble on tech"]),
        )
        for name, ticker, query, matching, other in cases:
            match = company_match(name, ticker)
            with self.subTest(name=name):
                self.assertEqual(match.query, query)
                for title in matching:
                    self.assertTrue(match(title), title)
                for title in other:
                    self.assertFalse(match(title), title)

    def test_company_match_refuses_names_that_cannot_identify_a_company(self):
        for name, ticker in ((None, "X"), ("", "X"), ("   ", "X"), (5, "X"), ("BP p.l.c.", "BP.L"), ("3M Company", "MMM"), ("SAP", "SAP"), ("Group", "X"),
                             ("The Holdings Inc.", "X"), ("Inc", "X")):
            with self.subTest(name=name):
                self.assertIsNone(company_match(name, ticker))
        self.assertFalse(company_match("Toyota Motor", "7203.T")(None))


class SectorMoveTests(unittest.TestCase):
    def test_period_moves(self):
        chart = chart_of({"2025-12-30": 80.0, "2025-12-31": 90.0, "2026-09-25": 96.0, "2026-10-20": 99.0, "2026-10-26": 100.0, "2026-10-27": 102.0})
        move = sector_move("XLE", chart)
        self.assertEqual(set(move), {"proxy", "proxy_name", "currency", "as_of", "d1", "w1", "m1", "ytd"})
        self.assertEqual((move["proxy"], move["proxy_name"], move["currency"], move["as_of"]), ("XLE", "Test Fund", "USD", "2026-10-27"))
        self.assertAlmostEqual(move["d1"], 102 / 100 - 1)
        self.assertAlmostEqual(move["w1"], 102 / 99 - 1)
        self.assertAlmostEqual(move["m1"], 102 / 96 - 1)  # 2026-09-27 is a Sunday, so the Friday before is the base
        self.assertAlmostEqual(move["ytd"], 102 / 90 - 1)

    def test_ytd_uses_the_last_close_on_or_before_december_31(self):
        move = sector_move("XLE", chart_of({"2025-12-30": 90.0, "2026-01-02": 200.0, "2026-10-27": 99.0}))
        self.assertAlmostEqual(move["ytd"], 99 / 90 - 1)

    def test_adjusted_close_is_used_not_close(self):
        records = [{"date": "2026-10-26", "close": 500.0, "adjusted_close": 100.0}, {"date": "2026-10-27", "close": 1.0, "adjusted_close": 110.0}]
        self.assertAlmostEqual(sector_move("XLE", {"records": records})["d1"], 0.1)

    def test_month_end_compares_with_the_clamped_day(self):
        non_leap = chart_of({"2025-12-31": 40.0, "2026-02-27": 50.0, "2026-03-02": 1000.0, "2026-03-24": 52.0, "2026-03-30": 55.0, "2026-03-31": 60.0})
        move = sector_move("XLE", non_leap)
        self.assertAlmostEqual(move["m1"], 60 / 50 - 1)
        self.assertAlmostEqual(move["w1"], 60 / 52 - 1)
        self.assertAlmostEqual(move["d1"], 60 / 55 - 1)
        self.assertAlmostEqual(move["ytd"], 60 / 40 - 1)
        leap = chart_of({"2027-12-31": 40.0, "2028-02-28": 10.0, "2028-02-29": 70.0, "2028-03-01": 1000.0, "2028-03-30": 79.0, "2028-03-31": 80.0})
        self.assertAlmostEqual(sector_move("XLE", leap)["m1"], 80 / 70 - 1)

    def test_insufficient_history_gives_null_periods(self):
        move = sector_move("XLE", chart_of({"2026-10-22": 100.0, "2026-10-23": 101.0, "2026-10-26": 102.0, "2026-10-27": 103.0}))
        self.assertAlmostEqual(move["d1"], 103 / 102 - 1)
        for key in ("w1", "m1", "ytd"):
            self.assertIsNone(move[key], key)
        single = sector_move("XLE", chart_of({"2026-10-27": 100.0}))
        self.assertEqual([single[key] for key in ("d1", "w1", "m1", "ytd")], [None] * 4)
        self.assertEqual(single["as_of"], "2026-10-27")

    def test_gaps_and_invalid_closes_are_skipped(self):
        records = [
            {"date": "2026-10-22", "adjusted_close": 100.0}, {"date": "2026-10-23", "adjusted_close": 100.0},
            {"date": "2026-10-24", "adjusted_close": None}, {"date": "2026-10-25", "adjusted_close": 0}, {"date": "2026-10-25", "adjusted_close": -5.0},
            {"date": "2026-10-25", "adjusted_close": float("nan")}, {"date": "2026-10-25", "adjusted_close": float("inf")},
            {"date": "2026-10-25", "adjusted_close": True}, {"date": "2026-10-25", "adjusted_close": "101"}, {"date": "not-a-date", "adjusted_close": 7.0},
            None, "row", {"date": "2026-10-26"}, {"date": "2026-10-26", "adjusted_close": None},
            {"date": "2026-10-27", "adjusted_close": 105.0}, {"date": "2026-10-28", "adjusted_close": None},
        ]
        move = sector_move("XLE", {"records": records})
        self.assertEqual(move["as_of"], "2026-10-27")
        self.assertAlmostEqual(move["d1"], 0.05)

    def test_stale_comparison_closes_are_not_stretched(self):
        move = sector_move("XLE", chart_of({"2026-10-01": 100.0, "2026-10-27": 110.0}))
        self.assertEqual([move[key] for key in ("d1", "w1", "m1", "ytd")], [None] * 4)

    def test_comparison_close_may_be_at_most_five_days_before_its_target(self):
        edge = sector_move("XLE", chart_of({"2026-10-15": 100.0, "2026-10-27": 110.0}))
        self.assertAlmostEqual(edge["w1"], 0.1)
        beyond = sector_move("XLE", chart_of({"2026-10-14": 100.0, "2026-10-27": 110.0}))
        self.assertIsNone(beyond["w1"])
        self.assertIsNone(edge["d1"])

    def test_unusable_histories_raise(self):
        for chart in (None, {}, {"records": "x"}, {"records": []}, {"records": [{"date": "2026-10-27", "adjusted_close": None}]},
                      {"records": [{"date": "bad", "adjusted_close": 5.0}]}):
            with self.subTest(chart=str(chart)[:40]), self.assertRaises(ValueError):
                sector_move("XLE", chart)

    def test_label_fallbacks(self):
        move = sector_move("IXC", {"records": [{"date": "2026-10-27", "adjusted_close": 10.0}], "name": "  ", "currency": None})
        self.assertEqual((move["proxy_name"], move["currency"]), ("IXC", "Not reported"))


class ConstructionTests(ServiceTestCase):
    def test_refresh_hours_must_be_a_positive_number(self):
        for value in (0, -1, float("nan"), float("inf"), True, "3", None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                NewsService(self.store, self.market, refresh_hours=value)

    def test_construction_is_idempotent_and_data_survives_new_instances(self):
        first = self.service()
        first.refresh_sectors()
        second = self.service()
        self.assertEqual(second.sector_board(), first.sector_board())
        self.assertEqual(second.status(), first.status())
        tables = {row["name"] for row in self.rows("SELECT name FROM sqlite_master WHERE type = 'table'")}
        self.assertTrue({"news_items", "news_queries", "sector_moves", "news_meta"} <= tables)

    def test_default_clock_is_timezone_aware_utc(self):
        service = NewsService(self.store, self.market)
        self.addCleanup(service.stop)
        self.assertEqual(service.sector_board()["sectors"][0]["headlines"], [])
        self.assertEqual(service._now().utcoffset(), timedelta(0))


class RefreshTests(ServiceTestCase):
    def test_refresh_stores_moves_and_headlines_for_every_sector(self):
        service = self.service()
        result = service.refresh_sectors()
        self.assertEqual(result["status"], "refreshed")
        self.assertEqual((result["sectors_refreshed"], result["sectors_failed"], result["errors"]), (11, 0, {}))
        self.assertEqual((result["items_stored"], result["items_rejected"]), (44, 0))
        self.assertEqual((result["refreshed_at"], result["next_refresh_at"]), ("2026-10-28T15:00:00Z", "2026-10-28T18:00:00Z"))
        self.assertIsNone(result["last_error"])
        self.assertFalse(result["refreshing"])
        for sector, brief in zip(SECTORS, service.sector_board()["sectors"]):
            self.assertEqual((brief["id"], brief["name"]), (sector["id"], sector["name"]))
            self.assertEqual((brief["us"]["proxy"], brief["global"]["proxy"]), (sector["us"], sector["global"]))
            self.assertEqual({story["id"] for story in brief["headlines"]},
                             {f"{sector['us']}-1", f"{sector['us']}-2", f"{sector['global']}-1", f"{sector['global']}-2"})
            for story in brief["headlines"]:
                self.assertEqual(story["sectors"], [sector["id"]])

    def test_provider_calls_per_sector(self):
        self.service().refresh_sectors()
        expected = []
        for sector in SECTORS:
            expected += [("chart", sector["us"], "1y", True), ("chart", sector["global"], "1y", True),
                         search_call(sector["us"]), search_call(sector["global"])]
        self.assertEqual(self.market.calls, expected)

    def test_provider_calls_are_spaced(self):
        self.service(request_spacing=0.35).refresh_sectors()
        self.assertEqual(self.sleeps, [0.35] * 43)
        self.sleeps.clear()
        self.service(request_spacing=0).refresh_sectors(force=True)
        self.assertEqual(self.sleeps, [])

    def test_one_failing_sector_does_not_abort_the_others(self):
        self.market.charts["XLE"] = MarketUnavailable("Yahoo Finance is unavailable (HTTP 503).")
        self.market.news["IXG"] = MarketUnavailable("timed out")
        service = self.service()
        result = service.refresh_sectors()
        self.assertEqual((result["status"], result["sectors_refreshed"], result["sectors_failed"]), ("refreshed", 9, 2))
        self.assertEqual(result["errors"], {"energy": ["XLE prices: Yahoo Finance is unavailable (HTTP 503)."], "financials": ["IXG news: timed out"]})
        self.assertEqual(result["last_error"], "2 of 11 sectors could not be refreshed: Energy (XLE prices: Yahoo Finance is unavailable (HTTP 503).); "
                                               "Financials (IXG news: timed out)")
        self.assertEqual(result["refreshed_at"], "2026-10-28T15:00:00Z")
        self.assertEqual(len(self.market.calls), 44)
        board = service.sector_board()
        self.assertEqual(board["last_error"], result["last_error"])
        energy = self.sector(board, "energy")
        self.assertIsNone(energy["us"])
        self.assertEqual(energy["global"]["proxy"], "IXC")
        self.assertEqual(len(energy["headlines"]), 4)
        self.assertEqual(len(self.sector(board, "utilities")["headlines"]), 4)

    def test_a_failed_step_keeps_the_previous_value_and_says_so(self):
        service = self.service()
        service.refresh_sectors()
        before = self.sector(service.sector_board(), "energy")["us"]
        self.clock.advance(days=1, hours=1)
        self.market.charts["XLE"] = MarketUnavailable("boom")
        service.refresh_sectors()
        board = service.sector_board()
        self.assertEqual(self.sector(board, "energy")["us"], before)
        self.assertEqual(self.sector(board, "energy")["global"]["as_of"], "2026-10-28")
        self.assertEqual(self.sector(board, "utilities")["us"]["as_of"], "2026-10-28")
        self.assertEqual(before["as_of"], "2026-10-27")
        self.assertEqual(board["last_error"], "1 of 11 sectors could not be refreshed: Energy (XLE prices: boom)")

    def test_total_failure_is_reported_and_not_marked_fresh(self):
        self.fail_everything()
        service = self.service()
        result = service.refresh_sectors()
        self.assertEqual((result["status"], result["sectors_refreshed"], result["sectors_failed"]), ("failed", 0, 11))
        self.assertIsNone(result["refreshed_at"])
        self.assertIsNone(result["next_refresh_at"])
        self.assertEqual(result["last_error"], "11 of 11 sectors could not be refreshed: Communication Services (XLC prices: offline); "
                                               "Consumer Discretionary (XLY prices: offline); Consumer Staples (XLP prices: offline); and 8 more")
        board = service.sector_board()
        self.assertIsNone(board["refreshed_at"])
        self.assertEqual(board["last_error"], result["last_error"])
        for brief in board["sectors"]:
            self.assertEqual((brief["us"], brief["global"], brief["headlines"]), (None, None, []))
        self.assertEqual(service.refresh_sectors()["status"], "failed")  # never skipped as "fresh"
        self.assertEqual(len(self.market.calls), 88)

    def test_total_failure_keeps_the_previous_success_time_and_a_clean_run_clears_the_error(self):
        service = self.service()
        first = service.refresh_sectors()
        self.clock.advance(hours=1)
        self.fail_everything()
        second = service.refresh_sectors(force=True)
        self.assertEqual(second["status"], "failed")
        self.assertEqual(second["refreshed_at"], first["refreshed_at"])
        self.assertTrue(second["last_error"].startswith("11 of 11 sectors could not be refreshed"))
        self.assertEqual(self.sector(service.sector_board(), "energy")["us"]["as_of"], "2026-10-27")
        self.market.charts.clear()
        self.market.news.clear()
        self.clock.advance(hours=1)
        third = service.refresh_sectors(force=True)
        self.assertEqual(third["status"], "refreshed")
        self.assertIsNone(third["last_error"])
        self.assertEqual(third["refreshed_at"], "2026-10-28T17:00:00Z")

    def test_unexpected_errors_are_recorded_not_raised(self):
        self.market.charts["XLK"] = KeyError("boom")
        with self.assertLogs("backend.news", "WARNING"):
            result = self.service().refresh_sectors()
        self.assertEqual((result["status"], result["sectors_failed"]), ("refreshed", 1))
        self.assertEqual(result["errors"]["information_technology"], ["XLK prices: unexpected KeyError: 'boom'"])

    def test_malformed_provider_payloads_are_reported(self):
        self.market.news["XLY"] = {"oops": True}
        self.market.news["XLP"] = {"news": "not a list"}
        self.market.charts["XLV"] = {"records": "nope"}
        self.market.charts["EXI"] = {"records": [{"date": "2026-10-27", "adjusted_close": None}]}
        result = self.service().refresh_sectors()
        self.assertEqual(result["errors"], {
            "consumer_discretionary": ["XLY news: Yahoo Finance returned news in an unexpected format."],
            "consumer_staples": ["XLP news: Yahoo Finance returned news in an unexpected format."],
            "health_care": ["XLV prices: the price history has an unexpected format."],
            "industrials": ["EXI prices: no valid adjusted closes are available."],
        })

    def test_rejected_stories_are_counted_and_never_stored(self):
        bad_link = raw_story("bad", "Click here", 30)
        bad_link["link"] = "javascript:alert(1)"
        self.market.news["XLE"] = [raw_story("good", "Oil steadies", 30, ["XOM"]), bad_link, "not a story",
                                   {"uuid": "t", "title": "No time", "link": "https://example.com/t"}]
        result = self.service().refresh_sectors()
        self.assertEqual((result["items_rejected"], result["items_stored"]), (3, 43))
        ids = {row["id"] for row in self.rows("SELECT id FROM news_items")}
        self.assertIn("good", ids)
        self.assertNotIn("bad", ids)

    def test_fresh_data_is_not_refreshed_again(self):
        service = self.service()
        first = service.refresh_sectors()
        calls = len(self.market.calls)
        skipped = service.refresh_sectors()
        self.assertEqual((skipped["status"], skipped["reason"]), ("skipped", FRESH_REASON))
        self.assertEqual(skipped["refreshed_at"], first["refreshed_at"])
        self.clock.advance(hours=2, minutes=59, seconds=59)
        self.assertEqual(service.refresh_sectors()["status"], "skipped")
        self.assertEqual(len(self.market.calls), calls)
        self.clock.advance(seconds=1)
        self.assertEqual(service.refresh_sectors()["status"], "refreshed")
        self.assertEqual(len(self.market.calls), calls * 2)

    def test_force_refreshes_fresh_data(self):
        service = self.service()
        service.refresh_sectors()
        self.assertEqual(service.refresh_sectors(force=True)["status"], "refreshed")
        self.assertEqual(len(self.market.calls), 88)

    def test_custom_interval_controls_freshness(self):
        service = self.service(refresh_hours=0.5)
        service.refresh_sectors()
        self.clock.advance(minutes=29)
        self.assertEqual(service.refresh_sectors()["status"], "skipped")
        self.clock.advance(minutes=1)
        self.assertEqual(service.refresh_sectors()["status"], "refreshed")
        self.assertEqual(service.status()["next_refresh_at"], "2026-10-28T16:00:00Z")

    def test_a_clock_that_moved_backwards_does_not_freeze_refreshes(self):
        service = self.service()
        service.refresh_sectors()
        self.clock.advance(hours=-2)
        self.assertEqual(service.refresh_sectors()["status"], "refreshed")

    def test_a_second_refresh_is_skipped_while_one_is_running(self):
        entered, release = threading.Event(), threading.Event()

        def hold(record):
            entered.set()
            release.wait(10)

        self.market.before_call = hold
        service = self.service()
        worker = threading.Thread(target=lambda: service.refresh_sectors(force=True))
        worker.start()
        try:
            self.assertTrue(entered.wait(5))
            self.assertTrue(service.status()["refreshing"])
            self.assertTrue(service.sector_board()["refreshing"])
            second = service.refresh_sectors(force=True)
            self.assertEqual((second["status"], second["reason"], second["refreshing"]), ("skipped", RUNNING_REASON, True))
        finally:
            release.set()
            worker.join(10)
        self.assertFalse(service.status()["refreshing"])
        self.assertEqual(service.status()["refreshed_at"], "2026-10-28T15:00:00Z")

    def test_the_running_flag_is_cleared_after_an_unexpected_failure(self):
        service = self.service()
        service._refresh = lambda force: 1 / 0
        with self.assertLogs("backend.news", "ERROR"):
            result = service.refresh_sectors()
        self.assertEqual(result["status"], "failed")
        self.assertFalse(result["refreshing"])
        self.assertIn("ZeroDivisionError", result["last_error"])
        self.assertIn("ZeroDivisionError", service.status()["last_error"])

    def test_stories_older_than_the_retention_window_are_purged(self):
        service = self.service()
        old, recent = NOW - timedelta(days=22), NOW - timedelta(days=20)
        with self.store.connect() as db:
            for story_id, moment in (("old", old), ("recent", recent)):
                db.execute("INSERT INTO news_items (id, title, publisher, url, published_at, fetched_at, tickers, sectors, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                           (story_id, "Title", "Pub", f"https://example.com/{story_id}", iso(moment), iso(moment), "[]", "[]", SOURCE))
                db.execute("INSERT INTO news_links (ticker, item_id, via) VALUES (?, ?, ?)", ("AAPL", story_id, "ticker"))
            db.execute("INSERT INTO news_queries (key, fetched_at) VALUES (?, ?)", ("ticker:OLD", iso(old)))
            db.execute("INSERT INTO news_queries (key, fetched_at) VALUES (?, ?)", ("ticker:RECENT", iso(recent)))
        service.refresh_sectors()
        ids = {row["id"] for row in self.rows("SELECT id FROM news_items")}
        self.assertNotIn("old", ids)
        self.assertIn("recent", ids)
        self.assertEqual([row["item_id"] for row in self.rows("SELECT item_id FROM news_links")], ["recent"])
        self.assertEqual([row["key"] for row in self.rows("SELECT key FROM news_queries")], ["ticker:RECENT"])
        self.assertEqual(len(ids), 45)  # the 44 fresh sector stories plus the one still inside the window

    def test_the_same_story_in_several_proxies_is_stored_once_with_merged_tags(self):
        shared_us = raw_story("shared", "Oil rises", 30, ["XOM", "CVX"])
        shared_global = raw_story("shared", "Oil rises sharply", 20, ["CVX", "SHEL"])
        multi = raw_story("multi", "Commodities rally", 40, ["BHP"])
        self.market.news["XLE"] = [shared_us, multi]
        self.market.news["IXC"] = [shared_global]
        self.market.news["XLB"] = [multi]
        service = self.service()
        service.refresh_sectors()
        shared = self.rows("SELECT * FROM news_items WHERE id = 'shared'")
        self.assertEqual(len(shared), 1)
        self.assertEqual(json.loads(shared[0]["tickers"]), ["XOM", "CVX", "SHEL"])
        self.assertEqual(json.loads(shared[0]["sectors"]), ["energy"])
        self.assertEqual((shared[0]["title"], shared[0]["published_at"]), ("Oil rises sharply", "2026-10-28T14:40:00Z"))
        self.assertEqual(json.loads(self.rows("SELECT sectors FROM news_items WHERE id = 'multi'")[0]["sectors"]), ["energy", "materials"])
        board = service.sector_board()
        for sector_id in ("energy", "materials"):
            self.assertIn("multi", [story["id"] for story in self.sector(board, sector_id)["headlines"]])

    def test_put_items_merges_tickers_and_sectors_in_taxonomy_order(self):
        service = self.service()
        first = normalise_item(raw_story("m", "First title", 30, ["AAA", "BBB"]), NOW, ["utilities"])
        second = normalise_item(raw_story("m", "Second title", 20, [f"C{index}" for index in range(12)]), NOW, ["energy"])
        with self.store.connect() as db:
            service._put_items(db, [first], "2026-10-28T15:00:00Z")
            service._put_items(db, [second], "2026-10-28T16:00:00Z")
        row = self.rows("SELECT * FROM news_items WHERE id = 'm'")[0]
        self.assertEqual(json.loads(row["sectors"]), ["energy", "utilities"])
        self.assertEqual(json.loads(row["tickers"]), ["AAA", "BBB"] + [f"C{index}" for index in range(10)])
        self.assertEqual((row["title"], row["published_at"], row["fetched_at"]), ("Second title", "2026-10-28T14:40:00Z", "2026-10-28T16:00:00Z"))


class BoardTests(ServiceTestCase):
    def test_board_before_any_refresh(self):
        board = self.service().sector_board()
        self.assertEqual(board["sectors"], [{"id": sector["id"], "name": sector["name"], "us": None, "global": None, "headlines": []} for sector in SECTORS])
        self.assertEqual({key: board[key] for key in board if key != "sectors"},
                         {"refreshed_at": None, "next_refresh_at": None, "refreshing": False, "last_error": None, "source": SOURCE})
        json.dumps(board, allow_nan=False)

    def test_board_shape_and_provenance(self):
        service = self.service(refresh_hours=1.5)
        service.refresh_sectors()
        board = service.sector_board()
        self.assertEqual(set(board), {"sectors", "refreshed_at", "next_refresh_at", "refreshing", "last_error", "source"})
        self.assertEqual((board["refreshed_at"], board["next_refresh_at"]), ("2026-10-28T15:00:00Z", "2026-10-28T16:30:00Z"))
        for sector, brief in zip(SECTORS, board["sectors"]):
            self.assertEqual(set(brief), {"id", "name", "us", "global", "headlines"})
            for scope in ("us", "global"):
                self.assertEqual(set(brief[scope]), {"proxy", "proxy_name", "currency", "as_of", "d1", "w1", "m1", "ytd"})
                self.assertEqual(brief[scope]["proxy"], sector[scope])
                self.assertEqual(brief[scope]["proxy_name"], f"{sector[scope]} Fund")
            for story in brief["headlines"]:
                self.assertEqual(set(story), {"id", "title", "publisher", "url", "published_at", "tickers", "sectors", "source"})
                self.assertEqual(story["source"], SOURCE)
        json.dumps(board, allow_nan=False)

    def test_headlines_are_newest_first_capped_and_limited_to_seven_days(self):
        self.market.news["XLE"] = [raw_story(f"e{index}", f"Energy story {index}", index * 30) for index in range(1, 9)]
        self.market.news["IXC"] = [raw_story("six-days", "Six days old", 6 * 1440 + 23 * 60), raw_story("eight-days", "Eight days old", 8 * 1440)]
        self.market.news["XLB"] = [raw_story("fresh", "Fresh", 10), raw_story("edge-in", "Edge in", 7 * 1440 - 1), raw_story("edge-out", "Edge out", 7 * 1440 + 60)]
        self.market.news["MXI"] = []
        service = self.service()
        service.refresh_sectors()
        board = service.sector_board()
        self.assertEqual([story["id"] for story in self.sector(board, "energy")["headlines"]], [f"e{index}" for index in range(1, 7)])
        self.assertEqual([story["id"] for story in self.sector(board, "materials")["headlines"]], ["fresh", "edge-in"])
        self.assertEqual(self.rows("SELECT COUNT(*) AS n FROM news_items WHERE id = 'eight-days'")[0]["n"], 1)  # hidden from the board, not deleted
        for brief in board["sectors"]:
            stamps = [story["published_at"] for story in brief["headlines"]]
            self.assertEqual(stamps, sorted(stamps, reverse=True))
            self.assertLessEqual(len(stamps), 6)

    def test_headlines_from_both_proxies_are_interleaved_by_time(self):
        self.market.news["XLE"] = [raw_story("us-10", "US ten", 10), raw_story("us-50", "US fifty", 50)]
        self.market.news["IXC"] = [raw_story("gl-30", "Global thirty", 30), raw_story("gl-70", "Global seventy", 70)]
        service = self.service()
        service.refresh_sectors()
        self.assertEqual([story["id"] for story in self.sector(service.sector_board(), "energy")["headlines"]], ["us-10", "gl-30", "us-50", "gl-70"])

    def test_repeated_headlines_are_shown_once(self):
        self.market.news["XLE"] = [
            raw_story("m1", "Sector Update: Energy", 10, publisher="MT Newswires"),
            raw_story("m2", "Sector Update: Energy", 100, publisher="MT Newswires"),
            raw_story("m3", "Sector Update: Energy", 200, publisher="Other Wire"),
            raw_story("dup1", "Title A", 20, link="https://example.com/same"),
            raw_story("dup2", "Title B", 25, link="https://example.com/same"),
        ]
        self.market.news["IXC"] = []
        service = self.service()
        service.refresh_sectors()
        self.assertEqual([story["id"] for story in self.sector(service.sector_board(), "energy")["headlines"]], ["m1", "dup1", "m3"])

    def test_board_reads_only_persisted_data(self):
        service = self.service()
        service.refresh_sectors()
        calls = len(self.market.calls)
        self.market.forbidden = True
        expected = service.sector_board()
        self.assertEqual(len(self.market.calls), calls)
        self.assertEqual(self.service().sector_board(), expected)

    def test_board_window_follows_the_clock(self):
        service = self.service()
        service.refresh_sectors()
        self.clock.advance(days=8)
        board = service.sector_board()
        self.assertTrue(all(brief["headlines"] == [] for brief in board["sectors"]))
        self.assertIsNotNone(self.sector(board, "energy")["us"])  # moves stay visible with their own as_of date

    def test_an_unreadable_stored_move_is_ignored(self):
        service = self.service()
        service.refresh_sectors()
        with self.store.connect() as db:
            db.execute("UPDATE sector_moves SET payload = ? WHERE sector_id = 'energy' AND scope = 'us'", ("{not json",))
        with self.assertLogs("backend.news", "WARNING"):
            board = service.sector_board()
        self.assertIsNone(self.sector(board, "energy")["us"])
        self.assertIsNotNone(self.sector(board, "energy")["global"])


class HoldingsTests(ServiceTestCase):
    def holdings(self, *tickers):
        return [{"ticker": ticker, "name": None} for ticker in tickers]

    def test_news_is_kept_only_when_the_ticker_is_listed_as_related(self):
        self.market.news["AAPL"] = [
            raw_story("a1", "Apple unveils new chip", 30, ["AAPL", "MSFT"]),
            raw_story("a2", "Chipmakers rally", 90, ["NVDA", "AMD"]),
            raw_story("a3", "Apple services revenue climbs", 150, ["aapl"]),
            raw_story("a4", "Lookalike symbols only", 200, ["AAPL.MX", "AAPLX", "XAAPL"]),
        ]
        service = self.service()
        result = service.holdings_news([{"ticker": "AAPL", "name": "Apple Inc."}])
        self.assertEqual([story["id"] for story in result["items"]], ["a1", "a3"])
        self.assertEqual(result["items"][0]["tickers"], ["AAPL", "MSFT"])
        self.assertEqual(result["by_ticker"], {"AAPL": ["a1", "a3"]})
        self.assertEqual((result["refreshed_at"], result["source"], result["warnings"]), ("2026-10-28T15:00:00Z", SOURCE, []))
        self.assertEqual(set(result), {"items", "by_ticker", "refreshed_at", "source", "warnings"})
        self.assertEqual(self.market.calls, [search_call("AAPL")])
        self.assertEqual({row["id"] for row in self.rows("SELECT id FROM news_items")}, {"a1", "a3"})
        json.dumps(result, allow_nan=False)

    def test_tickers_are_normalised_deduplicated_and_unsafe_stories_dropped(self):
        unsafe = raw_story("u1", "Unsafe link", 10, ["AAPL"])
        unsafe["link"] = "javascript:alert(1)"
        self.market.news["AAPL"] = [raw_story("a1", "Apple news", 30, ["AAPL"]), unsafe]
        result = self.service().holdings_news([{"ticker": " aapl "}, {"ticker": "AAPL", "name": "Apple"}, {"ticker": "Aapl", "name": "Other"}])
        self.assertEqual(list(result["by_ticker"]), ["AAPL"])
        self.assertEqual([story["id"] for story in result["items"]], ["a1"])
        self.assertEqual(len(self.market.calls), 1)

    def test_items_are_newest_first_and_shared_stories_are_listed_once(self):
        shared = raw_story("shared", "Apple and Microsoft partner", 20, ["AAPL", "MSFT"])
        self.market.news["AAPL"] = [raw_story("a-old", "Older Apple note", 300, ["AAPL"]), shared]
        self.market.news["MSFT"] = [shared, raw_story("m-new", "Microsoft note", 5, ["MSFT"])]
        result = self.service().holdings_news(self.holdings("AAPL", "MSFT"))
        self.assertEqual([story["id"] for story in result["items"]], ["m-new", "shared", "a-old"])
        self.assertEqual(result["by_ticker"], {"AAPL": ["shared", "a-old"], "MSFT": ["m-new", "shared"]})

    def test_the_same_headline_under_two_tickers_is_collapsed(self):
        self.market.news["AAPL"] = [raw_story("x1", "Tech stocks slide", 10, ["AAPL"], publisher="Wire")]
        self.market.news["MSFT"] = [raw_story("x2", "Tech stocks slide", 20, ["MSFT"], publisher="wire")]
        result = self.service().holdings_news(self.holdings("AAPL", "MSFT"))
        self.assertEqual([story["id"] for story in result["items"]], ["x1"])
        self.assertEqual(result["by_ticker"], {"AAPL": ["x1"], "MSFT": ["x1"]})

    def test_exchange_suffixed_tickers_fall_back_to_a_company_name_search(self):
        self.market.news["7203.T"] = []
        self.market.news["Toyota Motor"] = [
            raw_story("t1", "Toyota lifts annual profit forecast", 20, ["TM"]),
            raw_story("t2", "Lithia & Driveway Q3 results", 40, ["LAD", "TM"]),
            raw_story("t3", "TOYOTA and Honda race to build EV batteries", 60, ["TM", "HMC"]),
        ]
        result = self.service().holdings_news([{"ticker": "7203.T", "name": "Toyota Motor Corporation"}])
        self.assertEqual([story["id"] for story in result["items"]], ["t1", "t3"])
        self.assertEqual(result["by_ticker"], {"7203.T": ["t1", "t3"]})
        self.assertEqual(result["warnings"], ["7203.T: 0 headlines are filed under this symbol; 2 more were matched because their titles "
                                              "mention “Toyota”. Check that they concern this listing."])
        self.assertEqual(self.market.calls, [search_call("7203.T"), search_call("Toyota Motor")])
        self.assertNotIn("t2", {row["id"] for row in self.rows("SELECT id FROM news_items")})

    def test_the_name_search_only_tops_up_when_fewer_than_two_stories_match_the_ticker(self):
        self.market.news["VOD.L"] = [raw_story("v1", "Vodafone one", 10, ["VOD.L", "VOD"])]
        self.market.news["Vodafone Group"] = [raw_story("v2", "Vodafone sells unit", 30, ["VOD"]), raw_story("v3", "Telecom roundup", 50, ["VOD"])]
        result = self.service().holdings_news([{"ticker": "VOD.L", "name": "Vodafone Group Plc"}])
        self.assertEqual(result["by_ticker"], {"VOD.L": ["v1", "v2"]})
        self.assertEqual(result["warnings"], ["VOD.L: 1 headline is filed under this symbol; 1 more was matched because its title "
                                              "mentions “Vodafone”. Check that it concerns this listing."])
        self.assertEqual(self.market.queries, ["VOD.L", "Vodafone Group"])

    def test_no_name_search_when_two_stories_already_match_the_ticker(self):
        self.market.news["7203.T"] = [raw_story("j1", "Toyota one", 10, ["7203.T"]), raw_story("j2", "Toyota two", 20, ["7203.T"])]
        result = self.service().holdings_news([{"ticker": "7203.T", "name": "Toyota Motor Corporation"}])
        self.assertEqual(self.market.queries, ["7203.T"])
        self.assertEqual((result["by_ticker"], result["warnings"]), ({"7203.T": ["j1", "j2"]}, []))

    def test_us_tickers_never_trigger_a_name_search(self):
        result = self.service().holdings_news([{"ticker": "AAPL", "name": "Apple Inc."}])
        self.assertEqual(self.market.queries, ["AAPL"])
        self.assertEqual((result["items"], result["by_ticker"], result["warnings"]), ([], {"AAPL": []}, ["AAPL: no recent headlines were found."]))

    def test_acronym_names_match_whole_upper_case_words_only(self):
        self.market.news["SAP"] = [
            raw_story("s1", "SAP raises cloud outlook", 10, ["SAP"]), raw_story("s2", "How to tap maple sap in spring", 20, ["SAP"]),
            raw_story("s3", "SAPPHIRE shines", 30, ["XYZ"]), raw_story("s4", "Sap flows early this year", 40, ["XYZ"]),
        ]
        result = self.service().holdings_news([{"ticker": "SAP.DE", "name": "SAP SE"}])
        self.assertEqual([story["id"] for story in result["items"]], ["s1"])
        self.assertEqual(self.market.queries, ["SAP.DE", "SAP"])

    def test_missing_or_generic_names_are_disclosed_instead_of_searched(self):
        service = self.service()
        result = service.holdings_news([{"ticker": "7203.T", "name": None}, {"ticker": "0001.HK", "name": "Holdings Inc."}])
        self.assertEqual(self.market.queries, ["7203.T", "0001.HK"])
        self.assertEqual(result["warnings"], [
            "7203.T: Yahoo Finance files few headlines under exchange-suffixed symbols and no company name was supplied for a name search.",
            "7203.T: no recent headlines were found.",
            "0001.HK: Yahoo Finance files few headlines under exchange-suffixed symbols and the company name is too generic to search safely.",
            "0001.HK: no recent headlines were found.",
        ])

    def test_a_failed_name_search_is_a_warning(self):
        self.market.news["Toyota Motor"] = MarketUnavailable("timed out")
        result = self.service().holdings_news([{"ticker": "7203.T", "name": "Toyota Motor Corporation"}])
        self.assertEqual(result["warnings"], ["7203.T: the company-name search for “Toyota Motor” failed (timed out).", "7203.T: no recent headlines were found."])
        self.assertEqual(result["refreshed_at"], "2026-10-28T15:00:00Z")

    def test_name_matches_are_dropped_once_the_ticker_has_its_own_stories(self):
        self.market.news["Toyota Motor"] = [raw_story("n1", "Toyota expands", 30, ["TM"]), raw_story("n2", "Toyota recalls", 40, ["TM"])]
        service = self.service()
        holding = [{"ticker": "7203.T", "name": "Toyota Motor Corporation"}]
        self.assertEqual(service.holdings_news(holding)["by_ticker"], {"7203.T": ["n1", "n2"]})
        self.clock.advance(minutes=31)
        self.market.news["7203.T"] = [raw_story("j1", "Toyota one", 10, ["7203.T"]), raw_story("j2", "Toyota two", 20, ["7203.T"])]
        again = service.holdings_news(holding)
        self.assertEqual((again["by_ticker"], again["warnings"]), ({"7203.T": ["j1", "j2"]}, []))

    def test_queries_are_cached_for_thirty_minutes(self):
        self.market.news["AAPL"] = [raw_story("a1", "Apple news", 30, ["AAPL"])]
        service = self.service()
        first = service.holdings_news(self.holdings("AAPL"))
        self.clock.advance(minutes=29, seconds=59)
        second = service.holdings_news(self.holdings("AAPL"))
        self.assertEqual(second, first)
        self.assertEqual(second["refreshed_at"], "2026-10-28T15:00:00Z")  # when it was fetched, not when it was asked for
        self.assertEqual(len(self.market.calls), 1)
        self.clock.advance(seconds=1)
        third = service.holdings_news(self.holdings("AAPL"))
        self.assertEqual(len(self.market.calls), 2)
        self.assertEqual(third["refreshed_at"], "2026-10-28T15:30:00Z")

    def test_refresh_flag_bypasses_the_cache(self):
        service = self.service()
        service.holdings_news(self.holdings("AAPL"))
        service.holdings_news(self.holdings("AAPL"))
        self.assertEqual(len(self.market.calls), 1)
        service.holdings_news(self.holdings("AAPL"), refresh=True)
        self.assertEqual(len(self.market.calls), 2)

    def test_only_uncached_tickers_are_queried(self):
        service = self.service()
        service.holdings_news(self.holdings("AAPL"))
        self.clock.advance(minutes=5)
        result = service.holdings_news(self.holdings("AAPL", "MSFT"))
        self.assertEqual(self.market.queries, ["AAPL", "MSFT"])
        self.assertEqual(result["refreshed_at"], "2026-10-28T15:05:00Z")

    def test_cached_name_searches_are_reused(self):
        self.market.news["Toyota Motor"] = [raw_story("t1", "Toyota news", 30, ["TM"])]
        service = self.service()
        holding = [{"ticker": "7203.T", "name": "Toyota Motor Corporation"}]
        first = service.holdings_news(holding)
        self.assertEqual(len(self.market.calls), 2)
        self.assertEqual(service.holdings_news(holding), first)
        self.assertEqual(len(self.market.calls), 2)
        service.holdings_news(holding, refresh=True)
        self.assertEqual(len(self.market.calls), 4)

    def test_a_failed_query_is_a_warning_not_an_exception(self):
        self.market.news["AAPL"] = [raw_story("a1", "Apple news", 30, ["AAPL"])]
        self.market.news["MSFT"] = MarketUnavailable("Yahoo Finance is unavailable (HTTP 503).")
        result = self.service().holdings_news(self.holdings("AAPL", "MSFT"))
        self.assertEqual(result["by_ticker"], {"AAPL": ["a1"], "MSFT": []})
        self.assertEqual(result["warnings"], ["MSFT: news could not be refreshed (Yahoo Finance is unavailable (HTTP 503)). No saved headlines are available."])
        self.assertEqual(result["refreshed_at"], "2026-10-28T15:00:00Z")

    def test_saved_headlines_are_labelled_when_a_refresh_fails(self):
        self.market.news["AAPL"] = [raw_story("a1", "Apple news", 30, ["AAPL"]), raw_story("a3", "More Apple news", 90, ["AAPL"])]
        self.market.news["MSFT"] = [raw_story("m1", "Microsoft news", 30, ["MSFT"])]
        service = self.service()
        service.holdings_news(self.holdings("AAPL"))
        self.clock.advance(hours=1)
        self.market.news["AAPL"] = MarketUnavailable("timed out")
        result = service.holdings_news(self.holdings("AAPL", "MSFT"))
        self.assertEqual(result["by_ticker"], {"AAPL": ["a1", "a3"], "MSFT": ["m1"]})
        self.assertEqual(result["warnings"], ["AAPL: news could not be refreshed (timed out). Showing 2 headline(s) saved at 2026-10-28T15:00:00Z."])
        self.assertEqual(result["refreshed_at"], "2026-10-28T16:00:00Z")

    def test_everything_failing_with_saved_data_returns_it_with_the_old_timestamp(self):
        self.market.news["AAPL"] = [raw_story("a1", "Apple news", 30, ["AAPL"])]
        service = self.service()
        service.holdings_news(self.holdings("AAPL"))
        self.clock.advance(hours=2)
        self.market.news["AAPL"] = MarketUnavailable("offline")
        result = service.holdings_news(self.holdings("AAPL"))
        self.assertEqual((result["by_ticker"], result["refreshed_at"]), ({"AAPL": ["a1"]}, "2026-10-28T15:00:00Z"))
        self.assertEqual(len(result["warnings"]), 1)

    def test_everything_failing_without_saved_data_raises(self):
        self.market.news["AAPL"] = MarketUnavailable("Yahoo Finance is unavailable (HTTP 503).")
        self.market.news["MSFT"] = MarketUnavailable("timed out")
        with self.assertRaises(MarketUnavailable) as caught:
            self.service().holdings_news(self.holdings("AAPL", "MSFT"))
        self.assertIn("Yahoo Finance is unavailable (HTTP 503)", str(caught.exception))
        self.assertIn("no headlines were substituted", str(caught.exception))

    def test_unsupported_tickers_are_warnings_and_do_not_trip_the_breaker(self):
        for ticker in ("A1", "B1", "C1", "D1"):
            self.market.news[ticker] = UnsupportedAsset("not found")
        self.market.news["E1"] = [raw_story("e1", "E news", 30, ["E1"])]
        result = self.service().holdings_news(self.holdings("A1", "B1", "C1", "D1", "E1"))
        self.assertEqual(self.market.queries, ["A1", "B1", "C1", "D1", "E1"])
        self.assertEqual(result["by_ticker"]["E1"], ["e1"])
        self.assertEqual(len(result["warnings"]), 4)

    def test_a_run_of_provider_failures_stops_further_queries(self):
        self.market.news["A1"] = [raw_story("a1", "A news", 30, ["A1"])]
        for ticker in ("B1", "C1", "D1"):
            self.market.news[ticker] = MarketUnavailable("timed out")
        result = self.service().holdings_news(self.holdings("A1", "B1", "C1", "D1", "E1"))
        self.assertEqual(self.market.queries, ["A1", "B1", "C1", "D1"])
        self.assertEqual(result["by_ticker"]["A1"], ["a1"])
        self.assertIn("E1: news could not be refreshed (not queried because 3 provider requests in a row failed). No saved headlines are available.",
                      result["warnings"])

    def test_a_success_resets_the_failure_run(self):
        for ticker in ("B1", "C1", "E1", "F1"):
            self.market.news[ticker] = MarketUnavailable("timed out")
        result = self.service().holdings_news(self.holdings("B1", "C1", "D1", "E1", "F1"))
        self.assertEqual(self.market.queries, ["B1", "C1", "D1", "E1", "F1"])
        self.assertEqual(len(result["warnings"]), 5)

    def test_up_to_25_holdings_are_accepted_and_paced(self):
        result = self.service().holdings_news(self.holdings(*[f"T{index}" for index in range(25)]))
        self.assertEqual(len(result["by_ticker"]), 25)
        self.assertEqual(len(self.market.calls), 25)
        self.assertEqual(self.sleeps, [0.35] * 24)
        self.assertEqual(result["warnings"], [f"T{index}: no recent headlines were found." for index in range(25)])

    def test_invalid_input_is_rejected_before_any_request(self):
        invalid = (
            [], "AAPL", None, {"ticker": "AAPL"}, [None], ["AAPL"], [{"ticker": 5}], [{"name": "Apple"}], [{"ticker": ""}], [{"ticker": "A B"}],
            [{"ticker": "javascript:"}], [{"ticker": "X" * 26}], [{"ticker": "ß"}], [{"ticker": "ＡＡＰＬ"}], [{"ticker": "😀"}], [{"ticker": "AAPL", "name": 5}],
            self.holdings(*[f"T{index}" for index in range(26)]), [{"ticker": "AAPL"}] * 26,
        )
        service = self.service()
        for holdings in invalid:
            with self.subTest(holdings=str(holdings)[:40]), self.assertRaises(ValueError):
                service.holdings_news(holdings)
        self.assertEqual(self.market.calls, [])

    def test_later_duplicates_may_supply_the_missing_name(self):
        self.market.news["Toyota Motor"] = [raw_story("t1", "Toyota news", 30, ["TM"])]
        result = self.service().holdings_news([{"ticker": "7203.T"}, {"ticker": "7203.t", "name": "Toyota Motor Corporation"}])
        self.assertEqual(self.market.queries, ["7203.T", "Toyota Motor"])
        self.assertEqual(result["by_ticker"], {"7203.T": ["t1"]})

    def test_the_response_is_capped_at_forty_items_shared_fairly_between_holdings(self):
        tickers = [f"T{index}" for index in range(25)]
        for index, ticker in enumerate(tickers):
            self.market.news[ticker] = [raw_story(f"{ticker}-{n}", f"Story {index} {n}", n * 10 + index, [ticker]) for n in range(10)]
        result = self.service().holdings_news(self.holdings(*tickers))
        self.assertEqual(len(result["items"]), 40)
        shown = {story["id"] for story in result["items"]}
        self.assertEqual(sum(len(ids) for ids in result["by_ticker"].values()), 40)
        self.assertTrue(all(ids and set(ids) <= shown for ids in result["by_ticker"].values()))
        stamps = [story["published_at"] for story in result["items"]]
        self.assertEqual(stamps, sorted(stamps, reverse=True))

    def test_stories_past_the_retention_window_are_not_returned(self):
        self.market.news["AAPL"] = [raw_story("a1", "Apple news", 30, ["AAPL"])]
        service = self.service()
        service.holdings_news(self.holdings("AAPL"))
        self.clock.advance(days=22)
        self.market.news["AAPL"] = MarketUnavailable("offline")
        with self.assertRaises(MarketUnavailable):  # the saved story has expired and the refresh failed, so nothing honest is left to show
            service.holdings_news(self.holdings("AAPL"))


class RequestRefreshTests(ServiceTestCase):
    def test_start_then_running_then_skipped_then_start_again(self):
        service = self.service()
        entered, release, calls = threading.Event(), threading.Event(), []

        def slow(force=False):
            calls.append(force)
            entered.set()
            release.wait(10)
            return {"status": "refreshed"}

        service.refresh_sectors = slow
        first = service.request_refresh()
        self.assertEqual((first["status"], first["next_allowed_at"], first["refreshing"]), ("started", "2026-10-28T15:10:00Z", True))
        self.assertTrue(entered.wait(5))
        self.clock.advance(minutes=1)
        second = service.request_refresh()
        self.assertEqual((second["status"], second["next_allowed_at"], second["refreshing"]), ("running", "2026-10-28T15:10:00Z", True))
        release.set()
        self.assertTrue(wait_until(lambda: not service.status()["refreshing"]))
        self.clock.advance(minutes=8, seconds=59)
        third = service.request_refresh()
        self.assertEqual((third["status"], third["next_allowed_at"]), ("skipped", "2026-10-28T15:10:00Z"))
        self.clock.advance(seconds=1)
        fourth = service.request_refresh()
        self.assertEqual((fourth["status"], fourth["next_allowed_at"]), ("started", "2026-10-28T15:20:00Z"))
        self.assertTrue(wait_until(lambda: not service.status()["refreshing"]))
        self.assertEqual(calls, [True, True])
        self.assertEqual(set(first), {"status", "next_allowed_at", "refreshed_at", "next_refresh_at", "refreshing", "last_error"})

    def test_a_background_refresh_in_progress_reports_running(self):
        entered, release = threading.Event(), threading.Event()
        self.market.before_call = lambda record: (entered.set(), release.wait(10))
        service = self.service()
        worker = threading.Thread(target=service.refresh_sectors)
        worker.start()
        try:
            self.assertTrue(entered.wait(5))
            result = service.request_refresh()
            self.assertEqual((result["status"], result["next_allowed_at"], result["refreshing"]), ("running", None, True))
        finally:
            release.set()
            worker.join(10)
        self.assertEqual(service.request_refresh()["status"], "started")  # the running refresh did not use up the manual allowance
        self.assertTrue(wait_until(lambda: not service.status()["refreshing"]))

    def test_the_cooldown_survives_a_restart(self):
        first = self.service()
        first.refresh_sectors = lambda force=False: {"status": "refreshed"}
        self.assertEqual(first.request_refresh()["status"], "started")
        self.assertTrue(wait_until(lambda: not first.status()["refreshing"]))
        second = self.service()
        self.clock.advance(minutes=3)
        result = second.request_refresh()
        self.assertEqual((result["status"], result["next_allowed_at"]), ("skipped", "2026-10-28T15:10:00Z"))

    def test_a_manual_refresh_really_refreshes_in_the_background(self):
        service = self.service()
        result = service.request_refresh()
        self.assertEqual(result["status"], "started")
        self.assertTrue(wait_until(lambda: not service.status()["refreshing"]))
        status = service.status()
        self.assertEqual((status["refreshed_at"], status["last_error"]), ("2026-10-28T15:00:00Z", None))
        self.assertIsNotNone(self.sector(service.sector_board(), "energy")["us"])

    def test_a_manual_refresh_forces_a_refresh_of_fresh_data(self):
        service = self.service()
        service.refresh_sectors()
        self.clock.advance(minutes=20)
        self.assertEqual(service.request_refresh()["status"], "started")
        self.assertTrue(wait_until(lambda: not service.status()["refreshing"]))
        self.assertEqual(service.status()["refreshed_at"], "2026-10-28T15:20:00Z")

    def test_a_failed_manual_refresh_is_visible_and_still_throttled(self):
        self.fail_everything()
        service = self.service()
        service.request_refresh()
        self.assertTrue(wait_until(lambda: not service.status()["refreshing"]))
        self.assertTrue(service.status()["last_error"].startswith("11 of 11 sectors could not be refreshed"))
        self.assertEqual(service.request_refresh()["status"], "skipped")


class LifecycleTests(ServiceTestCase):
    def live_service(self, **options):
        self.market = FakeMarket(now=lambda: datetime.now(timezone.utc))
        options = {"refresh_hours": 0.0002, "request_spacing": 0, "startup_delay": 0.01, **options}
        service = NewsService(self.store, self.market, **options)
        self.addCleanup(service.stop)
        return service

    @staticmethod
    def loop_threads():
        return [thread for thread in threading.enumerate() if thread.name == "news-refresh" and thread.is_alive()]

    def test_the_background_thread_refreshes_soon_after_start_and_then_repeats(self):
        service = self.live_service()
        service.start()
        self.assertTrue(wait_until(lambda: len(self.market.chart_calls) >= 44), "expected a second scheduled refresh")
        self.assertIsNotNone(service.status()["refreshed_at"])
        started = time.monotonic()
        service.stop()
        self.assertLess(time.monotonic() - started, 3.0)
        self.assertEqual(self.loop_threads(), [])
        settled = len(self.market.calls)
        time.sleep(0.3)
        self.assertEqual(len(self.market.calls), settled)

    def test_start_is_idempotent_and_the_service_can_be_restarted(self):
        service = self.live_service(refresh_hours=3)
        service.start()
        service.start()
        self.assertEqual(len(self.loop_threads()), 1)
        service.stop()
        self.assertEqual(self.loop_threads(), [])
        service.start()
        self.assertEqual(len(self.loop_threads()), 1)
        service.stop()
        self.assertEqual(self.loop_threads(), [])

    def test_stop_without_start_is_harmless(self):
        service = self.live_service()
        service.stop()
        service.stop()

    def test_fresh_data_is_not_refreshed_at_startup(self):
        service = self.live_service(refresh_hours=3)
        service.refresh_sectors()
        calls = len(self.market.calls)
        service.start()
        time.sleep(0.3)
        service.stop()
        self.assertEqual(len(self.market.calls), calls)

    def test_stale_data_is_refreshed_at_startup(self):
        service = self.live_service(refresh_hours=3)
        service.refresh_sectors()
        with self.store.connect() as db:
            db.execute("UPDATE news_meta SET value = ? WHERE key = 'refreshed_at'", (iso(datetime.now(timezone.utc) - timedelta(hours=4)),))
        calls = len(self.market.calls)
        service.start()
        self.assertTrue(wait_until(lambda: len(self.market.calls) >= calls + 44))
        service.stop()

    def test_stop_interrupts_a_running_refresh_between_sectors(self):
        service = self.live_service(refresh_hours=3, startup_delay=0)
        self.market.delay = 0.05
        service.start()
        self.assertTrue(wait_until(lambda: len(self.market.chart_calls) >= 1))
        started = time.monotonic()
        service.stop()
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertLess(len(self.market.chart_calls), 22)
        self.assertEqual(self.loop_threads(), [])
        self.assertIsNone(service.status()["refreshed_at"])  # an interrupted refresh is not marked fresh

    def test_stop_also_interrupts_a_manual_refresh(self):
        service = self.live_service(refresh_hours=3)
        self.market.delay = 0.05
        service.request_refresh()
        self.assertTrue(wait_until(lambda: len(self.market.chart_calls) >= 1))
        service.stop()
        self.assertFalse(service.status()["refreshing"])
        self.assertLess(len(self.market.chart_calls), 22)

    def test_a_manual_refresh_still_works_after_stop(self):
        service = self.live_service(refresh_hours=3)
        service.start()
        service.stop()
        self.assertEqual(service.request_refresh()["status"], "started")
        self.assertTrue(wait_until(lambda: not service.status()["refreshing"]))
        self.assertIsNotNone(service.status()["refreshed_at"])

    def test_next_delay_policy(self):
        service = self.service(refresh_hours=3)
        interval = 3 * 3600
        self.assertEqual(service._next_delay({"status": "failed"}), 900.0)
        self.assertEqual(service._next_delay({"status": "skipped", "reason": RUNNING_REASON}), 15.0)
        self.assertEqual(service._next_delay({"status": "refreshed", "refreshed_at": None}), 900.0)
        self.assertEqual(service._next_delay({"status": "refreshed", "refreshed_at": iso(NOW)}), interval)
        self.assertEqual(service._next_delay({"status": "skipped", "reason": FRESH_REASON, "refreshed_at": iso(NOW - timedelta(hours=1))}), 2 * 3600)
        self.assertEqual(service._next_delay({"status": "skipped", "reason": FRESH_REASON, "refreshed_at": iso(NOW - timedelta(hours=5))}), 1.0)
        tiny = self.service(refresh_hours=0.001)
        self.assertEqual(tiny._next_delay({"status": "failed"}), 3.6)
        self.assertEqual(tiny._next_delay({"status": "refreshed", "refreshed_at": iso(NOW)}), 3.6)


if __name__ == "__main__":
    unittest.main()
