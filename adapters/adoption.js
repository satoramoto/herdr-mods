// Layout adoption never changes a harness command, cwd, messages or files.
export function sameHarnessIdentity(row, identity) {
  return Boolean(identity && identity.agent === row.agent && (row.sessionID == null
    ? identity.sessionID == null : [row.sessionID, row.backgroundID].includes(identity.sessionID)));
}
export function adoptionPlan(row, target, terminal, expected) {
  if (!row || row.aliasOf) throw new Error("Session identity is no longer current; pick it up again.");
  if (!target || target.machine) throw new Error("Adoption currently requires a space on this machine.");
  if (!expected || !Object.hasOwn(expected, "terminal")) throw new Error("Missing drag identity; pick the session up again.");
  if (row.connected) {
    if (!terminal || terminal.state !== "live" || terminal.address.includes("/") ||
        expected.terminal !== row.terminal || expected.created !== row.terminalCreated ||
        terminal.address !== row.terminal || terminal.created_ms !== row.terminalCreated) {
      throw new Error("The terminal changed during the drag; nothing was moved.");
    }
    return { labels: ["label", terminal.address, `herdr.space=${target.id}`, "herdr.tab="],
      placement: { adoptedSpace: target.id, space: target.id, tab: null }, terminal: terminal.address };
  }
  if (expected.terminal !== null || expected.created !== null) throw new Error("Session disconnected during the drag; pick it up again.");
  return { labels: null, placement: { adoptedSpace: target.id, space: target.id, tab: null }, terminal: null };
}
