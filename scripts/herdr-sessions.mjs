import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, rename, access, open, unlink, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mergeCatalog, rescuePlan, launchArgs, terminalSession, resumeCommand } from "../adapters/session-catalog.js";
import { savedSessions, openCodeSessions, claudeBackground, codexSaved, externalProcesses } from "./session-sources.mjs";
import { adoptionPlan, sameHarnessIdentity } from "../adapters/adoption.js";
import { moveLiveTerminal } from "../adapters/native-adoption.mjs";

const exec = promisify(execFile);
// The config: named by the unit, else the app home's. The earlier name is read while a unit still points at it.
const appHome = process.env.HERDR_APP_HOME ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "herdr-app");
const candidates = [process.env.SESSIONS_CONFIG, process.env.SHEEP_CONFIG, join(appHome, "data/sessions-config.json"), join(appHome, "data/sheep-config.json")].filter(Boolean);
let configPath = candidates[0], config;
for (const path of candidates) {
  try { config = JSON.parse(await readFile(path, "utf8")); configPath = path; break; } catch (e) { if (e.code !== "ENOENT") throw e; }
}
if (!config) throw new Error(`No session config at ${candidates.join(", ")}`);
const watch = process.argv.includes("--watch");
const resumeAt = process.argv.indexOf("--resume");
const requested = resumeAt >= 0 ? process.argv[resumeAt + 1] : null;
const adoptAt = process.argv.indexOf("--adopt");
const adopting = adoptAt >= 0 ? process.argv[adoptAt + 1] : null;
const option = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const shutdown = new AbortController();
process.on("SIGTERM", () => shutdown.abort());
process.on("SIGINT", () => shutdown.abort());
let cachedSources, sourceTime = 0, errors = [];
async function call(program, args) {
  const executable = config.binaries[program] ?? program;
  return (await exec(executable, args, { encoding: "utf8", timeout: 12000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
}
const json = async (program, args) => JSON.parse(await call(program, args));
async function load() {
  let state;
  try { state = JSON.parse(await readFile(config.registryPath, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    state = { version: 1, sessions: {}, coreGeneration: null, serverGeneration: null };
    // Carry forward exact placements from the earlier OpenCode-only sidecar.
    try {
      const legacy = JSON.parse(await readFile(join(homedir(), ".local/state/opencode-herdr/sessions.json"), "utf8"));
      if (legacy.version === 1 && legacy.bindings) {
        state.serverGeneration = legacy.generation;
        for (const old of Object.values(legacy.bindings)) {
          const key = `opencode:${old.sessionID}`;
          state.sessions[key] = { ...old, agent: "opencode", key, title: old.sessionID, connected: false };
        }
      }
    } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  if (state.version !== 1 || !state.sessions || Array.isArray(state.sessions)) throw new Error("Invalid session registry; left unchanged for inspection.");
  return state;
}
async function save(state) {
  await mkdir(dirname(config.registryPath), { recursive: true, mode: 0o700 });
  const temporary = `${config.registryPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, config.registryPath);
}
async function sources(force = false) {
  if (!force && cachedSources && Date.now() - sourceTime < 30000) return cachedSources;
  const result = { rows: [], generation: null };
  errors = [];
  for (const [name, collect] of [
    ["saved sessions", () => savedSessions()],
    ["Codex metadata", () => codexSaved(call)],
    ["OpenCode", () => openCodeSessions(call)],
    ["Claude background", () => config.binaries.claude ? claudeBackground(call) : []],
  ]) {
    try {
      const found = await collect();
      if (Array.isArray(found)) result.rows.push(...found);
      else { result.rows.push(...found.rows); result.generation = found.generation; errors.push(...(found.warnings ?? [])); }
    } catch (error) { errors.push(`${name}: ${error.message.split("\n")[0]}`); }
  }
  cachedSources = result; sourceTime = Date.now();
  return result;
}
async function observe(force = false) {
  const core = await json("herdr-core", ["server", "status"]); // never starts an absent core
  const list = await json("herdr-core", ["ls", "--all"]);
  const terminals = await Promise.all(list.terminals.filter((item) => item.state === "live").map((item) => json("herdr-core", ["get", item.address])));
  const found = await sources(force);
  const previous = await load();
  const external = await externalProcesses(terminals);
  // Native background attachment is authoritative over a generic external PID.
  const nativeKeys = new Set(found.rows.filter((r) => r.backgroundID).map((r) => `${r.agent}:${r.sessionID}`));
  const state = mergeCatalog(previous, [...found.rows, ...external.filter((r) => !nativeKeys.has(`${r.agent}:${r.sessionID}`))], terminals, {
    coreGeneration: `${core.core.id}:${core.pid}:${core.holder?.instance}`,
    serverGeneration: found.generation,
  });
  state.errors = errors;
  state.recoverySpace = config.recoverySpace;
  for (const row of Object.values(state.sessions)) {
    if (!row.privateServer && row.directory) {
      try { row.unavailableDirectory = !(await stat(row.directory)).isDirectory(); }
      catch { row.unavailableDirectory = true; }
    }
    row.resumable = Boolean(resumeCommand(row));
  }
  return { state, terminals };
}
async function launch(state, row, topology) {
  // Existing connected sessions are focused only on an explicit click, never
  // by this background watcher. All launches are resume/attach, never prompts.
  if (row.connected) return { terminal: row.terminal, existing: true };
  if (!row.resumable) throw new Error("No exact resume identity is available; this session remains listed.");
  const space = topology.spaces.find((s) => s.id === (row.adoptedSpace ?? row.space) && !s.machine
    && (row.adoptedSpace || s.tabs.some((t) => t.id === row.tab)));
  const targetTab = space?.tabs.find((tab) => tab.id === row.tab)?.id;
  if (!space || space.id === config.recoverySpace) throw new Error("Drag this session onto a space to re-adopt it before reconnecting.");
  await access(row.directory); // never launch into a guessed/substitute project
  row.attempted = true;
  row.rescueSeen = true;
  await save(state); // persist before the potentially ambiguous external action
  let args = launchArgs(row, { space: space.id, tab: targetTab });
  const commandAt = args.indexOf("--") + 1;
  if (!config.binaries[args[commandAt]]) throw new Error("The native harness executable is not installed; no substitute was launched.");
  args[commandAt] = config.binaries[args[commandAt]];
  const result = await json("herdr-core", args);
  row.launch = result;
  row.lastError = null;
  await save(state);
  if (!targetTab && result.address) {
    // Name only the recovery tab just created by this launch, never someone's
    // original work tab. Native attach remains the user's normal harness UI.
    const fresh = await json("herdr-app", ["ls"]);
    const tab = fresh.spaces.find((s) => s.id === space.id)?.tabs.find((t) => t.terminals?.some((p) => p.terminal === result.address));
    if (tab) await call("herdr-app", ["do", "tab.rename", JSON.stringify({ id: tab.id, name: `${row.agent}: ${row.title || row.sessionID}`.slice(0, 100) })]);
  }
  console.log(JSON.stringify({ resumed: row.key, result }));
  return result;
}
async function tick() {
  const { state, terminals } = await observe(Boolean(requested || adopting));
  if (!watch && !requested && !adopting) {
    console.log(JSON.stringify({ registryPath: config.registryPath, sessions: Object.values(state.sessions), errors: state.errors,
      wouldRescue: rescuePlan(state, terminals).map((r) => r.key) }, null, 2));
    return;
  }
  if (adopting) {
    let row = state.sessions[adopting];
    if (row?.aliasOf) row = state.sessions[row.aliasOf];
    const topology = await json("herdr-app", ["ls"]);
    const target = topology.spaces.find((space) => space.id === option("--space"));
    const terminal = row?.connected ? await json("herdr-core", ["get", row.terminal]) : null;
    if (terminal && !sameHarnessIdentity(row, terminalSession(terminal))) throw new Error("The selected harness session changed; nothing was moved.");
    const plan = adoptionPlan(row, target, terminal, JSON.parse(option("--expected") ?? "null"));
    if (plan.labels) await moveLiveTerminal(terminal, target.id, config.binaries);
    Object.assign(row, plan.placement);
    row.adoptedAt = Date.now();
    await save(state);
    console.log(JSON.stringify({ adopted: row.key, terminal: plan.terminal, space: target.id, launched: false }));
    return;
  }
  if (requested) {
    let row = state.sessions[requested];
    if (row?.aliasOf) row = state.sessions[row.aliasOf];
    if (!row) throw new Error("Session is not in the exact-identity registry.");
    const topology = await json("herdr-app", ["ls"]);
    await launch(state, row, topology);
    return;
  }
  await save(state);
  const plan = rescuePlan(state, terminals);
  if (!plan.length) return;
  const topology = await json("herdr-app", ["ls"]);
  for (const row of plan) {
    if (shutdown.signal.aborted) break;
    if (!topology.spaces.some((space) => space.id === (row.adoptedSpace ?? row.space) && space.id !== config.recoverySpace)) continue;
    try { await launch(state, row, topology); }
    catch (error) { row.lastError = error.message; await save(state); console.error(`${row.key}: ${error.message}`); }
  }
}
let lastError;
async function lockedTick() {
  // Serialize manual reconnect clicks with the watcher. This lock is held for
  // one snapshot/action batch, not for the lifetime of the service.
  const lock = `${config.registryPath}.lock`;
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 20000;
  let handle;
  while (!handle) {
    try { handle = await open(lock, "wx", 0o600); await handle.writeFile(String(process.pid)); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      let pid;
      try { pid = Number(await readFile(lock, "utf8")); } catch { /* Another process is releasing it. */ }
      if (pid > 0) {
        try { process.kill(pid, 0); }
        catch (e) { if (e.code === "ESRCH") { await unlink(lock).catch(() => {}); continue; } }
      }
      if (Date.now() >= deadline) throw new Error("Session tracker is busy; reconnect was not submitted.");
      await delay(100, undefined, { signal: shutdown.signal });
    }
  }
  try { await tick(); }
  finally { await handle.close(); await unlink(lock); }
}
do {
  try { await lockedTick(); lastError = undefined; }
  catch (error) {
    if (lastError !== error.message) console.error(error.message);
    lastError = error.message;
    if (!watch) process.exitCode = 1;
  }
  if (watch && !shutdown.signal.aborted) await delay(10000, undefined, { signal: shutdown.signal }).catch(() => {});
} while (watch && !shutdown.signal.aborted);
