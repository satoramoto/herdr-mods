import { openCodeSession } from "./metadata.js";

export function targetsFrom(agents, terminals) {
  return agents.flatMap((agent) => {
    const terminal = terminals.find((item) => item.address === agent.address);
    if (!terminal || terminal.state !== "live") return [];
    const rawStatus = typeof terminal.status === "string" ? terminal.status : terminal.status?.state;
    const sessionID = openCodeSession(terminal);
    return [{
      ...agent,
      key: `${agent.address}@${terminal.created_ms ?? "session"}${sessionID ? `/${sessionID}` : ""}`,
      sessionID, terminal, turn: terminal.turn,
      status: rawStatus ?? terminal.report?.state ?? "unknown",
      label: agent.program?.name ?? agent.app ?? "Agent",
    }];
  });
}

export function targetFromFocus(targets, focus, explicitAddress) {
  if (explicitAddress) return targets.find((target) => target.address === explicitAddress) ?? null;
  if (!focus) return null;
  // A displayed replacement wins over its source terminal. Never fall back to
  // an unrelated agent when the focused terminal is a shell or has exited.
  const address = focus.shown ?? focus.terminal ?? focus.agent;
  return targets.find((target) => target.address === address) ?? null;
}

export function decodeResult(result) {
  let body;
  try { body = JSON.parse(result.stdout); } catch { body = null; }
  if (result.code !== 0 || body?.error) {
    let error = body?.error;
    if (!error) { try { error = JSON.parse(result.stderr).error; } catch {} }
    const detail = typeof error === "string" ? error : error?.message;
    throw new Error(detail || result.stderr?.trim() || result.stdout?.trim() || "Core command failed.");
  }
  return body;
}

// Draft storage is independent from delivery. An acknowledgement cannot erase
// text the person wrote while an earlier queued message was being submitted.
export class Composer {
  constructor(drafts = {}) {
    this.drafts = new Map(Object.entries(drafts).filter(([, value]) => typeof value === "string"));
    this.selected = null;
  }
  select(key) { this.selected = key; }
  text(key = this.selected) { return this.drafts.get(key) ?? ""; }
  edit(text) { if (this.selected) this.drafts.set(this.selected, text); }
  snapshot() { return Object.fromEntries([...this.drafts].filter(([, text]) => text)); }
}
