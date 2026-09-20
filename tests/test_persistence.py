"""State survives a restart, and standing instructions reach the model.

Both of these are about a container that is recreated on every update: only
AUTORA_HOME is carried across, so anything written outside it is gone, and
anything the operator configured has to be read back from there rather than
held in the process.
"""

import asyncio
import os
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from autora.agent import DEFAULT_SYSTEM, compose_system
from autora.memory import MemoryStore, default_db
from autora.session import default_root
from autora.settings import MAX_PROMPT_CHARS, Settings, prompt_path


def test_state_follows_autora_home():
    """Memories and recordings must land in the one directory that persists."""
    with tempfile.TemporaryDirectory() as tmp:
        old = os.environ.get("AUTORA_HOME")
        os.environ["AUTORA_HOME"] = tmp
        try:
            assert default_db() == pathlib.Path(tmp) / "memory.db", default_db()
            assert default_root() == pathlib.Path(tmp) / "sessions", default_root()
        finally:
            if old is None:
                os.environ.pop("AUTORA_HOME", None)
            else:
                os.environ["AUTORA_HOME"] = old
        print("  memory + sessions follow home ... ok")


def test_memories_survive_reopening():
    """A new process on the same volume sees what the last one learned."""
    with tempfile.TemporaryDirectory() as tmp:
        db = pathlib.Path(tmp) / "memory.db"

        store = MemoryStore(db)
        written = store.write(
            kind="preference",
            title="Brian prefers brief summaries",
            body="Keep answers short unless asked to expand.",
            source_session="s1",
        )
        store.db.close()

        # A different MemoryStore over the same file is what a restart is.
        again = MemoryStore(db)
        found = again.get(written.id)
        assert found is not None, "a memory did not survive reopening the database"
        assert found.title == "Brian prefers brief summaries"
        print("  memories survive a restart ..... ok")


def test_instructions_are_added_not_substituted():
    plain = compose_system("")
    assert plain == DEFAULT_SYSTEM, "no instructions must leave the prompt alone"

    combined = compose_system("Be concise. Never invent facts.")
    # The harness's own rules are how the UI works; they must still be there.
    assert DEFAULT_SYSTEM in combined, "the default prompt must not be replaced"
    assert "Be concise. Never invent facts." in combined
    assert combined.index(DEFAULT_SYSTEM) < combined.index("Be concise"), \
        "house rules belong after the operating manual, not before it"
    print("  instructions add, not replace ... ok")


def test_prompt_round_trips_in_its_own_file():
    with tempfile.TemporaryDirectory() as tmp:
        env = pathlib.Path(tmp) / "autora.env"
        s = Settings.load(env)
        assert s.system_prompt == ""

        s.merge({"system_prompt": "  Be concise.\nNever guess.  "})
        s.save(env)

        # Prose does not belong in a KEY=value file.
        assert prompt_path(env).exists()
        assert "Be concise." not in env.read_text(), \
            "the prompt must not be written into the env file"

        again = Settings.load(env)
        assert again.system_prompt == "Be concise.\nNever guess."
        assert again.redacted()["system_prompt"] == "Be concise.\nNever guess."

        # Cleared means gone, not an empty file that looks like it still says
        # something.
        again.merge({"system_prompt": "   "})
        again.save(env)
        assert not prompt_path(env).exists()
        assert Settings.load(env).system_prompt == ""
        print("  prompt round trips ............. ok")


def test_prompt_is_capped():
    with tempfile.TemporaryDirectory() as tmp:
        env = pathlib.Path(tmp) / "autora.env"
        s = Settings.load(env)
        s.merge({"system_prompt": "x" * (MAX_PROMPT_CHARS + 500)})
        assert len(s.system_prompt) == MAX_PROMPT_CHARS, len(s.system_prompt)
        print("  prompt is capped ............... ok")


def test_settings_survive_alongside_memory():
    """Everything an operator configured lives in the same persisted place."""
    with tempfile.TemporaryDirectory() as tmp:
        env = pathlib.Path(tmp) / "autora.env"
        s = Settings.load(env)
        s.merge({
            "provider": "deepseek",
            "system_prompt": "Be concise.",
            "credentials": {"DEEPSEEK_API_KEY": "sk-persisted-123456"},
        })
        s.save(env)

        back = Settings.load(env)
        assert back.provider == "deepseek"
        assert back.system_prompt == "Be concise."
        assert back.credentials["DEEPSEEK_API_KEY"] == "sk-persisted-123456"
        print("  settings survive a restart ..... ok")


async def main():
    test_state_follows_autora_home()
    test_memories_survive_reopening()
    test_instructions_are_added_not_substituted()
    test_prompt_round_trips_in_its_own_file()
    test_prompt_is_capped()
    test_settings_survive_alongside_memory()
    print("\nall persistence tests passed")


if __name__ == "__main__":
    asyncio.run(main())
