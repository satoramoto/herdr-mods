// Claude Code exposes no control socket. Herdr types into its terminal instead, using the
// two slash commands that take an inline argument (/model, /effort), /plan, and the one
// key that moves the permission mode (Shift+Tab). Pure: the panel and the tests share it.

// Claude's hook payloads name the modes; its own UI labels them like this.
export const MODE_LABELS = {
  default: "Manual", acceptEdits: "Accept edits", plan: "Plan", auto: "Auto",
  dontAsk: "Don't ask", bypassPermissions: "Bypass permissions", fast: "Fast",
};

// The aliases /model accepts; a full model id typed into the search is offered too.
export const MODELS = [
  { id: "default", label: "Default", description: "Claude's recommended model" },
  { id: "fable", label: "Fable", description: "claude-fable-5-1" },
  { id: "opus", label: "Opus", description: "claude-opus-5-5" },
  { id: "sonnet", label: "Sonnet", description: "claude-sonnet-5-5" },
  { id: "haiku", label: "Haiku", description: "claude-haiku-5-5" },
  { id: "opusplan", label: "Opus plan", description: "Opus plans, Sonnet executes" },
  { id: "sonnet[1m]", label: "Sonnet 1M", description: "1M-token context" },
  { id: "opus[1m]", label: "Opus 1M", description: "1M-token context" },
];

export const EFFORTS = [
  { id: "low", label: "low", description: "" },
  { id: "medium", label: "medium", description: "" },
  { id: "high", label: "high", description: "" },
  { id: "xhigh", label: "xhigh", description: "" },
  { id: "max", label: "max", description: "This session only" },
  { id: "auto", label: "auto", description: "Clear the saved level for this model" },
];

// No slash command sets a permission mode by name; Shift+Tab cycles and /plan enters plan.
export const MODE_ACTIONS = [
  { id: "cycle", label: "Next permission mode", description: "Shift+Tab · Manual → Accept edits → Plan → Bypass → Auto" },
  { id: "plan", label: "Enter plan mode", description: "/plan" },
];

const MODEL_ID = /^claude-[a-z0-9.-]+(\[1m\])?$/i;

export function modeLabel(mode) {
  return typeof mode === "string" && mode ? MODE_LABELS[mode] ?? mode : null;
}

export function claudeOptions(kind, query = "") {
  const typed = query.trim();
  const needle = typed.toLowerCase();
  const list = kind === "models" ? MODELS : kind === "variants" ? EFFORTS : MODE_ACTIONS;
  const hits = list.filter((item) => !needle || `${item.id} ${item.label} ${item.description}`.toLowerCase().includes(needle));
  if (kind === "models" && MODEL_ID.test(typed) && !hits.some((item) => item.id === typed)) {
    hits.unshift({ id: typed, label: typed, description: "Full model id" });
  }
  return hits;
}

// What herdr-core does for a choice: type one line and press Enter, or press one key.
export function claudeAction(kind, item) {
  if (!item || /[\r\n\x1b]/.test(item.id)) return null;
  if (kind === "models") return { hc: "send", text: `/model ${item.id}` };
  if (kind === "variants") return { hc: "send", text: `/effort ${item.id}` };
  if (item.id === "plan") return { hc: "send", text: "/plan" };
  if (item.id === "cycle") return { hc: "keys", keys: ["shift+tab"] };
  return null;
}
