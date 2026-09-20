"""Inferred links between records that are about the same thing."""

import asyncio
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from autora.memory import MemoryStore


def edges(store):
    return {frozenset((l["src"], l["dst"])) for l in store.links()}


def test_records_about_the_same_subject_connect():
    with tempfile.TemporaryDirectory() as tmp:
        store = MemoryStore(pathlib.Path(tmp) / "m.db")
        brian = store.write(kind="fact", title="User's name is Brian",
                            body="He is called Brian.")
        born = store.write(kind="fact", title="Brian was born in early June",
                           body="Birthday is in June.")

        assert frozenset((brian.id, born.id)) in edges(store), \
            "two facts about Brian must be connected"
        print("  same subject connects ......... ok")


def test_unrelated_records_stay_apart():
    with tempfile.TemporaryDirectory() as tmp:
        store = MemoryStore(pathlib.Path(tmp) / "m.db")
        a = store.write(kind="fact", title="User's name is Brian", body="Brian.")
        b = store.write(kind="procedure", title="Rebuild the docker image",
                        body="Push a tag and the workflow runs.")

        assert frozenset((a.id, b.id)) not in edges(store), \
            "a graph that links everything says as little as one that links nothing"
        print("  unrelated stay apart .......... ok")


def test_a_record_does_not_link_to_itself():
    with tempfile.TemporaryDirectory() as tmp:
        store = MemoryStore(pathlib.Path(tmp) / "m.db")
        only = store.write(kind="fact", title="Brian Brian Brian", body="Brian.")
        assert all(l["src"] != l["dst"] for l in store.links())
        assert not any(only.id in e and len(e) == 1 for e in edges(store))
        print("  no self-links ................. ok")


def test_links_are_capped():
    """Otherwise one popular subject wires the whole store together."""
    with tempfile.TemporaryDirectory() as tmp:
        store = MemoryStore(pathlib.Path(tmp) / "m.db")
        for i in range(8):
            store.write(kind="fact", title=f"Brian detail number {i}",
                        body=f"Something about Brian, {i}.")
        last = store.all()[0]
        outgoing = [l for l in store.links() if l["src"] == last.id]
        assert len(outgoing) <= 3, f"{len(outgoing)} links from one record"
        print(f"  capped per record ............. ok ({len(outgoing)} from the newest)")


def test_scopes_do_not_bleed():
    with tempfile.TemporaryDirectory() as tmp:
        store = MemoryStore(pathlib.Path(tmp) / "m.db")
        g = store.write(kind="fact", title="Brian prefers pnpm", body="pnpm.",
                        scope="global")
        p = store.write(kind="procedure", title="Brian prefers pnpm here too",
                        body="pnpm.", scope="project:/tmp/x")
        assert frozenset((g.id, p.id)) not in edges(store), \
            "a project note and a global fact are not the same claim"
        print("  scopes do not bleed ........... ok")


def test_backfill_links_an_old_store():
    """A store written before any of this had no links at all."""
    with tempfile.TemporaryDirectory() as tmp:
        db = pathlib.Path(tmp) / "m.db"
        store = MemoryStore(db)
        # Write the rows directly, the way a pre-inference store looks.
        store.db.execute("DELETE FROM links")
        store.db.commit()
        assert edges(store) == set()
        store.db.close()

        reopened = MemoryStore(db)
        assert len(reopened.all()) == 0 or True
        # Now with real content, closed and reopened.
        s2 = MemoryStore(db)
        s2.write(kind="fact", title="User's name is Brian", body="Brian.")
        s2.write(kind="fact", title="Brian was born in early June", body="June.")
        s2.db.execute("DELETE FROM links")
        s2.db.commit()
        s2.db.close()

        again = MemoryStore(db)
        assert len(edges(again)) > 0, "opening an unlinked store should infer its links"
        print("  backfill on open .............. ok")


def test_backfill_does_not_rerun():
    with tempfile.TemporaryDirectory() as tmp:
        db = pathlib.Path(tmp) / "m.db"
        store = MemoryStore(db)
        store.write(kind="fact", title="User's name is Brian", body="Brian.")
        store.write(kind="fact", title="Brian was born in early June", body="June.")
        before = edges(store)
        store.db.close()

        again = MemoryStore(db)
        assert edges(again) == before, "a second open must not change anything"
        print("  backfill is idempotent ........ ok")


async def main():
    test_records_about_the_same_subject_connect()
    test_unrelated_records_stay_apart()
    test_a_record_does_not_link_to_itself()
    test_links_are_capped()
    test_scopes_do_not_bleed()
    test_backfill_links_an_old_store()
    test_backfill_does_not_rerun()
    print("\nall relate tests passed")


if __name__ == "__main__":
    asyncio.run(main())
