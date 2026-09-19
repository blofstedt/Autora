"""Narration tests -- the part of voice quality that has nothing to do with TTS."""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from autora.voice.narration import (
    ClauseChunker, interpret_decision, narrate_tool, speakable,
)


def test_speakable_strips_unspeakable():
    cases = [
        ("Run `npm test` and check", "npm test"),
        ("See /home/user/project/src/app.tsx for that", "/home/user"),
        ("The commit is a3f9c2b1e4d5a6b7c8d9e0f1a2b3c4d5e6f7a8b9", "a3f9c2b1"),
        ("Visit https://example.com/docs?x=1 now", "https://"),
        ("Got {\"status\": \"ok\", \"id\": 3}", '{"status"'),
    ]
    for source, forbidden in cases:
        out = speakable(source)
        assert forbidden not in out, f"{forbidden!r} survived in {out!r}"
    assert "app.tsx" in speakable("See /home/user/project/src/app.tsx for that")
    assert speakable("```\ncode\n```") == "the code below"
    print("  strips code/paths/urls/hashes ... ok")


def test_chunker_respects_abbreviations():
    chunker = ClauseChunker()
    spoken = []
    for token in ["The build takes 3.5 ", "seconds, e.g. ", "on my machine. ", "Then it passes."]:
        spoken.extend(chunker.feed(token))
    spoken.extend(chunker.flush())
    joined = " ".join(spoken)
    # Neither "3.5" nor "e.g." may be split across clauses.
    assert not any(c.strip().endswith("3.") for c in spoken), spoken
    assert not any(c.strip().endswith("e.g.") and len(c.strip()) < 10 for c in spoken), spoken
    assert "3.5" in joined and "e.g." in joined
    print(f"  abbreviations/decimals intact .. ok ({len(spoken)} clauses)")


def test_chunker_emits_early():
    """The first clause must be speakable before the response is finished."""
    chunker = ClauseChunker()
    first = chunker.feed("I'll check the config file first. ")
    assert first and first[0].startswith("I'll check"), first
    # Nothing else yet -- the rest is still streaming.
    assert chunker.buffer == ""
    print("  speaks first clause early ...... ok")


def test_chunker_flushes_runaway():
    chunker = ClauseChunker(max_chars=80)
    out = chunker.feed("word " * 40)
    assert out, "a sentence with no end must still flush"
    assert all(len(c) <= 100 for c in out), [len(c) for c in out]
    print("  runaway sentence flushed ....... ok")


def test_tool_narration_is_not_the_command():
    line = narrate_tool("bash", {"command": "pytest -q tests/test_auth.py::test_login"})
    assert "pytest" not in line and "::" not in line
    assert narrate_tool("browser", {"action": "click"}) == "Clicking it."
    print("  tool narration says intent ..... ok")


def test_voice_approval_is_conservative():
    assert interpret_decision("yes go ahead") is True
    assert interpret_decision("yeah") is True
    assert interpret_decision("no stop") is False
    assert interpret_decision("wait") is False
    # Ambiguity must never be read as consent.
    assert interpret_decision("hmm") is None
    assert interpret_decision("") is None
    assert interpret_decision("what does that do") is None
    # A hedge containing both must not approve.
    assert interpret_decision("yes, no wait") is False
    print("  voice approval fails safe ...... ok")


if __name__ == "__main__":
    for fn in [v for k, v in sorted(globals().items()) if k.startswith("test_")]:
        fn()
    print("\nall narration tests passed")
