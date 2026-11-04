#!/usr/bin/env python3
"""Claude Code statusLine command: reports model/mode/context to herdr's
unified-chat panel as an OSC 7501 record, the same channel OpenCode's
unified-chat-metadata plugin uses. Prints nothing, so Claude's own status
line stays empty. Reporting must never break the harness: every failure exits 0.

The permission mode is not in the statusLine payload; unified-chat-mode.py (a hook)
writes it per session, and this reads it back.
"""
import base64
import json
import os
import sys
import time

DEBUG_DUMP = os.environ.get("UNIFIED_CHAT_DEBUG_DUMP")


def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else None


def terminal_device():
    # The status line runs as a pipe child of claude; walk up to the first
    # ancestor whose stdin is the terminal herdr-core is reading.
    pid = os.getppid()
    for _ in range(6):
        try:
            path = os.readlink(f"/proc/{pid}/fd/0")
            if path.startswith("/dev/pts/"):
                return path
            with open(f"/proc/{pid}/stat") as stat:
                pid = int(stat.read().rsplit(")", 1)[1].split()[1])
        except Exception:
            break
    return "/dev/tty"


def permission_mode(session_id):
    base = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
    try:
        with open(os.path.join(base, "unified-chat", "claude", f"{session_id}.json"), encoding="utf-8") as handle:
            mode = json.load(handle).get("permission_mode")
        return mode if isinstance(mode, str) and mode else None
    except Exception:
        return None


def main():
    terminal_id = os.environ.get("HC_TERMINAL_ID")
    data = json.load(sys.stdin)
    if DEBUG_DUMP:
        with open(DEBUG_DUMP, "w") as handle:
            json.dump(data, handle, indent=2)
    if not terminal_id or not isinstance(data, dict):
        return
    session_id = data.get("session_id")
    if not isinstance(session_id, str) or not session_id or "/" in session_id:
        return

    model = data.get("model") or {}
    window = data.get("context_window") or {}
    usage = window.get("current_usage") or {}
    # Same basis as Claude's own used_percentage: input + cache, not output.
    fields = [number(usage.get(key)) for key in
              ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")]
    used = sum(fields) if usage and all(value is not None for value in fields) else None
    effort = (data.get("effort") or {}).get("level")
    fast = data.get("fast_mode") is True
    # The hook-reported permission mode when there is one; fast mode is the only
    # mode the statusLine payload itself reports. Never guess.
    mode = permission_mode(session_id) or ("fast" if fast else None)

    now = int(time.time() * 1000)
    report = {
        "agent": "claude",
        "terminalID": terminal_id,
        "sessionID": session_id,
        "mode": mode,
        "fast": fast,
        "model": model.get("display_name") or model.get("id"),
        "modelID": model.get("id"),
        "provider": "anthropic",
        "variant": effort if isinstance(effort, str) else None,
        "used": used,
        "window": number(window.get("context_window_size")),
        "percent": number(window.get("used_percentage")),
        "inputLimit": None,
        "sampledAt": now if used is not None else None,
        "updatedAt": now,
    }
    payload = base64.b64encode(json.dumps(report, separators=(",", ":")).encode()).decode()
    sequence = f"\x1b]7501;id=unified-chat:state=idle:app=unified-chat:msg={payload}\x1b\\"
    # One write() keeps the sequence whole relative to Claude's own frames.
    fd = os.open(terminal_device(), os.O_WRONLY | os.O_NOCTTY)
    try:
        os.write(fd, sequence.encode())
    finally:
        os.close(fd)


try:
    main()
except Exception:
    pass
