"""Autora: an agentic harness you can watch.

Everything the agent does emits a typed event to an append-only log. The live UI
subscribes to that log; a recording is the same log read back.
"""

__version__ = "0.1.0"

from .events import Event, EventStore, Kind
from .session import Session, SessionRegistry

__all__ = ["Event", "EventStore", "Kind", "Session", "SessionRegistry", "__version__"]
