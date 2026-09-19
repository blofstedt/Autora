"""What the agent says out loud, and when.

The received wisdom is that bad agent voice is a TTS quality problem, so the fix
is a better vocoder. That is mostly wrong. The things that make a voice agent
unbearable are, in order:

  1. It reads code, JSON, file paths and UUIDs aloud. Nothing destroys the
     illusion faster than hearing "slash home slash user slash dot config slash
     app dot t s x".
  2. It cannot be interrupted, so the only way to correct it is to wait.
  3. It says nothing for the ninety seconds a tool runs, so you cannot tell the
     difference between thinking and crashed.
  4. It waits for the whole response before speaking, adding seconds of latency
     no vocoder can win back.

Kokoro at 82M parameters is perfectly pleasant. This module fixes 1, 3 and 4;
the agent loop's cancellation fixes 2. Swapping the TTS model is the last thing
to try, not the first.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

#: Fenced code blocks, inline code, and JSON-ish blobs. Spoken, these are noise.
_FENCE_RE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`[^`]+`")
_JSON_RE = re.compile(r"\{[^{}]*[:,][^{}]*\}")
_URL_RE = re.compile(r"https?://\S+")
_PATH_RE = re.compile(r"(?:(?<=\s)|^)(?:~|\.{0,2})/[\w./\-]{2,}")
_HASH_RE = re.compile(r"\b[0-9a-f]{7,64}\b")
_MD_RE = re.compile(r"[*_#>]+")

#: Abbreviations that end in a period but not a sentence. Gemini's blueprint
#: flushes TTS on any "." or ",", which splits "e.g." and "3.5" mid-word and
#: makes the speech stutter.
_ABBREVIATIONS = {
    "e.g.", "i.e.", "etc.", "vs.", "approx.", "dr.", "mr.", "mrs.", "ms.",
    "st.", "fig.", "no.", "cf.", "al.",
}

_SENTENCE_END_RE = re.compile(r"(?<=[.!?])\s+")


def speakable(text: str) -> str:
    """Strip what should never be read aloud, leaving prose.

    Substitutions rather than deletions where a human would still want to know
    something was there -- "the file" is better than a silent gap that makes the
    sentence ungrammatical.
    """
    out = _FENCE_RE.sub(" the code below ", text)
    out = _INLINE_CODE_RE.sub(" that ", out)
    out = _JSON_RE.sub(" the payload ", out)
    out = _URL_RE.sub(" the link ", out)
    out = _HASH_RE.sub(" that hash ", out)
    # Speak only the basename: the directory chain is never the useful part.
    out = _PATH_RE.sub(lambda m: " " + m.group(0).rstrip("/").split("/")[-1] + " ", out)
    out = _MD_RE.sub("", out)
    out = re.sub(r"\s{2,}", " ", out)
    return out.strip()


def _ends_sentence(fragment: str) -> bool:
    stripped = fragment.rstrip()
    if not stripped or stripped[-1] not in ".!?":
        return False
    last_word = stripped.split()[-1].lower() if stripped.split() else ""
    if last_word in _ABBREVIATIONS:
        return False
    # A decimal or version number: "3." in "3.5" is not a sentence boundary.
    if re.search(r"\d\.$", stripped):
        return False
    # A single initial, as in "J. Smith".
    if re.search(r"(?:^|\s)[A-Za-z]\.$", stripped):
        return False
    return True


@dataclass
class ClauseChunker:
    """Splits a token stream into speakable clauses, as early as is safe.

    Speaking clause-by-clause is what makes a voice agent feel immediate: the
    first sentence is already playing while the model is still generating the
    third. The risk is splitting too eagerly and producing chopped, robotic
    delivery, so a clause is emitted only at a genuine sentence boundary, or
    once a soft boundary (comma, semicolon, dash) is far enough in that waiting
    longer would be more noticeable than the split.
    """

    min_chars: int = 40
    max_chars: int = 220
    buffer: str = ""
    _pending: list[str] = field(default_factory=list)

    def feed(self, delta: str) -> list[str]:
        """Add streamed text; return any clauses ready to speak."""
        self.buffer += delta
        ready: list[str] = []

        while True:
            clause = self._take()
            if clause is None:
                break
            cleaned = speakable(clause)
            if cleaned:
                ready.append(cleaned)
        return ready

    def _take(self) -> str | None:
        if not self.buffer.strip():
            return None

        # Hard boundary: a real sentence end.
        for match in _SENTENCE_END_RE.finditer(self.buffer):
            candidate = self.buffer[: match.start()]
            if _ends_sentence(candidate) and len(candidate.strip()) >= 1:
                self.buffer = self.buffer[match.end():]
                return candidate.strip()

        # Soft boundary: only once there is enough text that a split will not
        # sound clipped.
        if len(self.buffer) >= self.min_chars:
            for sep in (";", " — ", ", "):
                index = self.buffer.rfind(sep)
                if index >= self.min_chars:
                    clause = self.buffer[:index + len(sep)]
                    self.buffer = self.buffer[index + len(sep):]
                    return clause.strip()

        # Runaway sentence: flush at a word boundary rather than let latency grow.
        if len(self.buffer) >= self.max_chars:
            cut = self.buffer.rfind(" ", 0, self.max_chars)
            cut = cut if cut > self.min_chars else self.max_chars
            clause = self.buffer[:cut]
            self.buffer = self.buffer[cut:]
            return clause.strip()

        return None

    def flush(self) -> list[str]:
        """Emit whatever is left at end of turn."""
        remainder = speakable(self.buffer)
        self.buffer = ""
        return [remainder] if remainder else []


#: Spoken stand-ins for tool calls. Reading the command aloud is both tedious
#: and useless -- you are watching the terminal, you can see the command. What
#: you cannot see from across the room is *that something started*.
_TOOL_NARRATION = {
    "bash": "Running that now.",
    "read_file": "Reading the file.",
    "write_file": "Writing that file.",
    "edit_file": "Making the edit.",
    "list_dir": "Looking at the directory.",
    "browser": "Opening the browser.",
    "computer": "Taking over the screen.",
}

_BROWSER_NARRATION = {
    "goto": "Loading the page.",
    "click": "Clicking it.",
    "type": "Typing that in.",
    "read": "Reading the page.",
    "screenshot": "Grabbing a screenshot.",
    "scroll": "Scrolling down.",
}


def narrate_tool(name: str, args: dict) -> str:
    """One short spoken line for a tool call.

    Deliberately generic. A specific narration ("running pytest on the auth
    module") requires reading the arguments aloud, which is exactly what this is
    avoiding, and the screen already shows it.
    """
    if name == "browser":
        return _BROWSER_NARRATION.get(str(args.get("action")), "Working in the browser.")
    return _TOOL_NARRATION.get(name, "Working on it.")


def narrate_approval(reason: str) -> str:
    """Spoken prompt for a permission request. Must be answerable by voice."""
    return f"I need your okay first. {reason} Should I go ahead?"


#: Words that mean yes and no, for answering an approval by voice. Kept
#: deliberately tight: a mis-heard "yeah" that deploys to production is exactly
#: the failure the gate exists to prevent, so anything ambiguous is a no.
_AFFIRMATIVE = {"yes", "yeah", "yep", "yup", "sure", "go ahead", "do it",
                "approved", "affirmative", "go for it", "send it", "okay", "ok"}
_NEGATIVE = {"no", "nope", "stop", "cancel", "don't", "dont", "deny", "abort",
             "wait", "hold on", "negative"}


def interpret_decision(utterance: str) -> bool | None:
    """Map speech to an approval decision. None means 'unclear, ask again'."""
    text = re.sub(r"[^\w\s']", " ", utterance.lower()).strip()
    text = re.sub(r"\s+", " ", text)
    if not text:
        return None
    # Check negatives first: "no, go ahead" is rare, "yes... no wait" is not.
    for phrase in _NEGATIVE:
        if re.search(rf"\b{re.escape(phrase)}\b", text):
            return False
    for phrase in _AFFIRMATIVE:
        if re.search(rf"\b{re.escape(phrase)}\b", text):
            return True
    return None
