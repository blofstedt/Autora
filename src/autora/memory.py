"""What the agent knows, between sessions.

Three things live here, and they are deliberately the same shape:

  * **facts and preferences** -- who you are, how you like things done
  * **procedures** -- how to do something in a particular project, which is
    what a "skill" is once you stop capitalising it
  * **episodes** -- what happened, compressed, so a later session can say
    "we tried that in March and it broke the migration"

Two design choices carry most of the weight.

**Everything has provenance.** A record points back at the session and event
that justified it. A memory system without that becomes a junk drawer: claims
accumulate, nothing can be checked, and a wrong belief is indistinguishable
from a right one. Being able to ask "why do you think that?" -- and to delete
the answer -- is what makes the rest trustworthy.

**Nothing is loaded speculatively.** The whole store is searched, a handful of
records are injected, and the rest stays one tool call away. A memory system
that pastes everything it knows into every prompt has just moved the context
problem somewhere more expensive.

Storage is SQLite with an FTS5 index, which means no service to run, no vector
database to keep in sync, and a store the user can open with any SQLite client.
Lexical search first is a real choice, not a shortcut: for one person's memory
the recall problem is small, and a BM25 hit you can explain beats a cosine
distance you cannot. Embeddings are a later optimisation if recall proves
insufficient, not a starting assumption.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

KINDS = ("fact", "preference", "procedure", "episode")
#: A record starts provisional and is confirmed when it proves itself a second
#: time. An auto-written procedure that nothing has re-validated is a guess, and
#: a guess the agent follows confidently is worse than no memory at all.
STATUSES = ("provisional", "confirmed", "retired")

GLOBAL = "global"


def project_scope(workdir: str | Path) -> str:
    """Scope key for a project. `pytest -x` is a fact about one repo, not the world."""
    return f"project:{Path(workdir).resolve()}"


@dataclass
class Record:
    id: str
    kind: str
    scope: str
    title: str
    body: str
    tags: list[str] = field(default_factory=list)
    status: str = "provisional"
    pinned: bool = False
    source_session: str | None = None
    source_seq: int | None = None
    created: float = 0.0
    updated: float = 0.0
    uses: int = 0
    last_used: float | None = None
    superseded_by: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {**self.__dict__, "tags": list(self.tags)}

    def as_context(self) -> str:
        """One record, as the model reads it."""
        head = f"[{self.id}] {self.title}"
        if self.status == "provisional":
            head += " (provisional)"
        return f"{head}\n{self.body}"


_SCHEMA = """
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'provisional',
  pinned INTEGER NOT NULL DEFAULT 0,
  source_session TEXT,
  source_seq INTEGER,
  created REAL NOT NULL,
  updated REAL NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used REAL,
  superseded_by TEXT
);
CREATE INDEX IF NOT EXISTS records_scope ON records(scope, status);
CREATE TABLE IF NOT EXISTS links (
  src TEXT NOT NULL, dst TEXT NOT NULL, rel TEXT NOT NULL DEFAULT 'related',
  PRIMARY KEY (src, dst, rel)
);
CREATE VIRTUAL TABLE IF NOT EXISTS records_fts
  USING fts5(title, body, tags, content='records', content_rowid='rowid');
-- Keep the index in step with the table. Triggers rather than application code
-- so a write through any other client cannot desynchronise the two.
CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
  INSERT INTO records_fts(rowid, title, body, tags)
  VALUES (new.rowid, new.title, new.body, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, title, body, tags)
  VALUES ('delete', old.rowid, old.title, old.body, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS records_au AFTER UPDATE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, title, body, tags)
  VALUES ('delete', old.rowid, old.title, old.body, old.tags);
  INSERT INTO records_fts(rowid, title, body, tags)
  VALUES (new.rowid, new.title, new.body, new.tags);
END;
"""

#: Words too common to narrow anything, plus the scaffolding of a request. They
#: are stripped from queries only -- the records keep their own text.
_STOP = frozenset("""
a an the and or but if then than that this these those is are was were be been
being do does did doing have has had having i me my we our you your it its of
to in on at for with from by as so no not can could should would will just
please help need want make made get got use used using how what why when where
which who whom about into over under again more most some any all both each
""".split())


def default_db(root: Path | None = None) -> Path:
    base = root or Path(os.environ.get("AUTORA_HOME", Path.home() / ".autora"))
    return Path(base) / "memory.db"


class MemoryStore:
    """The knowledge store. One file, openable by anything that speaks SQLite."""

    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path else default_db()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(_SCHEMA)
        self.db.commit()
        self._backfill_links()

    # -- writing ---------------------------------------------------------

    def write(
        self,
        kind: str,
        title: str,
        body: str,
        scope: str = GLOBAL,
        tags: Iterable[str] = (),
        status: str = "provisional",
        pinned: bool = False,
        source_session: str | None = None,
        source_seq: int | None = None,
        supersedes: str | None = None,
    ) -> Record:
        """Add a record, or confirm the one it repeats.

        Writing the same thing twice is the confirmation signal: a claim that
        turns up again under the same scope has earned more than provisional
        status. It also stops the store filling with near-duplicates, which is
        the usual way these things rot.
        """
        if kind not in KINDS:
            raise ValueError(f"kind must be one of {KINDS}, got {kind!r}")
        now = time.time()
        tags = [t.strip().lower() for t in tags if t and t.strip()]

        existing = self._same_as(title, scope)
        if existing is not None:
            merged = sorted(set(existing.tags) | set(tags))
            self.db.execute(
                "UPDATE records SET body=?, tags=?, status=?, updated=?, "
                "pinned=?, source_session=COALESCE(?, source_session), "
                "source_seq=COALESCE(?, source_seq) WHERE id=?",
                (body, " ".join(merged),
                 "confirmed" if existing.status != "retired" else existing.status,
                 now, int(pinned or existing.pinned), source_session, source_seq,
                 existing.id),
            )
            self.db.commit()
            return self.get(existing.id)  # type: ignore[return-value]

        record = Record(
            id=uuid.uuid4().hex[:10], kind=kind, scope=scope, title=title.strip(),
            body=body.strip(), tags=sorted(set(tags)), status=status, pinned=pinned,
            source_session=source_session, source_seq=source_seq,
            created=now, updated=now,
        )
        self.db.execute(
            "INSERT INTO records (id, kind, scope, title, body, tags, status, pinned,"
            " source_session, source_seq, created, updated) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (record.id, record.kind, record.scope, record.title, record.body,
             " ".join(record.tags), record.status, int(record.pinned),
             record.source_session, record.source_seq, record.created, record.updated),
        )
        if supersedes:
            # A contradicted belief is retired, not deleted: the record of having
            # believed it is part of why the new one is trusted.
            self.db.execute(
                "UPDATE records SET status='retired', superseded_by=?, updated=? WHERE id=?",
                (record.id, now, supersedes))
            self.link(supersedes, record.id, "superseded-by")
        self.db.commit()
        # A record only becomes part of a web once something connects it.
        self.relate(record)
        return record

    def _backfill_links(self) -> None:
        """Infer links once, for a store that predates inferring them.

        Only when there are records and no links at all: that pairing means
        nobody has linked anything, which before this existed was every store.
        Guarded so it cannot run repeatedly, and skipped for large stores where
        a startup pass would be felt.
        """
        try:
            records = self.db.execute(
                "SELECT COUNT(*) FROM records WHERE status != 'retired'").fetchone()[0]
            links = self.db.execute("SELECT COUNT(*) FROM links").fetchone()[0]
        except sqlite3.Error:
            return
        if records == 0 or links > 0 or records > 300:
            return
        self.relate_all()

    def relate(self, record: Record, limit: int = 3) -> int:
        """Connect a record to the ones it is plainly about.

        Links were only ever created by an explicit request from the model or
        by a supersede, so two facts about the same subject sat side by side
        with nothing between them and the web was a scatter of unconnected
        dots. The relationship was real; nothing was writing it down.

        Relatedness is inferred from the same index that answers recall -- a
        shared significant word, within one scope -- so it is wrong in the same
        ways recall is wrong rather than in some new way of its own. A shared
        word is required rather than trusting the ranking alone: BM25 will
        always return something, and a graph that links everything to
        everything says as little as one that links nothing.
        """
        own = set(_terms(f"{record.title} {' '.join(record.tags)}"))
        if not own:
            return 0
        made = 0
        for hit in self.search(record.title, scopes=[record.scope], limit=limit + 5):
            if made >= limit:
                break
            if hit.id == record.id:
                continue
            if own & set(_terms(f"{hit.title} {' '.join(hit.tags)}")):
                self.link(record.id, hit.id, "related")
                made += 1
        return made

    def relate_all(self, cap: int = 300) -> int:
        """Infer links across the whole store.

        For records written before anything inferred links. Idempotent -- the
        links table ignores duplicates -- so running it twice costs time and
        changes nothing.
        """
        made = 0
        for record in self.all()[:cap]:
            made += self.relate(record)
        return made

    def link(self, src: str, dst: str, rel: str = "related") -> None:
        if src == dst:
            return
        self.db.execute("INSERT OR IGNORE INTO links (src, dst, rel) VALUES (?,?,?)",
                        (src, dst, rel))
        self.db.commit()

    def forget(self, record_id: str, hard: bool = False) -> bool:
        """Retire a record, or erase it outright.

        Retiring is the default because a wrong memory usually wants to stay
        visible as a wrong memory. Hard delete exists because some things should
        genuinely leave the disk when asked.
        """
        if hard:
            cur = self.db.execute("DELETE FROM records WHERE id=?", (record_id,))
            self.db.execute("DELETE FROM links WHERE src=? OR dst=?", (record_id, record_id))
        else:
            cur = self.db.execute(
                "UPDATE records SET status='retired', updated=? WHERE id=?",
                (time.time(), record_id))
        self.db.commit()
        return cur.rowcount > 0

    def touch(self, ids: Iterable[str]) -> None:
        """Record that these were actually used, which is what ranks them later."""
        now = time.time()
        self.db.executemany("UPDATE records SET uses = uses + 1, last_used=? WHERE id=?",
                            [(now, i) for i in ids])
        self.db.commit()

    # -- reading ---------------------------------------------------------

    def get(self, record_id: str) -> Record | None:
        row = self.db.execute("SELECT * FROM records WHERE id=?", (record_id,)).fetchone()
        return _row(row) if row else None

    def all(self, include_retired: bool = False) -> list[Record]:
        sql = "SELECT * FROM records"
        if not include_retired:
            sql += " WHERE status != 'retired'"
        return [_row(r) for r in self.db.execute(sql + " ORDER BY updated DESC")]

    def links(self) -> list[dict[str, str]]:
        return [dict(r) for r in self.db.execute("SELECT src, dst, rel FROM links")]

    def search(
        self,
        query: str,
        scopes: Iterable[str] = (),
        limit: int = 12,
        include_retired: bool = False,
    ) -> list[Record]:
        """Rank by relevance, then by how much the record has earned trust.

        BM25 gives the lexical match. The rest is a small, explainable nudge:
        pinned first, confirmed over provisional, and records that have actually
        been used over ones that never have. No magic numbers you cannot reason
        about at 3am.
        """
        terms = _terms(query)
        scopes = list(scopes) or [GLOBAL]
        if not terms:
            rows = self.db.execute(
                f"SELECT * FROM records WHERE scope IN ({_qs(scopes)})"
                + ("" if include_retired else " AND status != 'retired'")
                + " ORDER BY pinned DESC, uses DESC, updated DESC LIMIT ?",
                (*scopes, limit)).fetchall()
            return [_row(r) for r in rows]

        match = " OR ".join(f'"{t}"' for t in terms)
        sql = (
            "SELECT r.*, bm25(records_fts) AS rank FROM records_fts "
            "JOIN records r ON r.rowid = records_fts.rowid "
            f"WHERE records_fts MATCH ? AND r.scope IN ({_qs(scopes)})"
            + ("" if include_retired else " AND r.status != 'retired'")
            + " ORDER BY rank LIMIT ?"
        )
        rows = self.db.execute(sql, (match, *scopes, limit * 3)).fetchall()

        def score(row: sqlite3.Row) -> float:
            s = -float(row["rank"])                      # bm25 is negative-better
            if row["pinned"]:
                s += 6.0
            if row["status"] == "confirmed":
                s += 1.5
            s += min(row["uses"], 5) * 0.3
            return -s

        return [_row(r) for r in sorted(rows, key=score)[:limit]]

    def _same_as(self, title: str, scope: str) -> Record | None:
        row = self.db.execute(
            "SELECT * FROM records WHERE scope=? AND lower(title)=lower(?)",
            (scope, title.strip())).fetchone()
        return _row(row) if row else None

    def close(self) -> None:
        self.db.close()


def _qs(items: list[str]) -> str:
    return ",".join("?" * len(items))


def _row(row: sqlite3.Row) -> Record:
    data = dict(row)
    data.pop("rank", None)
    data["tags"] = [t for t in (data.get("tags") or "").split(" ") if t]
    data["pinned"] = bool(data["pinned"])
    return Record(**data)


def _terms(query: str) -> list[str]:
    """Query words worth searching on.

    Stopwords are dropped and FTS syntax is stripped: a user sentence is not a
    query language, and letting `NOT` or a stray quote through turns a search
    into a syntax error.
    """
    words = re.findall(r"[A-Za-z0-9_./-]{2,}", query.lower())
    return [w for w in dict.fromkeys(words) if w not in _STOP][:12]
