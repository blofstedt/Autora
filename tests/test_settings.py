"""Settings storage, masking, and provider selection."""

import asyncio
import os
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from autora.settings import Settings, build_provider, mask, parse

CLEARED = ("ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "DEEPGRAM_API_KEY",
           "ASSEMBLYAI_API_KEY", "OPENAI_API_KEY", "AUTORA_PROVIDER",
           "AUTORA_MODEL", "AUTORA_LLM_BASE_URL")


def clean_env():
    for name in CLEARED:
        os.environ.pop(name, None)


def test_parse_matches_the_entrypoint():
    text = "# comment\n\nA=1\nB=with spaces and = signs\nC=\nnot a pair\n"
    assert parse(text) == {"A": "1", "B": "with spaces and = signs", "C": ""}
    print("  parse matches entrypoint ...... ok")


def test_mask_never_reveals_the_middle():
    assert mask("sk-deepseek-secret-9876") == "sk-…9876"
    assert mask("short") == "•••••"
    assert "secret" not in mask("sk-deepseek-secret-9876")
    print("  mask hides the middle ......... ok")


def test_round_trip_and_permissions():
    clean_env()
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / "autora.env"
        s = Settings.load(path)
        assert s.provider == "auto" and s.credentials == {}

        s.merge({"provider": "deepseek", "model": "deepseek-v4-pro",
                 "credentials": {"DEEPSEEK_API_KEY": "sk-abc123456789"}})
        s.save(path)

        assert oct(path.stat().st_mode & 0o777) == "0o600", "keys must not be world-readable"

        again = Settings.load(path)
        assert again.provider == "deepseek"
        assert again.model == "deepseek-v4-pro"
        assert again.credentials["DEEPSEEK_API_KEY"] == "sk-abc123456789"
        print("  round trip + 0600 ............. ok")


def test_redacted_payload_carries_no_secret():
    clean_env()
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / "autora.env"
        s = Settings.load(path)
        s.merge({"credentials": {"DEEPSEEK_API_KEY": "sk-thisisthesecret1234"}})
        payload = s.redacted()
        assert "thisisthesecret" not in repr(payload)
        row = [c for c in payload["credentials"] if c["name"] == "DEEPSEEK_API_KEY"][0]
        assert row["set"] is True and row["hint"] == "sk-…1234"
        print("  redacted payload is safe ...... ok")


def test_absent_credential_is_untouched_empty_clears():
    clean_env()
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / "autora.env"
        s = Settings.load(path)
        s.merge({"credentials": {"DEEPSEEK_API_KEY": "sk-keep-me-123456"}})

        # An edit that does not mention the key must not drop it -- the editor
        # is shown a mask and cannot send back what it was never given.
        s.merge({"provider": "auto"})
        assert s.credentials.get("DEEPSEEK_API_KEY") == "sk-keep-me-123456"

        # An explicit empty string is how you remove one.
        s.merge({"credentials": {"DEEPSEEK_API_KEY": ""}})
        assert "DEEPSEEK_API_KEY" not in s.credentials
        print("  absent keeps, empty clears .... ok")


def test_provider_selection():
    clean_env()
    s = Settings()
    fallback = build_provider(s)
    assert fallback.model == "qwen3-coder"
    assert fallback.selected_because, "an unconfigured fallback must explain itself"

    s.credentials["DEEPSEEK_API_KEY"] = "sk-x"
    chosen = build_provider(s)
    assert chosen.model == "deepseek-flash"
    assert "api.deepseek.com" in chosen.base_url
    assert not chosen.selected_because, "a deliberate choice needs no excuse"

    # DeepSeek wins on auto when both are present, which is worth pinning:
    # it is the rule that quietly moved someone off Anthropic.
    s.credentials["ANTHROPIC_API_KEY"] = "sk-ant-y"
    assert build_provider(s).model == "deepseek-flash"

    # Asking for one explicitly overrides that.
    s.provider = "anthropic"
    assert "claude" in build_provider(s).model
    print("  provider selection ............ ok")


def test_explicit_local_is_not_a_fallback():
    clean_env()
    s = Settings(provider="local", base_url="http://ollama:11434/v1")
    p = build_provider(s)
    assert p.base_url == "http://ollama:11434/v1"
    assert not p.selected_because, "chosen on purpose, so nothing to warn about"
    print("  explicit local is not warned .. ok")


async def main():
    test_parse_matches_the_entrypoint()
    test_mask_never_reveals_the_middle()
    test_round_trip_and_permissions()
    test_redacted_payload_carries_no_secret()
    test_absent_credential_is_untouched_empty_clears()
    test_provider_selection()
    test_explicit_local_is_not_a_fallback()
    print("\nall settings tests passed")


if __name__ == "__main__":
    asyncio.run(main())


def test_a_hand_added_setting_survives_a_save():
    """The file says it is safe to edit by hand, so it has to be.

    `AUTORA_TLS=1` was added here to turn the https listener on, and a later
    Save in the settings panel silently removed it -- rebuilding the file from
    the names the editor knows about. The listener stopped, and the symptom was
    a browser refusing the secure page, which is indistinguishable from a
    certificate being rejected. It was debugged as the latter, for hours.
    """
    import pathlib as _pathlib
    import tempfile as _tempfile

    with _tempfile.TemporaryDirectory() as tmp:
        env = _pathlib.Path(tmp) / "autora.env"
        env.write_text(
            "AUTORA_PROVIDER=deepseek\n"
            "DEEPSEEK_API_KEY=sk-old\n"
            "AUTORA_TLS=1\n"
            "AUTORA_TLS_PORT=8818\n"
        )
        settings = Settings.load(env)
        settings.credentials["DEEPSEEK_API_KEY"] = "sk-new"
        settings.save(env)

        written = env.read_text()
        assert "AUTORA_TLS=1" in written, written
        assert "AUTORA_TLS_PORT=8818" in written, written
        assert "sk-new" in written and "sk-old" not in written, written
        print("  a setting the editor does not know about is kept ... ok")
