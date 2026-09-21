"""A session list you can read.

Sessions are found by id and recognised by name, and for a while they had only
the first: the container passed `--title Autora` on every start, so every row
in the picker said "Autora" -- and because a title given deliberately outranks
the one a session takes from its first message, the name it would otherwise
have had never got written.

So two rules are under test. A title that every session shares is not a name,
and is treated as absent. And a session that was recorded under one can still
recover a real name, because the log already holds the answer.
"""

import json
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from autora.session import Session, SessionRegistry, is_placeholder, title_from


def test_placeholder_titles_are_not_names():
    assert is_placeholder("")
    assert is_placeholder("   ")
    assert is_placeholder("Autora")
    assert is_placeholder("autora")
    assert is_placeholder("Untitled session")
    assert not is_placeholder("Fix the failing deploy")
    print("  the app's own name is not a session name ... ok")


def test_title_from_takes_the_first_thought():
    assert title_from("Fix the deploy. Then tell me why it broke.") == "Fix the deploy."
    assert title_from("Fix the deploy\nand the tests") == "Fix the deploy"
    long = title_from("x" * 200)
    assert len(long) <= 60, long
    assert long.endswith("…")
    assert title_from("   ") == ""
    print("  first sentence, clipped to a row ... ok")


def test_first_message_names_a_session_the_container_labelled():
    """The label every session shares must not block the one that is its own."""
    with tempfile.TemporaryDirectory() as tmp:
        session = Session(root=pathlib.Path(tmp), title="Autora")
        session.name_from("Work out why the nightly build is red")
        assert session.title == "Work out why the nightly build is red", session.title

        # A title someone actually chose still wins.
        deliberate = Session(root=pathlib.Path(tmp), title="Nightly build")
        deliberate.name_from("Work out why the nightly build is red")
        assert deliberate.title == "Nightly build", deliberate.title
        print("  a shared label yields, a chosen one does not ... ok")


def test_recorded_sessions_recover_their_names():
    """Sessions already on disk under the old label get read back, not stranded."""
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        registry = SessionRegistry(root)
        session = registry.create(title="Autora")
        session.emit("turn.user", {"text": "Summarise yesterday's errors"}, actor="user")
        # Simulate the old behaviour: the label was written to meta and the
        # session never renamed itself.
        session.title = "Autora"
        session.checkpoint()
        registry.live.clear()

        rows = SessionRegistry(root).list()
        assert len(rows) == 1, rows
        assert rows[0]["title"] == "Summarise yesterday's errors", rows[0]

        # And it is cached back, so the log is scanned once rather than on
        # every poll of the list.
        meta = json.loads((root / session.id / "meta.json").read_text())
        assert meta["title"] == "Summarise yesterday's errors", meta
        assert "live" not in meta, meta
        print("  a recorded session recovers its name from its log ... ok")


def test_a_session_with_nothing_asked_of_it_stays_unnamed():
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        registry = SessionRegistry(root)
        registry.create(title="Autora")
        registry.live.clear()
        rows = SessionRegistry(root).list()
        assert rows[0]["title"] == "", rows[0]
        print("  nothing asked, nothing to name it after ... ok")


if __name__ == "__main__":
    test_placeholder_titles_are_not_names()
    test_title_from_takes_the_first_thought()
    test_first_message_names_a_session_the_container_labelled()
    test_recorded_sessions_recover_their_names()
    test_a_session_with_nothing_asked_of_it_stays_unnamed()
    print("\nall naming tests passed")
