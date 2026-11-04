import { readdir, readFile, open, stat, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { UUID, terminalSession, agentName } from "../adapters/session-catalog.js";

const cache = new Map();
const files = async (path) => { try { return await readdir(path, { withFileTypes: true }); } catch (e) { if (e.code === "ENOENT") return []; throw e; } };

// Inspect bounded metadata records. Prompt/assistant/tool bodies are never
// retained, indexed, transmitted or emitted into the catalog.
export function metadataFromLines(text, agent, path) {
  let id, directory, title, child = false;
  for (const line of text.split("\n")) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (item.isSidechain) child = true;
    id ??= item.sessionId ?? (item.type === "session" ? item.id : null);
    directory ??= item.cwd;
    if (item.type === "custom-title") title = item.customTitle;
    if (item.type === "session_info") title = item.name;
  }
  if (!id || child) return null;
  return { agent, sessionID: agent === "pi" || agent === "omp" ? path : id,
    directory, title: title || `${agent} · ${id.slice(0, 8)}`, source: "saved", status: "saved" };
}

async function sessionFile(path, agent) {
  const info = await stat(path);
  const signature = `${info.size}:${info.mtimeMs}`;
  if (cache.get(path)?.signature === signature) return cache.get(path).value;
  const handle = await open(path, "r");
  let text;
  try {
    const head = Buffer.alloc(Math.min(info.size, 262144));
    await handle.read(head, 0, head.length, 0);
    text = head.toString("utf8");
    if (info.size > head.length) {
      const tail = Buffer.alloc(Math.min(info.size, 131072));
      await handle.read(tail, 0, tail.length, info.size - tail.length);
      text += "\n" + tail.toString("utf8").split("\n").slice(1).join("\n");
    }
  } finally { await handle.close(); }
  const value = metadataFromLines(text, agent, path);
  if (value) value.updatedAt = info.mtimeMs;
  cache.set(path, { signature, value });
  return value;
}

export async function savedSessions(home = homedir()) {
  const rows = [];
  const claude = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  for (const project of await files(join(claude, "projects"))) {
    if (!project.isDirectory()) continue;
    const directory = join(claude, "projects", project.name);
    for (const file of await files(directory)) {
      // Native subagents live below this level and are not independent roots.
      if (!file.isFile() || !UUID.test(file.name.replace(/\.jsonl$/, "")) || !file.name.endsWith(".jsonl")) continue;
      const row = await sessionFile(join(directory, file.name), "claude");
      if (row) rows.push(row);
    }
  }
  for (const [agent, root] of [
    ["pi", process.env.PI_CODING_AGENT_SESSION_DIR ?? join(process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi/agent"), "sessions")],
    ["omp", join(home, ".omp/agent/sessions")],
  ]) {
    for (const directory of await files(root)) {
      if (!directory.isDirectory()) continue;
      for (const file of await files(join(root, directory.name))) {
        if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
        const row = await sessionFile(join(root, directory.name, file.name), agent);
        if (row) rows.push(row);
      }
    }
  }
  // Gemini's exact session-file option avoids unstable numeric picker indices.
  for (const project of await files(join(home, ".gemini/tmp"))) {
    if (!project.isDirectory()) continue;
    const root = join(home, ".gemini/tmp", project.name, "chats");
    for (const file of await files(root)) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const path = join(root, file.name);
      const item = JSON.parse(await readFile(path, "utf8"));
      if (item.sessionId) rows.push({ agent: "gemini", sessionID: path, title: item.title || `gemini · ${item.sessionId.slice(0, 8)}`,
        directory: item.cwd ?? item.projectPath, source: "saved", status: "saved" });
    }
  }
  return rows;
}

export async function openCodeSessions(call) {
  const address = (await call("opencode", ["service", "status"])).trim();
  if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(address)) throw new Error("OpenCode shared service is offline.");
  const request = async (path) => JSON.parse(await call("opencode", ["api", "get", path]));
  const info = await request("/api/info");
  const processStat = await readFile(`/proc/${info.pid}/stat`, "utf8");
  const start = processStat.slice(processStat.lastIndexOf(")") + 2).split(" ")[19];
  const active = (await request("/api/session/active")).data ?? {};
  const rows = [];
  const warnings = [];
  const cursors = new Set();
  let path = "/api/session?parentID=null&archived=false&limit=100";
  while (path) {
    const page = await request(path);
    for (const item of page.data ?? []) rows.push({ agent: "opencode", sessionID: item.id, title: item.title,
      directory: item.location.directory, source: "opencode", active: Boolean(active[item.id]),
      attachable: true, status: active[item.id]?.type ?? "saved", updatedAt: item.time.updated });
    const cursor = page.cursor?.next;
    if (!page.data?.length || !cursor || cursors.has(cursor)) break;
    cursors.add(cursor); path = `/api/session?cursor=${encodeURIComponent(cursor)}`;
  }
  // An idle root can still own running tests/dev servers. Keep that association.
  for (const directory of new Set(rows.map((row) => row.directory))) {
    try { await access(directory); } catch { continue; }
    let commands;
    try { commands = await request(`/api/shell?location[directory]=${encodeURIComponent(directory)}`); }
    catch { warnings.push(`Background-job inventory unavailable for ${directory}`); continue; }
    for (const command of commands.data ?? []) {
      const row = rows.find((row) => row.sessionID === command.metadata?.sessionID);
      if (row) { row.active = true; row.status = active[row.sessionID]?.type ?? "background jobs"; }
    }
  }
  return { rows, generation: `${info.hostname}:${info.pid}:${start}`, warnings };
}

export async function claudeBackground(call) {
  const list = JSON.parse(await call("claude", ["agents", "--json"]));
  return list.filter((item) => item.kind === "background" && UUID.test(item.sessionId ?? "")).map((item) => ({
    agent: "claude", sessionID: item.sessionId, backgroundID: item.id, directory: item.cwd,
    title: item.name || `claude · ${item.id}`, active: true, attachable: true,
    source: "claude-background", status: item.state ?? item.status ?? "running", pid: item.pid,
  }));
}

export async function codexSaved(call, home = homedir()) {
  const root = process.env.CODEX_HOME ?? join(home, ".codex");
  const databases = (await files(root)).filter((file) => /^state_\d+\.sqlite$/.test(file.name)).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  if (!databases.length) return [];
  // The native store is read-only, queried for metadata only: never transcripts,
  // first_user_message, previews, auth, queue state or settings.
  const code = `import sqlite3,json,sys,pathlib
c=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True)
c.row_factory=sqlite3.Row
cols={r[1] for r in c.execute('pragma table_info(threads)')}
assert {'id','cwd','title','archived'}<=cols, 'Unrecognized Codex metadata schema'
selected=[x for x in ('id','cwd','title','name','source','updated_at_ms','attached_thread_parent_id') if x in cols]
rows=[dict(r) for r in c.execute('select '+','.join(selected)+' from threads where archived=0')]
print(json.dumps(rows))
c.close()`;
  const rows = JSON.parse(await call("python3", ["-c", code, join(root, databases[0].name)]));
  return rows.filter((r) => UUID.test(r.id ?? "") && !r.attached_thread_parent_id && !String(r.source).includes("subagent"))
    .map((r) => ({ agent: "codex", sessionID: r.id, directory: r.cwd, title: r.name || r.title || `codex · ${r.id.slice(0, 8)}`,
      source: "saved", status: "saved", updatedAt: r.updated_at_ms }));
}

export async function externalProcesses(terminals, home = homedir()) {
  const known = new Set(["opencode", "claude", "codex", "pi", "omp", "gemini", "copilot", "cursor", "aider", "goose", "amp", "droid", "kimi", "kilo", "qwen", "letta", "devin", "hermes", "grok", "mastracode"]);
  const managed = new Set(terminals.flatMap((t) => [t.pid, t.foreground?.pid]).filter(Boolean));
  const processes = new Map();
  for (const entry of await files("/proc")) {
    if (!/^\d+$/.test(entry.name)) continue;
    try {
      const path = `/proc/${entry.name}`;
      if ((await stat(path)).uid !== process.getuid()) continue;
      const raw = await readFile(`${path}/stat`, "utf8");
      const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
      processes.set(Number(entry.name), { pid: Number(entry.name), parent: Number(fields[1]), start: fields[19] });
    } catch { /* Process exited while taking the snapshot. */ }
  }
  const rows = [];
  for (const item of processes.values()) {
    let parent = item.pid, owned = false;
    const seen = new Set();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      if (managed.has(parent)) { owned = true; break; }
      parent = processes.get(parent)?.parent;
    }
    if (owned) continue;
    try {
      const args = (await readFile(`/proc/${item.pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
      const agent = agentName(args[0]?.split("/").at(-1));
      if (!known.has(agent)) continue;
      if (args.some((a) => ["--help", "--version", "-h", "-V"].includes(a))) continue;
      if (agent === "opencode" && args.some((a) => ["serve", "service", "api", "debug", "models"].includes(a))) continue;
      if (agent === "claude" && args.slice(1).some((a) => ["daemon", "bg-pty-host", "bg-spare", "agents", "logs", "auth"].includes(a))) continue;
      const t = { state: "live", address: `process-${item.pid}`, foreground: { name: agent, argv: args } };
      const identity = terminalSession(t);
      let id = identity?.sessionID;
      if (agent === "claude" && !id) {
        try {
          const record = JSON.parse(await readFile(join(process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "sessions", `${item.pid}.json`), "utf8"));
          if (record.pid === item.pid && !record.spare) id = record.sessionId;
        } catch { /* No exact native identity. Still show an unresumable process. */ }
      }
      // Other people's foreground sessions cannot be moved across PTYs safely.
      // Keep them visible as external; never kill/relaunch them as "rescue".
      const { readlink } = await import("node:fs/promises");
      const directory = await readlink(`/proc/${item.pid}/cwd`);
      rows.push({ agent, sessionID: id || `process-${item.pid}-${item.start}`, directory,
        title: `${agent} · external PID ${item.pid}`, pid: item.pid, runningExternal: true,
        active: true, source: "external-process", status: "external", attachable: false });
    } catch { /* Process exited or belongs to an inaccessible namespace. */ }
  }
  return rows;
}
