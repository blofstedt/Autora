"""`autora` command line.

One command to start everything, because the stated goal is ease of use and a
harness you have to orchestrate by hand is not that.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def build_provider(args):
    """Pick a provider from flags and environment.

    Defaults to Anthropic when a key is present, and to a local
    OpenAI-compatible endpoint otherwise, so a local-first setup needs no flags.
    """
    if args.provider == "local" or (
        args.provider == "auto" and not os.environ.get("ANTHROPIC_API_KEY")
    ):
        from .providers.openai_compat import OpenAICompatProvider
        return OpenAICompatProvider(model=args.model or "qwen3-coder", base_url=args.base_url)

    from .providers.anthropic_provider import AnthropicProvider
    return AnthropicProvider(model=args.model or "claude-sonnet-5")


def build_voice(args, session, agent):
    """Build a VoiceLoop from --voice / --tts / --stt flags, or return None."""
    tts_name = getattr(args, "tts", None) or getattr(args, "voice", None)
    stt_name = getattr(args, "stt", None) or getattr(args, "voice", None)

    if not tts_name or tts_name == "off":
        return None

    from .voice.engine import VoiceLoop

    # ── TTS ──
    if tts_name in ("kokoro", "auto"):
        try:
            from .voice.adapters.kokoro_tts import KokoroTts
            tts = KokoroTts()
        except ImportError:
            if tts_name == "kokoro":
                print("error: kokoro-onnx not installed. Run: pip install kokoro-onnx sounddevice",
                      file=sys.stderr)
                return None
            tts = _fallback_piper()
    elif tts_name == "piper":
        tts = _fallback_piper()
    else:
        print(f"error: unknown --tts {tts_name!r}. Choices: kokoro, piper, off", file=sys.stderr)
        return None

    # ── STT ──
    # If the user didn't specify an STT engine but DEEPGRAM_API_KEY is set,
    # prefer Deepgram — true streaming, better barge-in, no local disk.
    if stt_name in ("auto", "kokoro", "piper") and os.environ.get("DEEPGRAM_API_KEY"):
        stt_name = "deepgram"

    if stt_name == "deepgram":
        try:
            from .voice.adapters.deepgram_stt import DeepgramStt
            stt = DeepgramStt()
        except ImportError:
            print("error: deepgram-sdk not installed. Run: pip install deepgram-sdk sounddevice",
                  file=sys.stderr)
            return None
        except RuntimeError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return None
    elif stt_name in ("whisper", "local", "auto"):
        try:
            from .voice.adapters.faster_whisper_stt import FasterWhisperStt
            stt = FasterWhisperStt(model_size=getattr(args, "stt_model", None) or "base.en")
        except ImportError:
            if stt_name == "whisper":
                print("error: faster-whisper not installed. Run: pip install faster-whisper sounddevice",
                      file=sys.stderr)
                return None
            stt = _fallback_openai_stt()
    elif stt_name in ("openai", "api"):
        stt = _fallback_openai_stt()
    elif stt_name == "off":
        return None
    else:
        print(f"error: unknown --stt {stt_name!r}. Choices: deepgram, whisper, openai, off",
              file=sys.stderr)
        return None

    if tts is None or stt is None:
        return None

    return VoiceLoop(session, agent, stt=stt, tts=tts)


def _fallback_piper():
    try:
        from .voice.adapters.piper_tts import PiperTts
        return PiperTts()
    except ImportError:
        print("error: piper-tts not installed. Run: pip install piper-tts sounddevice",
              file=sys.stderr)
        return None


def _fallback_openai_stt():
    try:
        from .voice.adapters.openai_whisper_stt import OpenAIWhisperStt
        return OpenAIWhisperStt()
    except ImportError:
        print("error: openai not installed. Run: pip install openai sounddevice",
              file=sys.stderr)
        return None


def cmd_up(args) -> int:
    import asyncio
    import uvicorn
    from .server import Harness, create_app

    workdir = Path(args.workdir).resolve()
    if not workdir.is_dir():
        print(f"error: {workdir} is not a directory", file=sys.stderr)
        return 2

    try:
        provider = build_provider(args)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    harness = Harness(
        root=Path(args.home) / "sessions" if args.home else None,
        provider=provider,
        workdir=workdir,
        auto_approve=args.yes,
        headless=not args.show_browser,
        chrome_path=args.chrome,
    )
    session_id = harness.create_session(title=args.title or f"session in {workdir.name}")

    voice_loop = None
    voice_name = getattr(args, "voice", None)
    if voice_name and voice_name != "off":
        session = harness.sessions[session_id]
        agent = harness.agents[session_id]
        voice_loop = build_voice(args, session, agent)

    ui_dist = Path(__file__).resolve().parents[2] / "ui" / "dist"
    app = create_app(harness, ui_dist=ui_dist if ui_dist.exists() else None)

    tts_label = getattr(args, "tts", None) or voice_name or "off"
    # Show effective STT: if Deepgram was auto-selected via env var, say so
    explicit_stt = getattr(args, "stt", None)
    if not explicit_stt and os.environ.get("DEEPGRAM_API_KEY") and voice_name and voice_name != "off":
        stt_label = "deepgram (auto)"
    else:
        stt_label = explicit_stt or voice_name or "off"

    print(f"\n  Autora")
    print(f"  workdir   {workdir}")
    print(f"  model     {provider.model} via {provider.name}")
    print(f"  approvals {'AUTO (everything allowed)' if args.yes else 'required'}")
    print(f"  voice     TTS={tts_label}  STT={stt_label}")
    print(f"  session   {session_id}")
    print(f"\n  watch at  http://{args.host}:{args.port}/?session={session_id}\n")
    if args.yes:
        print("  warning: --yes skips every confirmation. Do not use this against\n"
              "           production credentials.\n")

    if voice_loop is not None:
        import asyncio

        async def _run_with_voice():
            async with asyncio.TaskGroup() as tg:
                tg.create_task(voice_loop.run())
                tg.create_task(asyncio.to_thread(
                    uvicorn.run, app,
                    host=args.host, port=args.port, log_level=args.log_level,
                ))

        asyncio.run(_run_with_voice())
    else:
        uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level)
    return 0


def cmd_replay(args) -> int:
    """Print a recorded session to the terminal.

    A text replay alongside the visual one, because the fastest way to review a
    session is often to read it, and because it proves the log is the substrate
    rather than a UI-specific side channel.
    """
    from .events import Kind
    from .session import SessionRegistry

    registry = SessionRegistry(Path(args.home) / "sessions" if args.home else None)
    store = registry.open_recorded(args.session)
    if store is None:
        print(f"no such session: {args.session}", file=sys.stderr)
        return 1

    dim, bold, reset = "\033[2m", "\033[1m", "\033[0m"
    colors = {
        Kind.USER_MESSAGE: "\033[36m", Kind.AGENT_TEXT: "\033[0m",
        Kind.TOOL_CALL: "\033[33m", Kind.TOOL_ERROR: "\033[31m",
        Kind.ERROR: "\033[31m", Kind.POLICY_REQUEST: "\033[35m",
        Kind.FILE_EDIT: "\033[32m",
    }
    for event in store.read():
        color = colors.get(event.kind, dim)
        if event.kind == Kind.AGENT_TEXT and not args.verbose:
            sys.stdout.write(event.payload.get("text", ""))
            continue
        if event.kind in (Kind.PTY_OUTPUT,) and not args.verbose:
            continue
        if event.kind in (Kind.BROWSER_FRAME, Kind.DESKTOP_FRAME) and not args.verbose:
            continue
        label = event.kind
        detail = ""
        if event.kind == Kind.USER_MESSAGE:
            detail = event.payload.get("text", "")
        elif event.kind == Kind.TOOL_CALL:
            detail = f"{event.payload.get('name')} {event.payload.get('args', '')}"
        elif event.kind == Kind.FILE_EDIT:
            detail = f"{event.payload.get('path')} +{event.payload.get('added')} -{event.payload.get('removed')}"
        elif event.kind == Kind.POLICY_REQUEST:
            detail = event.payload.get("rendered", "")
        else:
            detail = str(event.payload)[:160]
        sys.stdout.write(f"\n{color}{bold}{label}{reset}{color} {detail[:200]}{reset}\n")
    sys.stdout.write("\n")
    return 0


def cmd_sessions(args) -> int:
    from .session import SessionRegistry
    registry = SessionRegistry(Path(args.home) / "sessions" if args.home else None)
    rows = registry.list()
    if not rows:
        print("no recorded sessions")
        return 0
    print(f"{'SESSION':<26} {'EVENTS':>7}  TITLE")
    for row in rows:
        print(f"{row.get('id',''):<26} {row.get('events',0):>7}  {row.get('title','')[:50]}")
    return 0


def main(argv: list[str] | None = None) -> int:
    # `--home` is accepted both before and after the subcommand. Requiring one
    # specific position is the kind of small friction that makes a tool feel
    # hostile, and argparse only does it if you ask twice.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--home", help="State directory (default ~/.autora)")

    parser = argparse.ArgumentParser(
        prog="autora", description="An agentic harness you can watch.",
        parents=[common])
    sub = parser.add_subparsers(dest="command", required=True)

    up = sub.add_parser("up", help="Start the harness and web UI", parents=[common])
    up.add_argument("workdir", nargs="?", default=".", help="Project directory the agent works in")
    up.add_argument("--host", default="127.0.0.1")
    up.add_argument("--port", type=int, default=8817)
    up.add_argument("--provider", choices=["auto", "anthropic", "local"], default="auto")
    up.add_argument("--model")
    up.add_argument("--base-url", help="For --provider local (default http://localhost:8000/v1)")
    up.add_argument("--chrome", help="Path to a Chromium binary (else Playwright's)")
    up.add_argument("--show-browser", action="store_true", help="Run Chrome headed")
    up.add_argument("--title", help="Session title")
    up.add_argument("--yes", action="store_true", help="Skip all approvals (dangerous)")
    up.add_argument("--log-level", default="warning")
    up.add_argument(
        "--voice",
        choices=["kokoro", "piper", "whisper", "openai", "off"],
        default="off",
        metavar="ENGINE",
        help="Enable voice I/O: 'kokoro' sets TTS=Kokoro + STT=faster-whisper, "
             "'piper' uses Piper TTS, 'openai' uses OpenAI Whisper API for STT. "
             "Use --tts/--stt for independent control. (default: off)",
    )
    up.add_argument("--tts", choices=["kokoro", "piper", "off"], help="TTS engine override")
    up.add_argument("--stt", choices=["deepgram", "whisper", "openai", "off"],
                    help="STT engine override (default: deepgram if DEEPGRAM_API_KEY set, else whisper)")
    up.add_argument("--stt-model", default="base.en",
                    help="faster-whisper model: tiny.en, base.en (default), small.en")
    up.set_defaults(func=cmd_up)

    replay = sub.add_parser("replay", help="Print a recorded session", parents=[common])
    replay.add_argument("session")
    replay.add_argument("-v", "--verbose", action="store_true",
                        help="Include terminal output and frames")
    replay.set_defaults(func=cmd_replay)

    ls = sub.add_parser("sessions", help="List recorded sessions", parents=[common])
    ls.set_defaults(func=cmd_sessions)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
