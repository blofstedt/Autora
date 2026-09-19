"""The permission gate.

A voice-driven agent holding shell access and production credentials needs a
gate, and it needs one *before* it is fun to use, not after. Speech recognition
misfires. "Push that to staging" and "push that to stage" differ by a phoneme.
An agent that hears the wrong one and runs `supabase db push` against prod has
done something no amount of replay footage undoes.

Three decisions:

  ALLOW -- run it, just record it. Reads, greps, builds, test runs.
  ASK   -- suspend the agent, surface the exact command in the UI, wait for a
           human. Writes, deploys, migrations, network mutations.
  DENY  -- refuse outright and tell the agent why, so it can route around
           instead of retrying. Unrecoverable things.

The gate is deliberately pattern-based and readable rather than clever. You will
be editing these rules while annoyed, and a regex you can eyeball beats a
scoring model you have to trust.
"""

from __future__ import annotations

import asyncio
import re
import shlex
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable

from .events import Kind


class Decision(str, Enum):
    ALLOW = "allow"
    ASK = "ask"
    DENY = "deny"


@dataclass
class Rule:
    """One pattern -> decision mapping.

    `tools` matches tool names (exact, or "*"). `pattern` is matched against a
    normalized rendering of the arguments. `reason` is shown to the human on ASK
    and returned to the model on DENY -- write it as an explanation, since the
    model reads it and will try something else.
    """

    decision: Decision
    reason: str
    tools: tuple[str, ...] = ("*",)
    pattern: str | None = None
    _compiled: re.Pattern[str] | None = field(default=None, init=False, repr=False)

    def __post_init__(self) -> None:
        if self.pattern:
            self._compiled = re.compile(self.pattern, re.IGNORECASE)

    def matches(self, tool: str, rendered: str) -> bool:
        if "*" not in self.tools and tool not in self.tools:
            return False
        if self._compiled is None:
            return True
        return self._compiled.search(rendered) is not None


def default_rules() -> list[Rule]:
    """Rules are evaluated in order; the first match wins.

    DENY rules therefore come first -- a later ALLOW must never be able to
    shadow a hard stop.
    """
    return [
        # ---- Hard denials: no dialog, no override from the model. ----
        Rule(Decision.DENY, "Recursive deletion of a root or home path is never "
             "what was meant. Delete specific paths instead.",
             tools=("bash",), pattern=r"rm\s+(-[a-z]*[rf][a-z]*\s+)+(/|~|\$HOME|/\*)\s*$"),
        Rule(Decision.DENY, "Disk-level writes can destroy the machine. Refused.",
             tools=("bash",), pattern=r"\b(mkfs|dd)\b.*\bof=/dev/"),
        Rule(Decision.DENY, "Forced history rewrites on shared branches lose other "
             "people's work. Push to a feature branch instead.",
             tools=("bash",), pattern=r"git\s+push\b.*(--force|-f)\b(?!.*--force-with-lease)"
                                      r".*\b(main|master|prod|production)\b"),
        Rule(Decision.DENY, "Piping a remote script straight into a shell executes "
             "unreviewed code. Download it, read it, then run it.",
             tools=("bash",), pattern=r"(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|fi|)sh"),
        Rule(Decision.DENY, "Reading private keys or credential stores is out of scope.",
             pattern=r"(id_rsa|id_ed25519|\.aws/credentials|\.ssh/.*_key|\.env\.production)\b"),

        # ---- Confirmations: real actions with real consequences. ----
        Rule(Decision.ASK, "This changes a production database.",
             pattern=r"\b(db\s+push|db\s+reset|drop\s+table|drop\s+database|truncate\b|"
                     r"alter\s+table|delete\s+from)\b"),
        Rule(Decision.ASK, "This deploys to a live environment.",
             pattern=r"\b(vercel\s+(deploy|--prod|promote)|supabase\s+(link|db\s+push)|"
                     r"fly\s+deploy|kubectl\s+apply|terraform\s+apply|npm\s+publish)\b"),
        Rule(Decision.ASK, "This rewrites git history or moves a remote branch.",
             tools=("bash",), pattern=r"git\s+(push|reset\s+--hard|rebase|filter-branch|"
                                      r"branch\s+-D|checkout\s+--\s|clean\s+-[a-z]*f)"),
        Rule(Decision.ASK, "This installs software or changes system state.",
             tools=("bash",), pattern=r"\b(sudo|apt(-get)?\s+install|brew\s+install|"
                                      r"pip\s+install|npm\s+i(nstall)?\s+-g)\b"),
        Rule(Decision.ASK, "This sends money or contacts a payment API.",
             pattern=r"\b(stripe|paypal|checkout\.session|payment_intent|transfer|payout)\b"),
        Rule(Decision.ASK, "Desktop control acts on your real machine outside the sandbox.",
             tools=("computer",)),

        # ---- Explicit allowances for the common read-only loop. ----
        Rule(Decision.ALLOW, "Read-only inspection.",
             tools=("read_file", "list_dir", "grep", "browser_screenshot",
                    "browser_read", "glob")),
        # Anchored at the start of the *command value*, not the start of the
        # rendered string, and refuses shell metacharacters. Without that second
        # half, prefix-matching an allowlist is a hole you can drive through:
        # `cat README.md && ./something` would be allowed on the strength of its
        # innocuous first word. A chained command is not a read-only command, so
        # anything with ; & | > ` or $() falls through to the rules below.
        Rule(Decision.ALLOW, "Read-only shell.",
             tools=("bash",),
             pattern=r"(?:^|\bcommand=)\s*(ls|cat|head|tail|grep|rg|fd|find|wc|git\s+"
                     r"(?:status|log|diff|show|branch(?!\s+-D)|remote)|"
                     r"pwd|which|echo|jq|tree|du|ps)\b[^;&|><`$()\n]*$"),

        # ---- Default. ----
        # Writes, test runs, builds and unrecognized commands land here. ASK
        # rather than ALLOW: an agent that asks too often is annoying, one that
        # acts too freely is expensive. Loosen this per-project once you trust it.
        Rule(Decision.ASK, "Unclassified action -- review before running."),
    ]


def render_args(tool: str, args: dict[str, Any]) -> str:
    """Flatten tool arguments into one string for pattern matching.

    Matching a flattened rendering rather than specific fields means a rule
    still fires when a command hides in an unexpected argument -- a script body,
    a heredoc, an `--eval` payload. Over-matching here is the safe direction.
    """
    parts = [tool]
    for key, value in sorted(args.items()):
        if isinstance(value, (str, int, float, bool)):
            parts.append(f"{key}={value}")
        elif isinstance(value, (list, tuple)):
            parts.append(f"{key}=" + " ".join(str(v) for v in value))
        else:
            parts.append(f"{key}={value!r}")
    return " ".join(parts)


def human_render(tool: str, args: dict[str, Any]) -> str:
    """Render a call for a person to read and authorize.

    Deliberately separate from `render_args`, which flattens everything into one
    string so that patterns over-match (the safe direction for matching). That
    same flattening makes the approval prompt read
    `bash command=printf '\033[1;36m...'`, which is the single most important
    sentence in the UI and must be legible -- an unreadable prompt trains you to
    click through it, which defeats the gate entirely.
    """
    if tool == "bash":
        return str(args.get("command", "")).strip()
    if tool == "browser":
        action = args.get("action", "")
        target = args.get("url") or args.get("selector") or ""
        return f"browser: {action} {target}".strip()
    if tool in ("read_file", "write_file", "edit_file", "list_dir"):
        return f"{tool.replace('_', ' ')}: {args.get('path', '')}"
    if not args:
        return tool
    parts = ", ".join(
        f"{k}={str(v)[:60]}" for k, v in sorted(args.items())
        if isinstance(v, (str, int, float, bool))
    )
    return f"{tool}: {parts}" if parts else tool


@dataclass
class PolicyOutcome:
    decision: Decision
    reason: str
    rule: Rule | None = None
    approved_by: str | None = None


class PolicyGate:
    """Evaluates tool calls and, when needed, blocks on a human.

    The pending-approval map is the interesting part: an ASK emits a
    POLICY_REQUEST event (so it shows up in the live UI exactly like everything
    else) and awaits a future. The transport resolves that future when the human
    clicks. Timeouts deny rather than allow -- an unattended agent must wind down,
    not proceed.
    """

    def __init__(
        self,
        rules: list[Rule] | None = None,
        ask_timeout: float = 300.0,
        auto_approve: bool = False,
    ):
        self.rules = rules if rules is not None else default_rules()
        self.ask_timeout = ask_timeout
        #: Bypasses ASK (never DENY). For unattended runs and tests.
        self.auto_approve = auto_approve
        self._pending: dict[str, asyncio.Future[tuple[bool, str]]] = {}

    def evaluate(self, tool: str, args: dict[str, Any]) -> PolicyOutcome:
        """Pure classification -- no I/O, so it is trivial to unit test."""
        rendered = render_args(tool, args)
        for rule in self.rules:
            if rule.matches(tool, rendered):
                return PolicyOutcome(rule.decision, rule.reason, rule)
        return PolicyOutcome(Decision.ASK, "No rule matched.")

    async def authorize(self, session, tool: str, args: dict[str, Any]) -> PolicyOutcome:
        """Classify and, for ASK, wait for a human decision."""
        outcome = self.evaluate(tool, args)

        if outcome.decision is Decision.ALLOW:
            return outcome
        if outcome.decision is Decision.DENY:
            session.emit(Kind.POLICY_DECISION, {
                "tool": tool, "args": _redact(args), "decision": "deny",
                "reason": outcome.reason, "automatic": True,
            }, actor="system")
            return outcome

        if self.auto_approve:
            outcome.approved_by = "auto"
            session.emit(Kind.POLICY_DECISION, {
                "tool": tool, "args": _redact(args), "decision": "allow",
                "reason": "auto-approve enabled", "automatic": True,
            }, actor="system")
            return PolicyOutcome(Decision.ALLOW, "auto-approved", outcome.rule, "auto")

        request_id = uuid.uuid4().hex[:12]
        future: asyncio.Future[tuple[bool, str]] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future

        session.emit(Kind.POLICY_REQUEST, {
            "request_id": request_id, "tool": tool, "args": _redact(args),
            "reason": outcome.reason, "rendered": human_render(tool, _redact(args)),
            "timeout_s": self.ask_timeout,
        }, actor="system")

        try:
            approved, who = await asyncio.wait_for(
                asyncio.shield(future), timeout=self.ask_timeout
            )
        except asyncio.TimeoutError:
            approved, who = False, "timeout"
        finally:
            self._pending.pop(request_id, None)

        session.emit(Kind.POLICY_DECISION, {
            "request_id": request_id, "tool": tool,
            "decision": "allow" if approved else "deny",
            "by": who, "reason": outcome.reason,
        }, actor="user" if who not in ("timeout",) else "system")

        if approved:
            return PolicyOutcome(Decision.ALLOW, "approved by human", outcome.rule, who)
        return PolicyOutcome(
            Decision.DENY,
            f"Denied by {who}." if who != "timeout"
            else "No response within the approval window; treated as denied.",
            outcome.rule, who,
        )

    def resolve(self, request_id: str, approved: bool, who: str = "user") -> bool:
        """Called by the transport when a human answers. Returns False if the
        request is unknown or already settled."""
        future = self._pending.get(request_id)
        if future is None or future.done():
            return False
        future.set_result((approved, who))
        return True

    @property
    def pending(self) -> list[str]:
        return list(self._pending)


_SECRET_RE = re.compile(
    r"(?i)\b(sk-[a-z0-9-]{16,}|ghp_[a-z0-9]{20,}|gho_[a-z0-9]{20,}|"
    r"eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}|"
    r"AKIA[0-9A-Z]{16}|(?<=:)[^:@/\s]{8,}(?=@))"
)
_ASSIGN_RE = re.compile(
    r"(?i)\b([A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY)[A-Z_]*)"
    r"\s*[=:]\s*(\"|')?([^\s\"']{4,})"
)


def _redact(args: dict[str, Any]) -> dict[str, Any]:
    """Strip credentials before an event goes to the log.

    The log is the artifact people share when they show off a recording. It must
    not carry the token that was on the command line. Redaction happens here,
    at the boundary, because scrubbing after the fact never catches everything.
    """
    out: dict[str, Any] = {}
    for key, value in args.items():
        if isinstance(value, str):
            cleaned = _SECRET_RE.sub("«redacted»", value)
            cleaned = _ASSIGN_RE.sub(lambda m: f"{m.group(1)}={m.group(2) or ''}«redacted»", cleaned)
            out[key] = cleaned
        else:
            out[key] = value
    return out
