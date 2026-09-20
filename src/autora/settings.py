"""Runtime configuration: which model to talk to, and the keys to talk with.

Kept in one env-style file inside the data volume, which is also what the
container entrypoint reads at boot. So a key set from the UI and a key placed
there by hand are the same key in the same place, and neither depends on
compose substitution having reached the container.

Secrets go out of this module masked. The editor needs to know whether a key is
set and roughly which one it is, and nothing here needs to hand the whole thing
back to a browser to render that.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

#: Env var -> what it unlocks, for the editor to label itself with.
CREDENTIALS: dict[str, dict[str, str]] = {
    "ANTHROPIC_API_KEY": {
        "label": "Anthropic",
        "note": "Claude models.",
        "role": "model",
    },
    "DEEPSEEK_API_KEY": {
        "label": "DeepSeek",
        "note": "DeepSeek models. Takes priority over Anthropic when set.",
        "role": "model",
    },
    "DEEPGRAM_API_KEY": {
        "label": "Deepgram",
        "note": "Speech to text and text to speech.",
        "role": "voice",
    },
    "ASSEMBLYAI_API_KEY": {
        "label": "AssemblyAI",
        "note": "Speech to text.",
        "role": "voice",
    },
    "OPENAI_API_KEY": {
        "label": "OpenAI",
        "note": "Whisper transcription, when used.",
        "role": "voice",
    },
}

PROVIDERS = ["auto", "anthropic", "deepseek", "local"]

#: Non-secret settings, stored in the same file under these names.
PROVIDER_VAR = "AUTORA_PROVIDER"
MODEL_VAR = "AUTORA_MODEL"
BASE_URL_VAR = "AUTORA_LLM_BASE_URL"


def default_path() -> Path:
    """Where settings live.

    /data is the volume the Umbrel app persists and the entrypoint reads, so
    prefer it when it exists; fall back to the user's home for a bare checkout.
    """
    override = os.environ.get("AUTORA_ENV_FILE")
    if override:
        return Path(override)
    data = Path("/data")
    if data.is_dir():
        return data / "autora.env"
    return Path.home() / ".autora" / "autora.env"


def mask(value: str) -> str:
    """Enough of a key to recognise it by, and no more."""
    value = value.strip()
    if len(value) <= 8:
        return "•" * len(value)
    return f"{value[:3]}…{value[-4:]}"


def parse(text: str) -> dict[str, str]:
    """KEY=value lines, matching what the entrypoint accepts."""
    out: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key.strip()] = value.strip()
    return out


@dataclass
class Settings:
    provider: str = "auto"
    model: str = ""
    base_url: str = ""
    credentials: dict[str, str] = field(default_factory=dict)

    # -- storage --------------------------------------------------------

    @classmethod
    def load(cls, path: Path | None = None) -> Settings:
        path = path or default_path()
        values: dict[str, str] = {}
        if path.exists():
            try:
                values = parse(path.read_text())
            except OSError:
                values = {}

        # The environment still wins on first read, so a key passed through
        # compose keeps working and does not need migrating into the file.
        creds = {}
        for name in CREDENTIALS:
            creds[name] = values.get(name) or os.environ.get(name, "")

        return cls(
            provider=values.get(PROVIDER_VAR) or os.environ.get(PROVIDER_VAR) or "auto",
            model=values.get(MODEL_VAR) or os.environ.get(MODEL_VAR) or "",
            base_url=values.get(BASE_URL_VAR) or os.environ.get(BASE_URL_VAR) or "",
            credentials={k: v for k, v in creds.items() if v},
        )

    def save(self, path: Path | None = None) -> None:
        path = path or default_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        lines = [
            "# Autora settings. One KEY=value per line.",
            "# Written by the settings editor; safe to edit by hand.",
            "",
        ]
        if self.provider and self.provider != "auto":
            lines.append(f"{PROVIDER_VAR}={self.provider}")
        if self.model:
            lines.append(f"{MODEL_VAR}={self.model}")
        if self.base_url:
            lines.append(f"{BASE_URL_VAR}={self.base_url}")
        for name in CREDENTIALS:
            value = self.credentials.get(name, "")
            if value:
                lines.append(f"{name}={value}")

        tmp = path.with_suffix(".tmp")
        tmp.write_text("\n".join(lines) + "\n")
        # Keys live here: readable by the owner only, and never world-readable
        # even for the moment between write and chmod.
        os.chmod(tmp, 0o600)
        tmp.replace(path)

    def apply_to_env(self) -> None:
        """Push into the process environment, which is what the rest reads."""
        for name in CREDENTIALS:
            value = self.credentials.get(name, "")
            if value:
                os.environ[name] = value
            else:
                os.environ.pop(name, None)
        for var, value in ((PROVIDER_VAR, self.provider),
                           (MODEL_VAR, self.model),
                           (BASE_URL_VAR, self.base_url)):
            if value:
                os.environ[var] = value
            else:
                os.environ.pop(var, None)

    # -- the API shape --------------------------------------------------

    def redacted(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "model": self.model,
            "base_url": self.base_url,
            "providers": PROVIDERS,
            "credentials": [
                {
                    "name": name,
                    "label": meta["label"],
                    "note": meta["note"],
                    "role": meta["role"],
                    "set": bool(self.credentials.get(name)),
                    "hint": mask(self.credentials[name]) if self.credentials.get(name) else "",
                }
                for name, meta in CREDENTIALS.items()
            ],
        }

    def merge(self, body: dict[str, Any]) -> Settings:
        """Apply an edit.

        A credential left out of the body is untouched -- the editor only ever
        sends one it was actually given, because it is shown a mask and cannot
        send back what it was never told. An empty string clears it.
        """
        if "provider" in body and body["provider"] in PROVIDERS:
            self.provider = body["provider"]
        if "model" in body:
            self.model = (body.get("model") or "").strip()
        if "base_url" in body:
            self.base_url = (body.get("base_url") or "").strip()

        for name, value in (body.get("credentials") or {}).items():
            if name not in CREDENTIALS:
                continue
            value = (value or "").strip()
            if value:
                self.credentials[name] = value
            else:
                self.credentials.pop(name, None)
        return self


def build_provider(settings: Settings):
    """The model client these settings describe.

    Priority when the choice is left on auto: DeepSeek, then Anthropic, then a
    local OpenAI-compatible server. The last is a fallback rather than a
    preference, so it is marked as one -- unreachable localhost is a baffling
    error until you know nothing else was configured.
    """
    choice = settings.provider or "auto"
    creds = settings.credentials

    if choice == "deepseek" or (choice == "auto" and creds.get("DEEPSEEK_API_KEY")):
        from .providers.openai_compat import OpenAICompatProvider
        return OpenAICompatProvider(
            model=settings.model or "deepseek-flash",
            base_url=settings.base_url or "https://api.deepseek.com/v1",
            api_key=creds.get("DEEPSEEK_API_KEY"),
        )

    if choice == "anthropic" or (choice == "auto" and creds.get("ANTHROPIC_API_KEY")):
        from .providers.anthropic_provider import AnthropicProvider
        return AnthropicProvider(model=settings.model or "claude-sonnet-5")

    from .providers.openai_compat import OpenAICompatProvider
    provider = OpenAICompatProvider(
        model=settings.model or "qwen3-coder",
        base_url=settings.base_url or None,
    )
    if choice == "auto":
        provider.selected_because = (
            "no Anthropic or DeepSeek key is set, so Autora fell back to a local "
            "OpenAI-compatible server"
        )
    return provider
