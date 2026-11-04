// Read-only inventory of every harness on this machine: version, which Herdr
// reporters are installed, and whether its control surface answers. Writes
// evidence/harness-audit.json. Never launches a harness, sends a prompt, starts
// a daemon or edits a config. Pair it with HARNESSES.md when adding a harness.
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, access, realpath, readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { openAppServer, CONTROL_SOCKET } from "../adapters/codex/app-server.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = homedir();
const exists = (path) => access(path).then(() => true, () => false);
const json = async (path) => { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } };
const text = async (path) => { try { return await readFile(path, "utf8"); } catch { return null; } };
const run = (program, args, timeout = 8000) => {
  try { return execFileSync(program, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
};
const which = (name) => run("sh", ["-c", `command -v ${name}`]);
const includes = (haystack, needle) => Boolean(haystack && String(haystack).includes(needle));

async function claude() {
  const bin = which("claude");
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const settings = await json(join(configDir, "settings.json"));
  const hookGroups = Object.entries(settings?.hooks ?? {});
  const ourHook = hookGroups.filter(([, groups]) => groups.some((g) => (g.hooks ?? []).some((h) => includes(h.command, "unified-chat-mode")))).map(([event]) => event);
  return {
    installed: Boolean(bin), version: bin ? run(bin, ["--version"]) : null,
    reporters: {
      statusLine: includes(settings?.statusLine?.command, "unified-chat-statusline"),
      permissionModeHook: ourHook,
      herdrSessionHook: hookGroups.some(([, groups]) => groups.some((g) => (g.hooks ?? []).some((h) => includes(h.command, "herdr-agent-state")))),
    },
    control: { tier: "terminal-relay", note: "No API into an open TTY session: /model, /effort, /plan typed with hc send; Shift+Tab with hc keys." },
    defaults: { permissionMode: settings?.permissions?.defaultMode ?? null, model: settings?.model ?? null },
  };
}

async function codex() {
  const bin = which("codex");
  const codexHome = process.env.CODEX_HOME || join(home, ".codex");
  const config = await text(join(codexHome, "config.toml"));
  const hooks = await json(join(codexHome, "hooks.json"));
  const result = {
    installed: Boolean(bin), version: bin ? run(bin, ["--version"]) : null,
    reporters: {
      herdrSessionHook: JSON.stringify(hooks ?? {}).includes("herdr-agent-state"),
      unifiedChatHook: JSON.stringify(hooks ?? {}).includes("unified-chat"),
      hooksFeature: /^\s*hooks\s*=\s*true/m.test(config ?? "") || !/^\s*hooks\s*=\s*false/m.test(config ?? ""),
    },
    control: { tier: "shared-daemon", socket: CONTROL_SOCKET, reachable: false },
  };
  if (!(await exists(CONTROL_SOCKET))) return result;
  try {
    const server = await openAppServer({ clientInfo: { name: "herdr-harness-audit", version: "0" }, timeout: 4000 });
    const loaded = await server.request("thread/loaded/list", {});
    const list = await server.request("thread/list", { limit: 20 });
    server.close();
    result.control.reachable = true;
    result.control.userAgent = server.serverInfo?.userAgent ?? null;
    result.control.loadedThreads = loaded?.data?.length ?? null;
    result.control.threads = (list?.data ?? []).filter((t) => loaded?.data?.includes(t.id)).map((t) => ({
      id: t.id, name: t.name ?? null, cwd: t.cwd, status: t.status?.type ?? null, flags: t.status?.activeFlags ?? [],
      model: t.model, reasoningEffort: t.reasoningEffort ?? null, originator: t.originator ?? null,
    }));
  } catch (error) {
    result.control.error = String(error.message ?? error);
  }
  return result;
}

async function pi() {
  const bin = which("pi");
  let docs = null;
  if (bin) {
    try {
      const real = await realpath(bin);
      for (const candidate of [join(dirname(real), "docs"), join(dirname(dirname(real)), "docs")]) if (await exists(candidate)) docs = candidate;
    } catch { /* unknown layout */ }
  }
  const commands = docs ? (await text(join(docs, "rpc-commands.md")))?.match(/^### (\w+)/gm)?.map((line) => line.slice(4)) ?? null : null;
  const agentDir = join(home, ".pi", "agent");
  const extensions = (await exists(join(agentDir, "extensions"))) ? await readdir(join(agentDir, "extensions")) : [];
  return {
    installed: Boolean(bin), version: bin ? run(bin, ["--version"]) : null, docs,
    reporters: { herdrExtension: extensions.includes("herdr-agent-state.ts"), unifiedChatExtension: extensions.some((name) => name.startsWith("unified-chat")) },
    control: { tier: "in-process-extension", note: "RPC mode is a separate headless process; an open TUI is reachable only through an extension bridge.", rpcCommands: commands },
  };
}

async function opencode() {
  const bin = which("opencode");
  const cli = await json(join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "opencode", "cli.json"));
  const plugins = cli?.plugins ?? [];
  return {
    installed: Boolean(bin), version: bin ? run(bin, ["--version"]) : null,
    reporters: { metadataPlugin: plugins.some((p) => includes(p, "unified-chat-metadata")), herdrPlugin: plugins.some((p) => includes(p, "herdr-opencode")) },
    control: { tier: "in-process-plugin-bridge", note: "TUI plugin publishes a same-user socket; see adapters/opencode." },
  };
}

async function liveTerminals() {
  const raw = run("hc", ["ls", "--json"]);
  if (!raw) return null;
  try {
    const terminals = (JSON.parse(raw).terminals ?? []).filter((t) => t.state === "live");
    return terminals.map((t) => {
      const detail = (() => { try { return JSON.parse(run("hc", ["get", "--json", t.address]) ?? "null"); } catch { return null; } });
      const record = detail()?.records?.["unified-chat"];
      let agent = null;
      try { agent = record?.msg ? JSON.parse(record.msg).agent ?? "opencode" : null; } catch { agent = null; }
      return { address: t.address, name: t.name ?? null, status: typeof t.status === "string" ? t.status : t.status?.state ?? null, unifiedChat: agent };
    });
  } catch { return null; }
}

const report = {
  auditedAt: new Date().toISOString(),
  harnesses: { opencode: await opencode(), claude: await claude(), codex: await codex(), pi: await pi() },
  liveTerminals: await liveTerminals(),
};
await mkdir(join(root, "evidence"), { recursive: true });
await writeFile(join(root, "evidence", "harness-audit.json"), JSON.stringify(report, null, 2) + "\n");

for (const [name, h] of Object.entries(report.harnesses)) {
  const reporters = Object.entries(h.reporters).filter(([, on]) => on && (!Array.isArray(on) || on.length)).map(([k]) => k).join(", ") || "none";
  const control = h.control.reachable === true ? `${h.control.tier} reachable, ${h.control.loadedThreads} loaded thread(s)`
    : h.control.reachable === false ? `${h.control.tier} ${h.control.error ? `error: ${h.control.error}` : "not reachable"}` : h.control.tier;
  console.log(`${name.padEnd(9)} ${h.installed ? (h.version ?? "installed") : "not installed"}`.padEnd(40) + ` reporters: ${reporters}`.padEnd(60) + ` control: ${control}`);
}
console.log(`\nWrote evidence/harness-audit.json`);
