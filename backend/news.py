"""Sector pulse and holding news from Yahoo Finance's keyless public endpoints.

Headlines are shown as the provider returned them, with publisher, link, timestamp and the reason they were
collected. Nothing here scores sentiment or predicts price impact, and a failed request is reported to the caller
instead of being replaced with synthetic or silently stale content.
"""

from bisect import bisect_right
from calendar import monthrange
from collections import deque
from datetime import date, datetime, timedelta, timezone
import hashlib
import html
import json
import logging
import math
import re
import threading
import time
import unicodedata
from urllib.parse import urlparse

from .market import MarketUnavailable, UnsupportedAsset
from .sectors import SECTORS

log = logging.getLogger(__name__)

SOURCE = "Yahoo Finance (unofficial public endpoint)"
SEARCH_PATH = "/v1/finance/search"
TICKER = re.compile(r"[A-Z0-9^.=&-]{1,25}")
STORY_ID = re.compile(r"[A-Za-z0-9._:-]{1,64}")
EXCHANGE_SUFFIX = re.compile(r".+\.[A-Z]{1,4}")

RETENTION = timedelta(days=21)
FUTURE_TOLERANCE = timedelta(days=1)
HEADLINE_WINDOW = timedelta(days=7)
HEADLINES_PER_SECTOR = 6
SEARCH_COUNT = 10
HOLDINGS_CACHE = timedelta(minutes=30)
MANUAL_COOLDOWN = timedelta(minutes=10)
MAX_HOLDINGS = 25
MAX_HOLDING_ITEMS = 40
MAX_RELATED = 12
MAX_BASE_GAP_DAYS = 5  # a comparison close further back than this means the history has a hole, so the move is null
FAILURE_LIMIT = 3  # consecutive provider failures after which one holdings request stops querying
RETRY_SECONDS = 900.0
RUNNING_REASON = "A news refresh is already running."
FRESH_REASON = "Sector data is newer than the refresh interval."
STOPPING_REASON = "The refresh was interrupted because the service is stopping."

CORPORATE_WORDS = frozenset(
    "inc incorporated corp corporation co company ltd limited plc ag sa nv se ab asa as spa bv gmbh kgaa llc lp oyj oy public "
    "aktiengesellschaft pty pte bhd tbk pcl sab sas srl kk ltda".split()
)
CONNECTOR_WORDS = frozenset("of de the and for la le du van von der di del &".split())
# First words shared by many unrelated companies; matching on one of them alone would not identify the company.
GENERIC_WORDS = frozenset(
    "the group holdings holding global international national general united american first royal bank banco grupo china new pacific "
    "european great southern northern western eastern central standard financial capital energy power electric motor motors "
    "deutsche canadian australian japan india korea hong".split()
)
_INVISIBLE = re.compile("[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]")
_CONTROL = re.compile("[\x00-\x1f\x7f-\x9f]")


def iso(moment):
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(value):
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment.replace(tzinfo=timezone.utc) if moment.tzinfo is None else moment.astimezone(timezone.utc)


def clean_text(value):
    """HTML-unescape, drop control and invisible characters, collapse whitespace; anything that is not text becomes ''."""
    if not isinstance(value, str):
        return ""
    return " ".join(_CONTROL.sub(" ", _INVISIBLE.sub("", html.unescape(value))).split())


def clean_url(value):
    """The link when it is an absolute http(s) URL with a host, otherwise None."""
    if not isinstance(value, str):
        return None
    url = value.strip()
    if not url or len(url) > 2048 or any(ord(char) <= 32 or ord(char) == 127 for char in url):
        return None
    try:
        parsed = urlparse(url)
        parsed.port  # noqa: B018 - raises ValueError for an invalid port
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        return None
    return url


def related_tickers(value):
    """Provider-supplied symbols that look like tickers, upper-cased and de-duplicated in provider order."""
    symbols = []
    for entry in value if isinstance(value, list) else []:
        if not isinstance(entry, str) or not entry.isascii():
            continue
        symbol = entry.strip().upper()
        if TICKER.fullmatch(symbol) and symbol not in symbols:
            symbols.append(symbol)
    return symbols


def normalise_item(raw, now, sectors=()):
    """Validate one provider story into a NewsItem dict, or return None when it has to be rejected."""
    if not isinstance(raw, dict):
        return None
    url, title = clean_url(raw.get("link")), clean_text(raw.get("title"))
    if url is None or not 1 <= len(title) <= 300:
        return None
    stamp = raw.get("providerPublishTime")
    if isinstance(stamp, bool) or not isinstance(stamp, (int, float)):
        return None
    try:
        published = datetime.fromtimestamp(int(stamp), timezone.utc)
    except (OverflowError, OSError, ValueError):  # NaN, infinity and out-of-range values
        return None
    if published > now + FUTURE_TOLERANCE or published < now - RETENTION:
        return None
    publisher = clean_text(raw.get("publisher"))
    if not 1 <= len(publisher) <= 120:
        publisher = "Unknown publisher"
    uuid = raw.get("uuid")
    uuid = uuid.strip() if isinstance(uuid, str) else ""
    story_id = uuid if STORY_ID.fullmatch(uuid) else hashlib.sha256(url.encode("utf-8")).hexdigest()[:24]
    return {
        "id": story_id, "title": title, "publisher": publisher, "url": url, "published_at": iso(published),
        "tickers": related_tickers(raw.get("relatedTickers"))[:MAX_RELATED], "sectors": list(sectors), "source": SOURCE,
    }


def _positive(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def month_before(day):
    """The same day one calendar month earlier, clamped to the shorter month (Mar 31 -> Feb 28/29)."""
    year, month = (day.year, day.month - 1) if day.month > 1 else (day.year - 1, 12)
    return date(year, month, min(day.day, monthrange(year, month)[1]))


def sector_move(proxy, chart):
    """SectorMove for one proxy ETF from adjusted closes. A period without enough history is null, never estimated."""
    records = chart.get("records") if isinstance(chart, dict) else None
    if not isinstance(records, list):
        raise ValueError("the price history has an unexpected format.")
    closes = {}
    for row in records:
        if not isinstance(row, dict) or not _positive(row.get("adjusted_close")):
            continue
        try:
            closes[date.fromisoformat(str(row.get("date")))] = float(row["adjusted_close"])
        except ValueError:
            continue
    if not closes:
        raise ValueError("no valid adjusted closes are available.")
    days = sorted(closes)
    last_day = days[-1]
    last = closes[last_day]

    def since(target):
        index = bisect_right(days, target) - 1
        if index < 0 or (target - days[index]).days > MAX_BASE_GAP_DAYS:
            return None
        return last / closes[days[index]] - 1

    previous = days[-2] if len(days) > 1 else None
    name, currency = clean_text(chart.get("name")), clean_text(chart.get("currency"))
    return {
        "proxy": proxy, "proxy_name": name or proxy, "currency": currency or "Not reported", "as_of": last_day.isoformat(),
        "d1": last / closes[previous] - 1 if previous is not None and (last_day - previous).days <= MAX_BASE_GAP_DAYS else None,
        "w1": since(last_day - timedelta(days=7)), "m1": since(month_before(last_day)), "ytd": since(date(last_day.year - 1, 12, 31)),
    }


def _fold(text):
    return "".join(char for char in unicodedata.normalize("NFKD", text) if not unicodedata.combining(char)).casefold()


def _word_key(word):
    return re.sub(r"[^\w&]", "", _fold(word))


def _is_acronym(word):
    return len(word) == 3 and word.isascii() and word.isalpha() and word.isupper()


def _distinctive(word):
    key = _word_key(word)
    if key in GENERIC_WORDS or key in CONNECTOR_WORDS:
        return False
    return sum(char.isalpha() for char in key) >= 4 or _is_acronym(word)


class CompanyMatch:
    """A company-name search query plus the test deciding whether a headline title names that company."""

    def __init__(self, phrase, token):
        self.query = " ".join(phrase)
        self.label = token or self.query
        self._acronym = token is not None and _is_acronym(token)
        self._phrase = re.compile(r"(?<!\w)" + r"\W+".join(re.escape(_fold(word)) for word in phrase) + r"(?!\w)") if len(phrase) > 1 else None
        self._token = re.compile(r"(?<!\w)" + re.escape(token if self._acronym else _fold(token)) + r"(?!\w)") if token else None

    def __call__(self, title):
        if not isinstance(title, str):
            return False
        if self._phrase is not None and self._phrase.search(_fold(title)):
            return True
        if self._token is None:
            return False
        return bool(self._token.search(title if self._acronym else _fold(title)))


def company_match(name, ticker=""):
    """CompanyMatch for a display name, or None when the name cannot identify the company safely.

    The query is the first three words minus corporate suffixes (Inc, Ltd, PLC, AG, SA, NV, ...). A title matches
    when it contains the whole phrase or the first word, provided that word is distinctive: at least four letters
    and not a generic word such as Bank or Group, or an upper-case three-letter acronym matched case-sensitively.
    """
    if not isinstance(name, str):
        return None
    words = [word for word in (part.strip(" ,;:()[]{}\"'") for part in name.split()) if word]
    words = [word for index, word in enumerate(words) if index == 0 or _word_key(word) not in CORPORATE_WORDS]
    while words and _word_key(words[0]) == "the":
        words.pop(0)
    phrase = words[:3]
    while phrase and _word_key(phrase[-1]) in CONNECTOR_WORDS:
        phrase.pop()
    if not phrase or _fold(" ".join(phrase)) == _fold(ticker):
        return None
    token = phrase[0] if _distinctive(phrase[0]) else None
    if token is None and len(phrase) < 2:
        return None
    return CompanyMatch(phrase, token)


def item_from_row(row):
    return {
        "id": row["id"], "title": row["title"], "publisher": row["publisher"], "url": row["url"], "published_at": row["published_at"],
        "tickers": json.loads(row["tickers"]), "sectors": json.loads(row["sectors"]), "source": row["source"],
    }


def collapse(stories):
    """Drop repeats (same link, or same publisher and title) from a newest-first list.

    Returns (kept stories, alias) where alias maps every input id to the id that was kept for it.
    """
    owner, kept, alias = {}, [], {}
    for story in stories:
        keys = (("url", story["url"]), ("title", story["publisher"].casefold(), story["title"].casefold()))
        target = next((owner[key] for key in keys if key in owner), None)
        if target is None:
            target = story["id"]
            kept.append(story)
        for key in keys:
            owner.setdefault(key, target)
        alias[story["id"]] = target
    return kept, alias


def balanced(candidates, limit):
    """Choose up to `limit` ids by rotating through the holdings so one busy ticker cannot crowd out a quiet one."""
    queues = {ticker: deque(ids) for ticker, ids in candidates.items()}
    chosen = set()
    while len(chosen) < limit and any(queues.values()):
        for queue in queues.values():
            while queue and queue[0] in chosen:
                queue.popleft()
            if queue and len(chosen) < limit:
                chosen.add(queue.popleft())
    return chosen


class _Pacer:
    """Sleeps between consecutive provider calls of one batch; the first call is never delayed."""

    def __init__(self, sleep, spacing):
        self.sleep, self.spacing, self.calls = sleep, spacing, 0

    def __call__(self):
        if self.calls and self.spacing > 0:
            self.sleep(self.spacing)
        self.calls += 1


class _Breaker:
    def __init__(self):
        self.failures = 0

    @property
    def open(self):
        return self.failures >= FAILURE_LIMIT


SCHEMA = (
    "CREATE TABLE IF NOT EXISTS news_items (id TEXT PRIMARY KEY, title TEXT NOT NULL, publisher TEXT NOT NULL, url TEXT NOT NULL, "
    "published_at TEXT NOT NULL, fetched_at TEXT NOT NULL, tickers TEXT NOT NULL, sectors TEXT NOT NULL, source TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS news_items_published ON news_items (published_at)",
    "CREATE TABLE IF NOT EXISTS news_queries (key TEXT PRIMARY KEY, fetched_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS news_links (ticker TEXT NOT NULL, item_id TEXT NOT NULL, via TEXT NOT NULL, PRIMARY KEY (ticker, item_id))",
    "CREATE TABLE IF NOT EXISTS sector_moves (sector_id TEXT NOT NULL, scope TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL, "
    "PRIMARY KEY (sector_id, scope))",
    "CREATE TABLE IF NOT EXISTS news_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
)


class NewsService:
    """Daily sector board, background refresh and per-holding news, persisted in the shared SQLite store."""

    def __init__(self, store, market, *, refresh_hours=3.0, clock=None, sleep=None, request_spacing=0.35, startup_delay=5.0):
        if isinstance(refresh_hours, bool) or not isinstance(refresh_hours, (int, float)) or not math.isfinite(refresh_hours) or refresh_hours <= 0:
            raise ValueError("refresh_hours must be a positive number.")
        self.store, self.market = store, market
        self.refresh_hours = float(refresh_hours)
        self.request_spacing = max(0.0, float(request_spacing))
        self.startup_delay = max(0.0, float(startup_delay))
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._sleep = sleep or time.sleep
        self._state = threading.Lock()
        self._holdings_lock = threading.Lock()
        self._refreshing = False
        self._manual = None
        self._thread = None
        self._stop = threading.Event()
        with self.store.connect() as db:
            for statement in SCHEMA:
                db.execute(statement)

    # ---- state -------------------------------------------------------------------------------------------------
    def _now(self):
        moment = self._clock()
        return moment.replace(tzinfo=timezone.utc) if moment.tzinfo is None else moment.astimezone(timezone.utc)

    def _busy(self):
        return self._refreshing or (self._manual is not None and self._manual.is_alive())

    @staticmethod
    def _meta(db):
        return {row["key"]: row["value"] for row in db.execute("SELECT key, value FROM news_meta")}

    @staticmethod
    def _put_meta(db, key, value):
        if value is None:
            db.execute("DELETE FROM news_meta WHERE key = ?", (key,))
        else:
            db.execute("INSERT INTO news_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))

    def _status_from(self, meta):
        refreshed = parse_time(meta.get("refreshed_at"))
        return {
            "refreshed_at": iso(refreshed) if refreshed else None,
            "next_refresh_at": iso(refreshed + timedelta(hours=self.refresh_hours)) if refreshed else None,
            "refreshing": self._busy(),
            "last_error": meta.get("last_error") or None,
        }

    def status(self):
        with self.store.connect() as db:
            return self._status_from(self._meta(db))

    # ---- sector board ------------------------------------------------------------------------------------------
    def sector_board(self):
        """Persisted sector moves and recent headlines for every sector; never touches the network."""
        now = self._now()
        with self.store.connect() as db:
            meta = self._meta(db)
            move_rows = db.execute("SELECT sector_id, scope, payload FROM sector_moves").fetchall()
            story_rows = db.execute("SELECT * FROM news_items WHERE published_at >= ? ORDER BY published_at DESC, id ASC",
                                    (iso(now - HEADLINE_WINDOW),)).fetchall()
        moves = {}
        for row in move_rows:
            try:
                moves[(row["sector_id"], row["scope"])] = json.loads(row["payload"])
            except ValueError:
                log.warning("Ignoring unreadable stored sector move for %s/%s", row["sector_id"], row["scope"])
        stories = [item_from_row(row) for row in story_rows]
        sectors = []
        for sector in SECTORS:
            own, _ = collapse([story for story in stories if sector["id"] in story["sectors"]])
            sectors.append({
                "id": sector["id"], "name": sector["name"], "us": moves.get((sector["id"], "us")),
                "global": moves.get((sector["id"], "global")), "headlines": own[:HEADLINES_PER_SECTOR],
            })
        return {"sectors": sectors, **self._status_from(meta), "source": SOURCE}

    # ---- storage helpers ---------------------------------------------------------------------------------------
    @staticmethod
    def _put_items(db, items, fetched_at):
        """Insert stories; a repeated id keeps the newest provider text and the union of tickers and sectors."""
        order = {sector["id"]: index for index, sector in enumerate(SECTORS)}
        for item in items:
            row = db.execute("SELECT tickers, sectors FROM news_items WHERE id = ?", (item["id"],)).fetchone()
            tickers = json.loads(row["tickers"]) if row else []
            tickers = [*tickers, *(symbol for symbol in item["tickers"] if symbol not in tickers)][:MAX_RELATED]
            tagged = {*(json.loads(row["sectors"]) if row else []), *item["sectors"]}
            sectors = sorted(tagged, key=lambda sector_id: order.get(sector_id, len(order)))
            db.execute(
                "INSERT INTO news_items (id, title, publisher, url, published_at, fetched_at, tickers, sectors, source) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, publisher = excluded.publisher, "
                "url = excluded.url, published_at = excluded.published_at, fetched_at = excluded.fetched_at, tickers = excluded.tickers, "
                "sectors = excluded.sectors, source = excluded.source",
                (item["id"], item["title"], item["publisher"], item["url"], item["published_at"], fetched_at,
                 json.dumps(tickers), json.dumps(sectors), item["source"]),
            )

    @staticmethod
    def _put_move(db, sector_id, scope, move, stamp):
        db.execute(
            "INSERT INTO sector_moves (sector_id, scope, payload, updated_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(sector_id, scope) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
            (sector_id, scope, json.dumps(move, allow_nan=False), stamp),
        )

    @staticmethod
    def _touch_query(db, key, stamp):
        db.execute("INSERT INTO news_queries (key, fetched_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET fetched_at = excluded.fetched_at", (key, stamp))

    @staticmethod
    def _set_links(db, ticker, via, ids):
        db.execute("DELETE FROM news_links WHERE ticker = ? AND via = ?", (ticker, via))
        # A ticker match always outranks a name match for the same story.
        verb = "INSERT OR REPLACE" if via == "ticker" else "INSERT OR IGNORE"
        db.executemany(f"{verb} INTO news_links (ticker, item_id, via) VALUES (?, ?, ?)", [(ticker, story_id, via) for story_id in dict.fromkeys(ids)])

    def _purge(self, db, now):
        cutoff = iso(now - RETENTION)
        db.execute("DELETE FROM news_items WHERE published_at < ?", (cutoff,))
        db.execute("DELETE FROM news_links WHERE item_id NOT IN (SELECT id FROM news_items)")
        db.execute("DELETE FROM news_queries WHERE fetched_at < ?", (cutoff,))

    def _search(self, query):
        data = self.market.request(SEARCH_PATH, {"q": query, "quotesCount": 0, "newsCount": SEARCH_COUNT})
        news = data.get("news") if isinstance(data, dict) else None
        if not isinstance(news, list):
            raise MarketUnavailable("Yahoo Finance returned news in an unexpected format.")
        return news

    @staticmethod
    def _parse(news, now, sectors=()):
        """Accepted stories as (item, every provider-listed related ticker) pairs, plus how many were rejected."""
        accepted = []
        for raw in news:
            item = normalise_item(raw, now, sectors)
            if item is not None:
                accepted.append((item, related_tickers(raw.get("relatedTickers"))))
        return accepted, len(news) - len(accepted)

    @staticmethod
    def _explain(exc):
        if isinstance(exc, (MarketUnavailable, UnsupportedAsset, ValueError)):
            message = str(exc)
        else:
            log.warning("Unexpected error while refreshing news", exc_info=exc)
            message = f"unexpected {type(exc).__name__}: {exc}"
        return " ".join(message.split())[:200] or type(exc).__name__

    # ---- sector refresh ----------------------------------------------------------------------------------------
    def refresh_sectors(self, force=False):
        """Refresh moves and headlines for every sector now, blocking until done.

        Returns the NewsStatus fields plus status "refreshed" (at least one sector was fully updated), "failed" (none
        could be updated, so nothing was marked fresh) or "skipped" (data is still fresh, or another refresh is running).
        """
        with self._state:
            running = self._refreshing
            self._refreshing = True
        if running:
            return {**self.status(), "status": "skipped", "reason": RUNNING_REASON}
        try:
            outcome = self._refresh(force)
        except Exception as exc:
            log.exception("News refresh failed")
            message = f"The news refresh failed unexpectedly: {self._explain(exc)}"
            with self.store.connect() as db:
                self._put_meta(db, "last_error", message)
            outcome = {"status": "failed", "reason": message}
        finally:
            with self._state:
                self._refreshing = False
        return {**self.status(), **outcome}

    def _refresh(self, force):
        now = self._now()
        if not force:
            with self.store.connect() as db:
                refreshed = parse_time(self._meta(db).get("refreshed_at"))
            if refreshed is not None and timedelta(0) <= now - refreshed < timedelta(hours=self.refresh_hours):
                return {"status": "skipped", "reason": FRESH_REASON}
        stamp, pacer = iso(now), _Pacer(self._sleep, self.request_spacing)
        failures, succeeded, stored, rejected = {}, 0, 0, 0
        for sector in SECTORS:
            if self._stop.is_set():
                return {"status": "failed", "reason": STOPPING_REASON}
            problems, moves, batches = [], {}, []
            for scope in ("us", "global"):
                proxy = sector[scope]
                try:
                    pacer()
                    moves[scope] = sector_move(proxy, self.market.chart(proxy, "1y", refresh=True))
                except Exception as exc:
                    problems.append(f"{proxy} prices: {self._explain(exc)}")
            for scope in ("us", "global"):
                proxy = sector[scope]
                try:
                    pacer()
                    parsed, dropped = self._parse(self._search(proxy), now, [sector["id"]])
                    batches.append([item for item, _ in parsed])
                    rejected += dropped
                except Exception as exc:
                    problems.append(f"{proxy} news: {self._explain(exc)}")
            with self.store.connect() as db:
                for scope, move in moves.items():
                    self._put_move(db, sector["id"], scope, move, stamp)
                for items in batches:
                    self._put_items(db, items, stamp)
                    stored += len(items)
            if problems:
                failures[sector["id"]] = problems
            else:
                succeeded += 1
        names = {sector["id"]: sector["name"] for sector in SECTORS}
        shown = [f"{names[sector_id]} ({problems[0]})" for sector_id, problems in list(failures.items())[:3]]
        last_error = None
        if failures:
            last_error = f"{len(failures)} of {len(SECTORS)} sectors could not be refreshed: " + "; ".join(shown)
            last_error += f"; and {len(failures) - len(shown)} more" if len(failures) > len(shown) else ""
        finished = self._now()
        with self.store.connect() as db:
            if succeeded:
                self._put_meta(db, "refreshed_at", iso(finished))
            self._put_meta(db, "last_error", last_error)
            self._purge(db, finished)
        return {
            "status": "refreshed" if succeeded else "failed", "sectors_refreshed": succeeded, "sectors_failed": len(failures),
            "errors": failures, "items_stored": stored, "items_rejected": rejected,
        }

    def request_refresh(self):
        """Start a background refresh for the manual button unless one is running or the last one began under 10 minutes ago."""
        now = self._now()
        with self._state:
            with self.store.connect() as db:
                last = parse_time(self._meta(db).get("last_manual_refresh_at"))
            until = last + MANUAL_COOLDOWN if last is not None and last + MANUAL_COOLDOWN > now else None
            if self._busy():
                outcome, allowed = "running", until
            elif until is not None:
                outcome, allowed = "skipped", until
            else:
                outcome, allowed = "started", now + MANUAL_COOLDOWN
                with self.store.connect() as db:
                    self._put_meta(db, "last_manual_refresh_at", iso(now))
                self._manual = threading.Thread(target=self._manual_worker, name="news-manual-refresh", daemon=True)
                self._manual.start()
        return {**self.status(), "status": outcome, "next_allowed_at": iso(allowed) if allowed else None}

    def _manual_worker(self):
        try:
            self.refresh_sectors(force=True)
        except Exception:
            log.exception("Manual news refresh failed")

    # ---- background scheduling ---------------------------------------------------------------------------------
    def start(self):
        """Start the daemon thread: a first refresh shortly after start when data is stale or absent, then every refresh_hours."""
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, args=(self._stop,), name="news-refresh", daemon=True)
        self._thread.start()

    def stop(self, timeout=5.0):
        """Ask the background and manual refresh threads to finish, and wait briefly for them."""
        self._stop.set()
        threads = [thread for thread in (self._thread, self._manual) if thread is not None and thread is not threading.current_thread()]
        for thread in threads:
            thread.join(timeout)
        if not any(thread.is_alive() for thread in threads):
            self._thread = None
            self._stop = threading.Event()

    def _loop(self, stop):
        delay = self.startup_delay
        while not stop.wait(delay):
            try:
                delay = self._next_delay(self.refresh_sectors())
            except Exception:
                log.exception("Scheduled news refresh failed")
                delay = min(self.refresh_hours * 3600, RETRY_SECONDS)

    def _next_delay(self, result):
        interval = self.refresh_hours * 3600
        if result.get("status") == "failed":
            return min(interval, RETRY_SECONDS)
        if result.get("reason") == RUNNING_REASON:
            return min(interval, 15.0)
        refreshed = parse_time(result.get("refreshed_at"))
        if refreshed is None:
            return min(interval, RETRY_SECONDS)
        due = (refreshed + timedelta(hours=self.refresh_hours) - self._now()).total_seconds()
        return max(min(1.0, interval), min(due, interval))

    # ---- holdings news -----------------------------------------------------------------------------------------
    @staticmethod
    def _clean_holdings(holdings):
        if not isinstance(holdings, (list, tuple)):
            raise ValueError("Holdings must be a list of {ticker, name} objects.")
        if not 1 <= len(holdings) <= MAX_HOLDINGS:
            raise ValueError(f"Provide between 1 and {MAX_HOLDINGS} holdings.")
        requested = {}
        for entry in holdings:
            if not isinstance(entry, dict) or not isinstance(entry.get("ticker"), str):
                raise ValueError("Each holding needs a text ticker.")
            text = entry["ticker"].strip()
            ticker = text.upper()
            if not text.isascii() or not TICKER.fullmatch(ticker):
                raise ValueError(f"{text[:30]!r} is not a valid ticker symbol.")
            name = entry.get("name")
            if name is not None and not isinstance(name, str):
                raise ValueError("A holding name must be text or null.")
            if requested.get(ticker) is None:
                requested[ticker] = clean_text(name)[:200] or None
        return list(requested.items())

    def holdings_news(self, holdings, refresh=False):
        """Headlines for up to 25 holdings (HoldingsNews).

        A story belongs to a ticker only when the provider lists that exact ticker as related. Exchange-suffixed
        tickers (7203.T, SAP.DE, VOD.L) usually have nothing filed under their own symbol, so with fewer than two
        matches the company name is searched too and a story is accepted when its title names the company; such
        stories are called out in the warnings. Queries are cached for 30 minutes unless refresh is true. A failed
        query becomes a warning (saved headlines are shown, labelled, when they exist); MarketUnavailable is raised
        only when nothing at all could be loaded.
        """
        requested = self._clean_holdings(holdings)
        with self._holdings_lock:
            return self._holdings(requested, bool(refresh))

    def _query(self, key, query, now, refresh, pacer, breaker):
        """Reuse or run one provider search. Returns (state, news, fetched_at, error); state is cached, fetched or failed."""
        with self.store.connect() as db:
            row = db.execute("SELECT fetched_at FROM news_queries WHERE key = ?", (key,)).fetchone()
        saved = parse_time(row["fetched_at"]) if row else None
        saved_text = iso(saved) if saved else None
        if saved is not None and not refresh and timedelta(0) <= now - saved < HOLDINGS_CACHE:
            return "cached", None, saved_text, None
        if breaker.open:
            return "failed", None, saved_text, f"not queried because {breaker.failures} provider requests in a row failed"
        try:
            pacer()
            news = self._search(query)
        except (MarketUnavailable, UnsupportedAsset) as exc:
            if isinstance(exc, MarketUnavailable):
                breaker.failures += 1
            return "failed", None, saved_text, " ".join(str(exc).split())[:200]
        breaker.failures = 0
        return "fetched", news, iso(now), None

    def _linked(self, ticker, now):
        with self.store.connect() as db:
            rows = db.execute(
                "SELECT n.*, l.via AS via FROM news_links l JOIN news_items n ON n.id = l.item_id "
                "WHERE l.ticker = ? AND n.published_at >= ? ORDER BY n.published_at DESC, n.id ASC", (ticker, iso(now - RETENTION)),
            ).fetchall()
        return [(item_from_row(row), row["via"]) for row in rows]

    def _collect(self, ticker, name, refresh, now, pacer, breaker):
        """Refresh or reuse the saved headlines for one ticker; returns the stories and what was learned along the way."""
        stamp, fetched, errors, notes = iso(now), [], [], []
        key = f"ticker:{ticker}"
        state, news, when, error = self._query(key, ticker, now, refresh, pacer, breaker)
        if when:
            fetched.append(when)
        if state == "fetched":
            parsed, _ = self._parse(news, now)
            relevant = [item for item, related in parsed if ticker in related]
            with self.store.connect() as db:
                self._put_items(db, relevant, stamp)
                self._set_links(db, ticker, "ticker", [item["id"] for item in relevant])
                self._touch_query(db, key, stamp)
        elif state == "failed":
            errors.append(error)
        if state != "failed":
            match = None
            if EXCHANGE_SUFFIX.fullmatch(ticker) and sum(1 for _, via in self._linked(ticker, now) if via == "ticker") < 2:
                match = company_match(name, ticker)
                if match is None:
                    reason = "the company name is too generic to search safely" if name else "no company name was supplied for a name search"
                    notes.append(f"{ticker}: Yahoo Finance files few headlines under exchange-suffixed symbols and {reason}.")
            if match is None:
                with self.store.connect() as db:
                    db.execute("DELETE FROM news_links WHERE ticker = ? AND via = 'name'", (ticker,))
            else:
                name_key = f"name:{ticker}:{_fold(match.query)}"
                name_state, name_news, name_when, name_error = self._query(name_key, match.query, now, refresh, pacer, breaker)
                if name_when:
                    fetched.append(name_when)
                if name_state == "fetched":
                    parsed, _ = self._parse(name_news, now)
                    accepted = [item for item, _ in parsed if match(item["title"])]
                    with self.store.connect() as db:
                        self._put_items(db, accepted, stamp)
                        self._set_links(db, ticker, "name", [item["id"] for item in accepted])
                        self._touch_query(db, name_key, stamp)
                elif name_state == "failed":
                    notes.append(f"{ticker}: the company-name search for “{match.query}” failed ({name_error}).")
        stories = self._linked(ticker, now)
        if errors and not stories:
            fetched = []
        return {"stories": stories, "fetched": fetched, "errors": errors, "notes": notes}

    def _holdings(self, requested, refresh):
        now = self._now()
        pacer, breaker = _Pacer(self._sleep, self.request_spacing), _Breaker()
        warnings, fetched, errors, per_ticker = [], [], [], {}
        for ticker, name in requested:
            found = self._collect(ticker, name, refresh, now, pacer, breaker)
            stories = found["stories"]
            per_ticker[ticker] = stories
            fetched.extend(found["fetched"])
            errors.extend(found["errors"])
            if found["errors"]:
                saved = (f"Showing {len(stories)} headline(s) saved at {max(found['fetched'])}." if found["fetched"]
                         else "No saved headlines are available.")
                warnings.append(f"{ticker}: news could not be refreshed ({found['errors'][0].rstrip('.')}). {saved}")
            warnings.extend(found["notes"])
            by_name = sum(1 for _, via in stories if via == "name")
            if by_name:
                match = company_match(name, ticker)
                direct = len(stories) - by_name
                filed = f"{direct} headline is" if direct == 1 else f"{direct} headlines are"
                matched = (f"1 more was matched because its title mentions “{match.label if match else name}”. Check that it concerns this listing."
                           if by_name == 1 else
                           f"{by_name} more were matched because their titles mention “{match.label if match else name}”. Check that they concern this listing.")
                warnings.append(f"{ticker}: {filed} filed under this symbol; {matched}")
            if not stories and not found["errors"]:
                warnings.append(f"{ticker}: no recent headlines were found.")
        if not fetched:
            raise MarketUnavailable(f"News could not be loaded ({errors[0] if errors else 'no response'}); no headlines were substituted.")
        unique = sorted({story["id"]: story for stories in per_ticker.values() for story, _ in stories}.values(), key=lambda story: story["id"])
        unique.sort(key=lambda story: story["published_at"], reverse=True)
        kept, alias = collapse(unique)
        candidates = {ticker: list(dict.fromkeys(alias[story["id"]] for story, _ in stories)) for ticker, stories in per_ticker.items()}
        chosen = balanced(candidates, MAX_HOLDING_ITEMS)
        return {
            "items": [story for story in kept if story["id"] in chosen],
            "by_ticker": {ticker: [story_id for story_id in ids if story_id in chosen] for ticker, ids in candidates.items()},
            "refreshed_at": max(fetched), "source": SOURCE, "warnings": list(dict.fromkeys(warnings)),
        }
