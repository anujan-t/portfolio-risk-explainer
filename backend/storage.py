from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sqlite3
from uuid import uuid4


def storage_directory():
    root = Path(os.environ["LOCALAPPDATA"]) if os.environ.get("LOCALAPPDATA") else Path.home() / ".local" / "share"
    return Path(os.environ.get("PORTFOLIO_DATA_DIR", root / "PortfolioRiskExplainer"))


class RevisionConflict(ValueError):
    pass


class Store:
    def __init__(self, directory=None):
        directory = Path(directory) if directory is not None else storage_directory()
        directory.mkdir(parents=True, exist_ok=True)
        self.path = directory / "portfolios.sqlite3"
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS portfolios (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS market_cache (key TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at TEXT NOT NULL)")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def cache_get(self, key, max_age=timedelta(hours=6)):
        with self.connect() as db:
            row = db.execute("SELECT * FROM market_cache WHERE key = ?", (key,)).fetchone()
        if row is None:
            return None
        age = datetime.now(timezone.utc) - datetime.fromisoformat(row["fetched_at"])
        if not timedelta(0) <= age < max_age:
            return None
        return json.loads(row["payload"])

    def cache_put(self, key, payload):
        value = {**payload, "fetched_at": datetime.now(timezone.utc).isoformat(timespec="microseconds")}
        with self.connect() as db:
            db.execute("INSERT INTO market_cache VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at",
                       (key, json.dumps(value, allow_nan=False), value["fetched_at"]))
        return value

    @staticmethod
    def portfolio(row):
        return {**json.loads(row["body"]), "id": row["id"], "revision": row["revision"], "updated_at": row["updated_at"]}

    def list_portfolios(self):
        with self.connect() as db:
            return [self.portfolio(row) for row in db.execute("SELECT * FROM portfolios ORDER BY updated_at DESC")]

    def save_portfolio(self, body, portfolio_id=None, revision=None):
        now = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        with self.connect() as db:
            if portfolio_id is None:
                portfolio_id = uuid4().hex
                db.execute("INSERT INTO portfolios VALUES (?, 1, ?, ?)", (portfolio_id, json.dumps(body, allow_nan=False), now))
            else:
                changed = db.execute("UPDATE portfolios SET body = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
                                     (json.dumps(body, allow_nan=False), now, portfolio_id, revision)).rowcount
                if changed != 1:
                    if not db.execute("SELECT 1 FROM portfolios WHERE id = ?", (portfolio_id,)).fetchone():
                        raise KeyError("Portfolio not found.")
                    raise RevisionConflict("This portfolio changed in another window. Reload the saved portfolio before updating it.")
            return self.portfolio(db.execute("SELECT * FROM portfolios WHERE id = ?", (portfolio_id,)).fetchone())

    def delete_portfolio(self, portfolio_id, revision):
        with self.connect() as db:
            if db.execute("DELETE FROM portfolios WHERE id = ? AND revision = ?", (portfolio_id, revision)).rowcount != 1:
                if not db.execute("SELECT 1 FROM portfolios WHERE id = ?", (portfolio_id,)).fetchone():
                    raise KeyError("Portfolio not found.")
                raise RevisionConflict("The portfolio changed in another window. Reload before deleting it.")
