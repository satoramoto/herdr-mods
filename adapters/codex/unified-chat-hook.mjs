// Codex hook command (SessionStart, UserPromptSubmit, Stop): records the hook's
// permission mode and makes sure one unified-chat-reporter sidecar runs for this
// session. Prints nothing, always exits 0; reporting must never break Codex.
import { readFile, readlink, mkdir, writeFile, rename } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "os";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function parentOf(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
}

// The hook is a child of the TUI; the first ancestor reading a pty is the TUI.
async function terminalOwner() {
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    try {
      const fd0 = await readlink(`/proc/${pid}/fd/0`);
      if (fd0.startsWith("/dev/pts/")) return { pid, pty: fd0 };
    } catch { /* keep walking */ }
    try { pid = await parentOf(pid); } catch { break; }
  }
  return null;
}

async function main() {
  const terminalID = process.env.HC_TERMINAL_ID;
  if (!terminalID) return;
  let input = {};
  try { input = JSON.parse(await new Promise((resolve) => { let text = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { text += c; }); process.stdin.on("end", () => resolve(text || "{}")); })); } catch { return; }
  const sessionId = input.session_id;
  if (!UUID.test(sessionId ?? "") || !["SessionStart", "UserPromptSubmit", "Stop"].includes(input.hook_event_name)) return;
  const mode = typeof input.permission_mode === "string" && /^[A-Za-z]{1,32}$/.test(input.permission_mode) ? input.permission_mode : null;
  const stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "unified-chat", "codex");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const statePath = join(stateDir, `${sessionId}.json`);
  let state = {};
  try { state = JSON.parse(await readFile(statePath, "utf8")); } catch { /* first report */ }
  const alive = Number.isFinite(state.pid) && state.pid > 0 && (() => { try { process.kill(state.pid, 0); return true; } catch { return false; } })();
  const write = async (next) => {
    await writeFile(`${statePath}.tmp`, JSON.stringify({ ...state, ...next, permission_mode: mode ?? state.permission_mode ?? null, updatedAt: Date.now() }));
    await rename(`${statePath}.tmp`, statePath);
  };
  if (alive) { await write({}); return; }
  const owner = await terminalOwner();
  if (!owner) return;
  const reporter = join(dirname(fileURLToPath(import.meta.url)), "unified-chat-reporter.mjs");
  const child = spawn(process.execPath, [reporter, "--thread", sessionId, "--terminal", terminalID, "--pty", owner.pty, "--parent", String(owner.pid), "--state", statePath],
    { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  await write({ pid: child.pid, threadId: sessionId, terminalID });
}

try { await main(); } catch { /* never fail the hook */ }
process.exit(0);
