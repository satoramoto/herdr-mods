#!/usr/bin/env python3
"""Claude Code hook (UserPromptSubmit, PreToolUse, Stop, SessionStart): remembers the
session's permission mode where unified-chat-statusline.py can read it. Claude's
statusLine payload carries no permission mode; its hook payloads do. Prints nothing
(hook stdout can become context) and never blocks Claude: every failure exits 0.
"""
import json
import os
import re
import sys
import time

SESSION = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MODE = re.compile(r"^[A-Za-z]{1,32}$")


def state_dir():
    base = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
    return os.path.join(base, "unified-chat", "claude")


def main():
    data = json.load(sys.stdin)
    if not isinstance(data, dict):
        return
    session_id = data.get("session_id")
    mode = data.get("permission_mode")
    if not isinstance(session_id, str) or not SESSION.match(session_id):
        return
    if not isinstance(mode, str) or not MODE.match(mode):
        return
    folder = state_dir()
    os.makedirs(folder, mode=0o700, exist_ok=True)
    final = os.path.join(folder, f"{session_id}.json")
    temp = os.path.join(folder, f".{session_id}.{os.getpid()}.tmp")
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump({"permission_mode": mode, "updatedAt": int(time.time() * 1000)}, handle)
    os.replace(temp, final)


try:
    main()
except Exception:
    pass
