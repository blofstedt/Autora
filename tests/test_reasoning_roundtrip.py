"""Thinking that has to come back.

A model that reasons, calls a tool, and is then handed its own tool call with
the reasoning stripped out is being shown a turn it did not take. Most servers
shrug; DeepSeek's thinking mode refuses the request outright --

    BadRequestError: 400 - The `reasoning_content` in the thinking mode must be
    passed back to the API.

-- which, in a harness that rebuilds its history from the log on every request,
meant the session could not continue at all: the same history went back out on
the retry and failed the same way.

So the fold keeps the reasoning, the OpenAI adapter sends it where it is
wanted, and -- because nobody has standardised this and the opposite rule also
exists in the wild -- it takes correction from whichever 400 comes back.
"""

import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from autora.context import compose
from autora.events import Kind
from autora.providers.openai_compat import (
    _default_send_reasoning, _flip_on_complaint, _to_openai,
)
from autora.session import Session


class _Rejection(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def _log_a_thinking_tool_turn():
    tmp = tempfile.TemporaryDirectory()
    session = Session(root=pathlib.Path(tmp.name))
    session.emit(Kind.USER_MESSAGE, {"text": "what is in this directory"}, actor="user")
    session.emit(Kind.AGENT_THINKING, {"text": "They want a listing. "}, actor="agent")
    session.emit(Kind.AGENT_THINKING, {"text": "ls is enough."}, actor="agent")
    session.emit(Kind.AGENT_TEXT, {"text": "Listing it."}, actor="agent")
    span = session.open_span("terminal", Kind.TOOL_CALL,
                             {"args": {"cmd": "ls"}, "call_id": "call_1"}, actor="agent")
    session.close_span(span, Kind.TOOL_RESULT, {"ok": True, "preview": "README.md"},
                       actor="tool:terminal", blob=b"README.md")
    return tmp, session


def test_the_fold_keeps_the_thinking():
    tmp, session = _log_a_thinking_tool_turn()
    with tmp:
        messages = compose(session.store.read(), session.store.blobs)
        assistant = [m for m in messages if m["role"] == "assistant"]
        assert len(assistant) == 1, messages
        assert assistant[0]["reasoning"] == "They want a listing. ls is enough."
        assert assistant[0]["content"] == "Listing it."
        assert assistant[0]["tool_calls"][0]["name"] == "terminal"
        print("  reasoning survives the fold, attached to the turn it produced ... ok")


def test_thinking_alone_still_opens_the_turn():
    """A turn cut off after thinking must not lose it, or land on the wrong turn."""
    with tempfile.TemporaryDirectory() as tmp:
        session = Session(root=pathlib.Path(tmp))
        session.emit(Kind.USER_MESSAGE, {"text": "hello"}, actor="user")
        session.emit(Kind.AGENT_THINKING, {"text": "greeting"}, actor="agent")
        messages = compose(session.store.read(), session.store.blobs)
        assert messages[-1] == {"role": "assistant", "content": "", "reasoning": "greeting"}
        print("  thinking with nothing after it is still an assistant turn ... ok")


def test_only_the_unfinished_turn_carries_it_back():
    """A turn that called a tool is mid-flight; one that ended in prose is done."""
    messages = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "Listing it.", "reasoning": "ls is enough.",
         "tool_calls": [{"id": "call_1", "name": "terminal", "args": {"cmd": "ls"}}]},
        {"role": "tool", "tool_call_id": "call_1", "content": "README.md", "ok": True},
        {"role": "assistant", "content": "One file.", "reasoning": "that is all of it"},
    ]

    sent = _to_openai(messages, reasoning=True)
    assert sent[1]["reasoning_content"] == "ls is enough.", sent[1]
    assert "reasoning_content" not in sent[3], sent[3]

    withheld = _to_openai(messages, reasoning=False)
    assert all("reasoning_content" not in m for m in withheld), withheld
    print("  sent on the tool-calling turn, never on the finished one ... ok")


def test_the_endpoint_gets_a_guess_and_the_last_word():
    assert _default_send_reasoning("https://api.deepseek.com/v1")
    assert not _default_send_reasoning("http://localhost:8000/v1")

    must = _Rejection(
        "Error code: 400 - {'error': {'message': 'The `reasoning_content` in the "
        "thinking mode must be passed back to the API.'}}"
    )
    assert _flip_on_complaint(must, sending=False) is True
    # Already sending it and told to send it: flipping would only swap one
    # rejection for the other, so the error is the answer.
    assert _flip_on_complaint(must, sending=True) is None

    unwanted = _Rejection("400 - reasoning_content is not allowed in messages")
    assert _flip_on_complaint(unwanted, sending=True) is False
    assert _flip_on_complaint(unwanted, sending=False) is None

    unrelated = _Rejection("400 - model not found")
    assert _flip_on_complaint(unrelated, sending=False) is None
    assert _flip_on_complaint(Exception("boom"), sending=False) is None
    print("  the endpoint's own 400 settles it ... ok")


class _FakeCompletions:
    """Rejects the first attempt the way DeepSeek does, then records the retry."""

    def __init__(self):
        self.attempts = []

    async def create(self, **kwargs):
        self.attempts.append(kwargs["messages"])
        if len(self.attempts) == 1:
            raise _Rejection(
                "Error code: 400 - The `reasoning_content` in the thinking mode "
                "must be passed back to the API."
            )
        return _empty_stream()


def _empty_stream():
    class Stream:
        def __aiter__(self):
            return self

        async def __anext__(self):
            raise StopAsyncIteration

    return Stream()


class _FakeClient:
    def __init__(self):
        self.chat = type("chat", (), {})()
        self.chat.completions = _FakeCompletions()


async def test_a_rejection_is_answered_by_one_retry():
    from autora.providers.openai_compat import OpenAICompatProvider

    provider = OpenAICompatProvider(base_url="http://localhost:8000/v1")
    provider._client = _FakeClient()
    assert not provider.send_reasoning

    messages = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "Listing it.", "reasoning": "ls is enough.",
         "tool_calls": [{"id": "call_1", "name": "terminal", "args": {"cmd": "ls"}}]},
        {"role": "tool", "tool_call_id": "call_1", "content": "README.md", "ok": True},
    ]
    deltas = [d async for d in provider.stream("sys", messages, tools=[])]

    attempts = provider._client.chat.completions.attempts
    assert len(attempts) == 2, attempts
    assert "reasoning_content" not in attempts[0][2], attempts[0]
    assert attempts[1][2]["reasoning_content"] == "ls is enough.", attempts[1]
    # And it sticks, so the endpoint is asked once rather than once per turn.
    assert provider.send_reasoning
    assert deltas[-1].stop_reason == "end_turn"
    print("  a 400 turns into one retry that works ... ok")


if __name__ == "__main__":
    import asyncio

    test_the_fold_keeps_the_thinking()
    test_thinking_alone_still_opens_the_turn()
    test_only_the_unfinished_turn_carries_it_back()
    test_the_endpoint_gets_a_guess_and_the_last_word()
    asyncio.run(test_a_rejection_is_answered_by_one_retry())
    print("\nall reasoning round-trip tests passed")
