// A local sidecar, not a server plugin: shared servers have no single pane.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { emptyRegistry, validateRegistry, reportedSession, reconcile, restoreArgs } from "../adapters/opencode/restore-model.js";

const exec = promisify(execFile);
const registryPath = process.env.OPENCODE_HERDR_REGISTRY ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "opencode-herdr", "sessions.json");
const opencode = process.env.OPENCODE_HERDR_OPENCODE ?? "opencode";
const core = process.env.OPENCODE_HERDR_CORE ?? "herdr-core";
const app = process.env.OPENCODE_HERDR_APP ?? "herdr-app";
const watch = process.argv.includes("--watch");
if (process.argv.some((arg, i) => i > 1 && !["--watch", "--once"].includes(arg))) throw new Error("Usage: opencode-herdr-restore.mjs --once (preview) | --watch (service)");
let stopped = false;
let lastError;
const shutdown = new AbortController();
const stop = () => { stopped = true; shutdown.abort(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

async function call(program, args) {
  const { stdout } = await exec(program, args, { timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}
async function json(program, args) { return JSON.parse(await call(program, args)); }
async function get(path) {
  const result = await json(opencode, ["api", "get", path]);
  return result.data ?? result;
}
async function load() {
  try { return validateRegistry(JSON.parse(await readFile(registryPath, "utf8"))); }
  catch (error) { if (error.code === "ENOENT") return emptyRegistry(); throw error; }
}
async function save(state) {
  await mkdir(dirname(registryPath), { recursive: true, mode: 0o700 });
  const temporary = `${registryPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, registryPath);
}
async function tick() {
  // Status commands do not start missing servers. Do not wake OpenCode/core just
  // because this service is enabled at login; only inspect an existing service.
  await call(core, ["server", "status"]);
  const url = await call(opencode, ["service", "status"]);
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error("Shared OpenCode service is not running locally.");
  const info = await get("/api/info");
  const processStat = await readFile(`/proc/${info.pid}/stat`, "utf8");
  const startTime = processStat.slice(processStat.lastIndexOf(")") + 2).split(" ")[19];
  const generation = `${info.hostname}:${info.pid}:${startTime}`;
  const previous = await load();
  const list = await json(core, ["ls"]);
  const terminals = await Promise.all(list.terminals.filter((item) => item.state === "live" && !item.address.includes("/"))
    .map((item) => json(core, ["get", item.address])));
  const ids = new Set([...Object.keys(previous.bindings), ...terminals.map(reportedSession).filter(Boolean)]);
  const sessions = {};
  for (const id of ids) {
    try {
      const session = await get(`/api/session/${id}`);
      sessions[id] = session.time?.archived ? null : session;
    } catch (error) {
      // Only a definite 404 retires a binding. Transient/auth errors must not
      // erase a session or trigger an attachment to the wrong server.
      if (/SessionNotFound|session not found|404/i.test(`${error.stderr ?? ""} ${error.message}`)) sessions[id] = null;
      else throw error;
    }
  }
  const { state, actions } = reconcile(previous, { generation, terminals, sessions });
  if (!watch) {
    console.log(JSON.stringify({ registryPath, generation, bindings: state.bindings, wouldRestore: actions.map((a) => a.sessionID) }, null, 2));
    return;
  }
  await save(state);
  if (!actions.length) return;
  // Require the actual app and its current topology. Missing/deleted tabs are
  // never recreated from stale ids, and focus is never changed by the sidecar.
  const topology = await json(app, ["ls"]);
  for (const binding of actions) {
    if (stopped) break;
    const space = topology.spaces.find((space) => space.id === binding.space && !space.machine);
    if (!space?.tabs.some((tab) => tab.id === binding.tab)) continue;
    // Record the attempt before launch: a crash/ambiguous response must not
    // produce an infinite stream of duplicate clients on each restart.
    state.bindings[binding.sessionID].attempted = true;
    await save(state);
    try {
      const result = await json(core, restoreArgs(binding, opencode));
      console.log(JSON.stringify({ restored: binding.sessionID, result }));
    } catch (error) {
      console.error(`Restore requires inspection for ${binding.sessionID}: ${error.message}`);
    }
  }
}

do {
  try { await tick(); lastError = undefined; }
  catch (error) {
    const message = String(error.message);
    if (message !== lastError) console.error(message);
    lastError = message;
    if (!watch) { process.exitCode = 1; break; }
  }
  if (watch && !stopped) await delay(10000, undefined, { signal: shutdown.signal }).catch(() => {});
} while (watch && !stopped);
