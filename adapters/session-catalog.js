// Harness-neutral identity and placement. No prompts or credentials are stored.
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ALIASES = { "claude-code": "claude", "opencode.exe": "opencode", "codex.exe": "codex", "claude.exe": "claude", "cursor-agent": "cursor" };
const HARNESSES = new Set(["opencode", "claude", "codex", "pi", "omp", "gemini", "copilot", "cursor", "aider", "goose", "amp", "droid", "kimi", "kilo", "qwen", "letta", "devin", "hermes", "grok", "mastracode", "antigravity-cli"]);
export const agentName = (name) => ALIASES[name] ?? name;
export const catalogKey = (agent, id, backgroundID) => agent === "claude" && backgroundID
  ? `claude:background:${backgroundID}` : `${agent}:${id}`;
const flag = (args, ...names) => {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i])) return args[i + 1] ?? null;
    const name = names.find((name) => args[i].startsWith(`${name}=`));
    if (name) return args[i].slice(name.length + 1);
  }
  return null;
};

export function terminalSession(terminal, now = Date.now()) {
  if (terminal.state !== "live") return null;
  const foreground = terminal.foreground ?? {};
  const args = foreground.argv ?? terminal.argv ?? [];
  let agent = agentName(foreground.name ?? "");
  if (!HARNESSES.has(agent)) agent = agentName(terminal.status?.app ?? terminal.report?.app ?? "");
  // Generic status-reporting agents are visible even without a known adapter.
  if (!agent || ["shell", "zsh", "bash", "fish", "unified-chat"].includes(agent)) return null;
  if (!HARNESSES.has(agent) && !(terminal.status?.app || terminal.report?.app)) return null;
  let sessionID;
  const record = terminal.records?.["unified-chat"];
  try {
    const metadata = JSON.parse(record?.msg ?? "null");
    const sameAgent = metadata?.agent ? agentName(metadata.agent) === agent : agent === "opencode";
    if (sameAgent && metadata.terminalID === terminal.address?.split("/").at(-1)
        && metadata.updatedAt <= now + 5000 && now - metadata.updatedAt < 45000) {
      // An explicit home-screen report must not fall back to an old argv id.
      if (!metadata.sessionID) return { agent, sessionID: null, privateServer: false };
      sessionID = metadata.sessionID;
    }
  } catch { /* Missing adapter: try exact CLI arguments/native records, never cwd heuristics. */ }
  if (!sessionID && agent === "opencode") {
    sessionID = flag(args, "--session", "-s");
    if (!sessionID) {
      const matches = Object.entries(terminal.records ?? {}).filter(([id, value]) =>
        /^ses_[a-zA-Z0-9]+$/.test(id) && value.app === "opencode" && value.title === terminal.status?.title);
      if (matches.length === 1) sessionID = matches[0][0];
    }
  } else if (!sessionID && agent === "claude") {
    sessionID = flag(args, "--resume", "-r", "--session-id");
    const attach = args.indexOf("attach");
    if (!sessionID && attach >= 0) sessionID = args[attach + 1];
  } else if (!sessionID && agent === "codex") {
    const resume = args.indexOf("resume");
    sessionID = resume >= 0 ? args.slice(resume + 1).find((arg) => UUID.test(arg)) : null;
  } else if (!sessionID && ["pi", "omp"].includes(agent)) sessionID = flag(args, "--session", "--session-id");
  else if (!sessionID && agent === "gemini") sessionID = flag(args, "--session-file");
  return {
    agent, sessionID: typeof sessionID === "string" && sessionID ? sessionID : null,
    privateServer: terminal.address?.includes("/") || args.some((arg) => arg === "--standalone" || arg === "--server" || arg.startsWith("--server=") || arg === "--remote"),
  };
}

export function resumeCommand(row) {
  const id = row.sessionID;
  if (!id || row.aliasOf || row.privateServer || !row.directory?.startsWith("/") || row.runningExternal || row.unavailableDirectory) return null;
  if (row.agent === "opencode" && /^ses_[a-zA-Z0-9]+$/.test(id)) return ["opencode", "--session", id, row.directory];
  if (row.agent === "claude" && UUID.test(id)) {
    return row.backgroundID ? ["claude", "attach", row.backgroundID] : ["claude", "--resume", id];
  }
  if (row.agent === "codex" && UUID.test(id)) return ["codex", "resume", "--no-daemon", id];
  if (row.agent === "pi" && (UUID.test(id) || id.startsWith("/"))) return ["pi", "--session", id];
  if (row.agent === "gemini" && id.startsWith("/")) return ["gemini", "--session-file", id];
  return null;
}

export function mergeCatalog(previous, discovered, terminals, { now = Date.now(), coreGeneration, serverGeneration } = {}) {
  const state = structuredClone(previous);
  if (state.version !== 1 || !state.sessions || Array.isArray(state.sessions)) throw new Error("Invalid session registry; preserved unchanged.");
  const coreChanged = state.coreGeneration && coreGeneration && state.coreGeneration !== coreGeneration;
  const serverChanged = state.serverGeneration && serverGeneration && state.serverGeneration !== serverGeneration;
  for (const row of Object.values(state.sessions)) {
    if (row.open && (coreChanged || (row.agent === "opencode" && serverChanged))) row.restorePending = true;
    row.connected = false; row.active = false; row.runningExternal = false;
    row.status = "disconnected";
  }
  for (const item of discovered) {
    if (!item.agent || !item.sessionID) continue;
    const key = catalogKey(item.agent, item.sessionID, item.backgroundID);
    state.sessions[key] = { ...state.sessions[key], ...Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined)), key, lastDiscovered: now,
      lastSeen: state.sessions[key]?.lastSeen ?? 0, connected: false };
  }
  const backgrounds = Object.values(state.sessions).filter((row) => row.agent === "claude" && row.key === catalogKey("claude", row.sessionID, row.backgroundID) && row.backgroundID);
  for (const background of backgrounds) {
    delete background.aliasOf;
    for (const row of Object.values(state.sessions)) {
      if (row.key === background.key || row.agent !== "claude") continue;
      if (row.sessionID !== background.sessionID && row.sessionID !== background.backgroundID && row.backgroundID !== background.backgroundID) continue;
      // Preserve placement across native cold-attach UUID changes. The stable
      // background job ID, not its mutable conversation UUID, owns the view.
      for (const field of ["terminal", "terminalCreated", "space", "tab", "lastSeen", "open", "restorePending", "rescueSeen", "attempted", "launch", "lastError"]) {
        if (background[field] == null && row[field] != null) background[field] = row[field];
      }
      if (row.launch) background.rescueSeen = true;
      if (row.source === "saved" && UUID.test(row.sessionID) && row.sessionID !== background.sessionID) {
        // Distinct old saved transcripts remain visible as history. Do not keep
        // routing their UUID through a job that now represents another UUID.
        row.formerBackgroundID = row.backgroundID;
        delete row.backgroundID;
        row.open = false; row.restorePending = false; row.attachable = false;
      } else {
        row.aliasOf = background.key;
        row.connected = false; row.open = false; row.restorePending = false;
      }
    }
  }
  for (const terminal of terminals) {
    let identity = terminalSession(terminal, now);
    if (!identity) continue;
    // Native background IDs may be short. Resolve only an unambiguous native id.
    const native = identity.agent === "claude" && identity.sessionID
      ? backgrounds.filter((r) => r.backgroundID === identity.sessionID || r.sessionID === identity.sessionID) : [];
    const background = native.length === 1 ? native[0] : null;
    if (background) identity.sessionID = background.sessionID;
    const id = identity.sessionID ?? `terminal-${terminal.address}-${terminal.created_ms}`;
    const key = background?.key ?? catalogKey(identity.agent, id);
    const old = state.sessions[key] ?? {};
    state.sessions[key] = {
      ...old, ...identity, key, directory: old.directory ?? terminal.foreground?.cwd ?? terminal.cwd,
      title: old.title || terminal.status?.title || terminal.title || `${identity.agent} · ${terminal.address}`,
      terminal: terminal.address, terminalCreated: terminal.created_ms,
      space: terminal.labels?.["herdr.space"] ?? old.space,
      tab: terminal.labels?.["herdr.tab"] ?? old.tab,
      parent: terminal.parent, active: true, connected: true, open: true, runningExternal: false,
      status: terminal.status?.state ?? terminal.report?.state ?? "running",
      lastSeen: now, restorePending: false, attempted: false,
    };
    // A replaced selection stays in the catalog, but isn't auto-resumed.
    for (const row of Object.values(state.sessions)) {
      if (row.key !== key && row.terminal === terminal.address && row.terminalCreated === terminal.created_ms) {
        row.restorePending = false; row.open = false;
      }
    }
  }
  state.coreGeneration = coreGeneration ?? state.coreGeneration;
  state.serverGeneration = serverGeneration ?? state.serverGeneration;
  state.updatedAt = now;
  for (const row of Object.values(state.sessions)) {
    row.resumable = Boolean(resumeCommand(row));
    if (!row.connected && !row.restorePending && now - row.lastSeen >= 30000 && (row.agent !== "opencode" || serverGeneration)) row.open = false;
  }
  return state;
}

export function rescuePlan(state, terminals) {
  return Object.values(state.sessions).filter((row) => {
    if (row.connected || row.attempted || !resumeCommand(row)) return false;
    // Don't duplicate a reconnecting client whose metadata hasn't hydrated.
    const old = terminals.find((t) => t.address === row.terminal && t.created_ms === row.terminalCreated);
    const selected = old && terminalSession(old);
    if (selected && (!selected.sessionID || (selected.agent === row.agent &&
        [row.sessionID, row.backgroundID].includes(selected.sessionID)))) return false;
    return row.restorePending || (row.active && row.attachable && !row.rescueSeen);
  });
}

export function launchArgs(row, { space, tab } = {}) {
  const argv = resumeCommand(row);
  if (!argv || !space) throw new Error("This session has no verified resume command or recovery space.");
  const args = ["run", "--bg", "--keep", "--no-parent", "--no-notify", "--cwd", row.directory,
    "--label", `herdr.space=${space}`, "--label", `sessions.key=${row.key}`];
  if (tab) args.push("--label", `herdr.tab=${tab}`);
  return [...args, "--", ...argv];
}
