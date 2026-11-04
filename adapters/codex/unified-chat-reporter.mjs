// One sidecar per Codex TUI session, started by unified-chat-hook.mjs. It joins
// the TUI's thread on the shared app-server daemon, publishes the `unified-chat`
// OSC record to the terminal, and serves the composer's control socket by
// translating requests into app-server calls (operations.js). It exits when the
// TUI process is gone. It never types into the terminal and never starts a daemon.
import { createServer } from "node:net";
import { open, mkdtemp, chmod, rm, readFile, writeFile, rename, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openAppServer } from "./app-server.mjs";
import { createCodexOperations, codexRecord, PROTOCOL, CODEX_FEATURES } from "./operations.js";

const args = Object.fromEntries(process.argv.slice(2).map((arg, i, all) => arg.startsWith("--") ? [arg.slice(2), all[i + 1]] : []).filter(Boolean));
const { thread: threadId, terminal: terminalID, pty, state: statePath } = args;
const parent = Number(args.parent);
if (!threadId || !terminalID || !pty || !statePath || !Number.isFinite(parent)) {
  console.error("usage: unified-chat-reporter.mjs --thread <id> --terminal <hc id> --pty <device> --parent <pid> --state <file>");
  process.exit(2);
}

const MAX_REQUEST = 32 * 1024 * 1024;
let info = {}, models = [], usage = null, override = {}, revision = 0, signature, publishedAt = 0, pending = null, closing = false;
let server, socket, socketDir;

async function writeState(extra) {
  let current = {};
  try { current = JSON.parse(await readFile(statePath, "utf8")); } catch { /* fresh */ }
  await writeFile(`${statePath}.tmp`, JSON.stringify({ ...current, pid: process.pid, threadId, terminalID, ...extra, updatedAt: Date.now() }));
  await rename(`${statePath}.tmp`, statePath);
}
async function hookMode() {
  try { return JSON.parse(await readFile(statePath, "utf8")).permission_mode ?? null; } catch { return null; }
}
async function emit(fields) {
  const handle = await open(pty, "w");
  try { await handle.write(`\x1b]7501;${fields}\x1b\\`); } finally { await handle.close(); }
}
async function publish(force = false) {
  if (closing) return;
  try {
    const record = codexRecord({ terminalID, threadId, info, models, usage, hookMode: await hookMode(), revision,
      bridge: socket ? { version: PROTOCOL, path: socket, features: CODEX_FEATURES } : null });
    const { updatedAt: _ignored, ...stable } = record;
    const next = JSON.stringify(stable);
    const now = Date.now();
    if (!force && next === signature && now - publishedAt < 15000) return;
    signature = next; publishedAt = now;
    await emit(`id=unified-chat:state=idle:app=unified-chat:msg=${Buffer.from(JSON.stringify(record), "utf8").toString("base64")}`);
  } catch (error) {
    // The pty is gone or the record failed: no guessed state is published.
    if (error?.code === "ENOENT" || error?.code === "EIO" || error?.code === "ENXIO") await shutdown();
  }
}
function changed() { revision++; if (!pending) pending = setTimeout(() => { pending = null; void publish(); }, 200); }

async function shutdown() {
  if (closing) return; closing = true;
  try { await emit("id=unified-chat:state=clear"); } catch { /* terminal gone */ }
  try { server?.close(); } catch { /* ignore */ }
  if (socketDir) await rm(socketDir, { recursive: true, force: true }).catch(() => {});
  try { await writeState({ pid: null, bridge: null }); } catch { /* ignore */ }
  try { daemon?.close(); } catch { /* ignore */ }
  process.exit(0);
}

let daemon, joined = false;
// thread/resume subscribes and reports the approval policy and sandbox, but it
// needs a rollout on disk, which a thread gets with its first turn. Until then
// thread/read (loaded threads only) supplies model, effort, cwd and status, and
// the resume is retried once a turn exists.
async function joinThread() {
  try {
    const resumed = await daemon.request("thread/resume", { threadId, excludeTurns: true });
    info = { ...info, model: resumed.model, effort: resumed.reasoningEffort ?? null, approvalPolicy: resumed.approvalPolicy, sandbox: resumed.sandbox ?? null,
      cwd: resumed.cwd, name: resumed.thread?.name ?? info.name ?? null, status: resumed.thread?.status ?? info.status ?? null };
    joined = true;
  } catch (error) {
    if (!/no rollout/i.test(String(error.message ?? error))) throw error;
    const read = await daemon.request("thread/read", { threadId });
    const thread = read.thread;
    info = { ...info, model: thread.model ?? info.model ?? null, effort: thread.reasoningEffort ?? info.effort ?? null, cwd: thread.cwd ?? info.cwd ?? null,
      name: thread.name ?? info.name ?? null, status: thread.status ?? info.status ?? null };
  }
}
try {
  daemon = await openAppServer({ clientInfo: { name: "herdr-unified-chat", version: "1" }, timeout: 15000 });
  await joinThread();
  models = (await daemon.request("model/list", { limit: 100 })).data ?? [];
} catch (error) {
  console.error(String(error.message ?? error));
  process.exit(1);
}

daemon.onNotification((message) => {
  const params = message.params ?? {};
  if (params.threadId && params.threadId !== threadId) return;
  switch (message.method) {
    case "thread/status/changed": info.status = params.status; changed(); break;
    case "thread/tokenUsage/updated": usage = { ...params.tokenUsage, sampledAt: Date.now() }; changed(); break;
    case "thread/settings/updated": {
      const s = params.threadSettings ?? {};
      info = { ...info, model: s.model ?? info.model, effort: s.effort ?? info.effort, approvalPolicy: s.approvalPolicy ?? info.approvalPolicy, sandbox: s.sandboxPolicy ?? info.sandbox, cwd: s.cwd ?? info.cwd };
      changed(); break;
    }
    case "thread/name/updated": info.name = params.name ?? info.name; changed(); break;
    case "turn/started": case "turn/completed": case "thread/queue/changed":
      if (!joined) joinThread().then(changed, () => {});
      changed(); break;
    case "thread/closed": case "thread/deleted": void shutdown(); break;
    default: break;
  }
});

const operations = createCodexOperations({
  request: (method, params) => daemon.request(method, params), terminalID, threadId,
  info: () => info, models: async () => models, usage: () => usage,
  override: () => override, setOverride: (next) => { override = { ...override, ...next }; },
  applied: (next) => { info = { ...info, model: next.model ?? info.model, effort: next.effort ?? info.effort }; override = {}; },
  changed,
});

// Same-user IPC with the OpenCode socket's framing: one JSON request line, one
// JSON response, then the connection ends.
try {
  const base = process.env.XDG_RUNTIME_DIR && await access(process.env.XDG_RUNTIME_DIR).then(() => true, () => false) ? process.env.XDG_RUNTIME_DIR : tmpdir();
  socketDir = await mkdtemp(join(base, "unified-chat-codex-"));
  await chmod(socketDir, 0o700);
  const path = join(socketDir, "control.sock");
  server = createServer((connection) => {
    connection.on("error", () => {});
    connection.setTimeout(15000, () => connection.destroy());
    let bytes = 0, text = "", handled = false;
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      if (handled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REQUEST) { connection.destroy(); return; }
      text += chunk;
      if (!text.includes("\n")) return;
      handled = true;
      void Promise.resolve().then(() => operations(JSON.parse(text.split("\n", 1)[0])))
        .then((data) => connection.end(JSON.stringify({ data }) + "\n"),
          (error) => connection.end(JSON.stringify({ error: String(error.message ?? error) }) + "\n"));
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  await chmod(path, 0o600);
  socket = path;
} catch (error) {
  console.error(`control socket unavailable: ${error.message ?? error}`);
  socket = null;
}

await writeState({ bridge: socket ? { version: PROTOCOL, path: socket, features: CODEX_FEATURES } : null });
await publish(true);
setInterval(() => void publish(), 15000).unref();
setInterval(() => { try { process.kill(parent, 0); } catch { void shutdown(); } }, 5000).unref();
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
// Keep the event loop alive with the daemon socket and the control server.
