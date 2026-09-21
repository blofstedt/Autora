"""Autora: an agentic harness you can watch.

Everything the agent does emits a typed event to an append-only log. The live UI
subscribes to that log; a recording is the same log read back.
"""

#: Kept in step with the version Umbrel reads, and reported to the UI so that
#: "did the update land?" has an answer you can read off the screen rather than
#: infer from whether a fix appears to work.
__version__ = "0.6.4"

from .events import Event, EventStore, Kind
from .session import Session, SessionRegistry

__all__ = ["Event", "EventStore", "Kind", "Session", "SessionRegistry", "__version__"]
