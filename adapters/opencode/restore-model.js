// Session placement only. Never replay prompts or restart a session's jobs.
const SESSION = /^ses_[a-zA-Z0-9]+$/;

export function reportedSession(terminal) {
  if (terminal.state !== "live" || terminal.address?.includes("/")) return null;
  const foreground = terminal.foreground;
  const argv = foreground?.argv ?? [];
  if (!/^opencode(?:\.exe)?$/.test(foreground?.name ?? "")) return null;
  if (argv.some((arg) => arg === "--standalone" || arg === "--server" || arg.startsWith("--server="))) return null;
  const record = terminal.records?.["unified-chat"];
  if (record?.msg) {
    try {
      const metadata = JSON.parse(record.msg);
      if (metadata.terminalID === terminal.address) return SESSION.test(metadata.sessionID ?? "") ? metadata.sessionID : null;
    } catch { return null; }
  }
  // Native OSC reports are usable only when exactly one matches root status.
  const matches = Object.entries(terminal.records ?? {}).filter(([id, item]) =>
    SESSION.test(id) && item.app === "opencode" && item.title === terminal.status?.title);
  return matches.length === 1 ? matches[0][0] : null;
}

export function emptyRegistry() { return { version: 1, generation: null, bindings: {} }; }

export function validateRegistry(value) {
  if (value?.version !== 1 || !value.bindings || typeof value.bindings !== "object" || Array.isArray(value.bindings)) {
    throw new Error("Invalid restore registry; retained unchanged for inspection.");
  }
  for (const [id, binding] of Object.entries(value.bindings)) {
    if (!SESSION.test(id) || binding.sessionID !== id || !binding.directory?.startsWith("/") ||
        typeof binding.space !== "string" || typeof binding.tab !== "string" || typeof binding.open !== "boolean") {
      throw new Error("Invalid restore binding; registry retained unchanged for inspection.");
    }
  }
  return value;
}

export function reconcile(previous, { generation, terminals, sessions, now = Date.now() }) {
  const state = structuredClone(validateRegistry(previous));
  const changedServer = state.generation !== null && state.generation !== generation;
  if (changedServer) {
    for (const binding of Object.values(state.bindings)) {
      if (binding.open) { binding.pending = true; binding.attempted = false; }
    }
  }
  state.generation = generation;
  const attached = new Set();
  for (const terminal of terminals) {
    const id = reportedSession(terminal);
    const session = sessions[id];
    const labels = terminal.labels ?? {};
    if (!id || !session || session.parentID || session.time?.archived || !labels["herdr.space"] || !labels["herdr.tab"]) continue;
    const directory = session.location?.directory;
    if (!directory?.startsWith("/")) continue;
    attached.add(id);
    // Changing the selected session must not resurrect the old selection later.
    for (const binding of Object.values(state.bindings)) {
      if (binding.terminal === terminal.address && binding.sessionID !== id) {
        binding.open = false; binding.pending = false;
      }
    }
    state.bindings[id] = {
      sessionID: id, directory, space: labels["herdr.space"], tab: labels["herdr.tab"],
      terminal: terminal.address, terminalCreated: terminal.created_ms,
      open: true, pending: false, attempted: false, lastSeen: now,
    };
  }
  const actions = [];
  for (const binding of Object.values(state.bindings)) {
    if (attached.has(binding.sessionID)) continue;
    const terminal = terminals.find((item) => item.address === binding.terminal);
    // A surviving TUI may be reconnecting/hydrating. Never launch its duplicate.
    if (/^opencode(?:\.exe)?$/.test(terminal?.foreground?.name ?? "")) continue;
    if (binding.pending) {
      if (sessions[binding.sessionID] === null) {
        binding.open = false; binding.pending = false; // deleted/archived session
      } else if (sessions[binding.sessionID] && !binding.attempted) {
        actions.push({ ...binding });
      }
    } else if (now - binding.lastSeen >= 30000) {
      // An ordinary client quit is not an instruction to reopen it forever.
      binding.open = false;
    }
  }
  return { state, actions };
}

export function restoreArgs(binding, opencode = "opencode") {
  if (!SESSION.test(binding.sessionID ?? "") || !binding.directory?.startsWith("/")) throw new Error("Invalid restore target.");
  return ["run", "--bg", "--keep", "--no-parent", "--no-notify", "--cwd", binding.directory,
    "--label", `herdr.space=${binding.space}`, "--label", `herdr.tab=${binding.tab}`,
    "--label", `opencode.session=${binding.sessionID}`, "--", opencode, "--session", binding.sessionID, binding.directory];
}
