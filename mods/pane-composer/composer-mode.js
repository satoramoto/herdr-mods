// Which composer owns a terminal's input: Herdr's unified bar or the harness's own
// prompt. Pure: the pane header, the installer and the tests share it. The choice is
// kept per terminal address in the shared value `unified-chat.composer` (only harness
// entries are stored; unified is the default) and mirrored to a state file that the
// Claude Code mod (adapters/claude/herdr-composer) polls.

export const MODES = ["unified", "harness"];
export const SHARED_KEY = "unified-chat.composer";
export const BAR_ID = "unified-chat-bar";

const ADDRESS = /^[a-z0-9_-]{1,32}$/i;

export function composerMode(map, address) {
  const mode = map && typeof map === "object" ? map[address] : null;
  return mode === "harness" ? "harness" : "unified";
}

export function withMode(map, address, mode) {
  const next = { ...(map && typeof map === "object" ? map : {}) };
  if (mode === "harness") next[address] = "harness";
  else delete next[address];
  return next;
}

// Local terminals only (t5x); a remote address (box/t7) has no local file Claude could read.
export function stateDirectory(home) {
  return `${home}/.local/state/unified-chat/composer`;
}

export function stateFilePath(home, address) {
  return ADDRESS.test(address ?? "") ? `${stateDirectory(home)}/${address}.json` : null;
}

export function stateFileText(mode, now = Date.now()) {
  return JSON.stringify({ composer: mode === "harness" ? "harness" : "unified", updatedAt: now }) + "\n";
}

// The terminal the composer bar talks to, from `focused()`: the same rule as the
// unified-chat mod (a shown replacement wins over its source terminal). Null when
// the focus is on a mod pane or nothing: the bar then stays as it is.
export function barTarget(focus) {
  if (!focus) return null;
  return focus.shown ?? focus.terminal ?? focus.agent ?? null;
}

// What the layout should do with the composer bar for a focused terminal.
export function barCommand(mode) {
  return mode === "harness" ? "layout.hide" : "layout.show";
}

// The inputs the bar's visibility follows. The command runs again whenever this
// changes (focus moved, or the focused terminal's choice changed) and never from a
// memory of what was applied: the layout keeps the node's state itself, across
// restarts, so a remembered "already hidden" goes stale.
export function barKey(focus, map) {
  const target = barTarget(focus);
  return target ? `${target}:${composerMode(map, target)}` : null;
}
