// Only associate a terminal with a session it actually reports. Never infer it
// from project directories, names, or "most recently used" session lists.
function readReport(terminal, now = Date.now()) {
  const record = terminal.records?.["unified-chat"];
  if (record?.app !== "unified-chat" || !record.msg) return null;
  try {
    const data = JSON.parse(record.msg);
    if (data.terminalID !== terminal.address?.split("/").at(-1)) return null;
    if (!Number.isFinite(data.updatedAt) || now - data.updatedAt > 45000 || data.updatedAt > now + 5000) return null;
    return data;
  } catch { return null; }
}

// Each harness reports its own session ID shape. Claude's reporter is the
// statusLine command in ~/.claude/hooks/unified-chat-statusline.py.
const SESSION_IDS = {
  opencode: /^ses_[a-zA-Z0-9]+$/,
  claude: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  // Codex thread ids are UUIDv7; the reporter is adapters/codex/unified-chat-reporter.mjs.
  codex: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
};

export function reportedMetadata(terminal, now = Date.now()) {
  const data = readReport(terminal, now);
  if (!SESSION_IDS[data?.agent ?? "opencode"]?.test(data?.sessionID ?? "")) return null;
  if (["mode", "model", "provider", "variant"].some((key) => data[key] != null && typeof data[key] !== "string")) return null;
  if (["used", "window", "percent"].some((key) => data[key] != null && !Number.isFinite(data[key]))) return null;
  return data;
}

export function openCodeSession(terminal) {
  const reported = readReport(terminal);
  // A fresh home-screen report explicitly means no selected session. Do not
  // substitute an older keyed record from the same client.
  if (reported) return /^ses_[a-zA-Z0-9]+$/.test(reported.sessionID ?? "") ? reported.sessionID : null;
  const records = Object.entries(terminal.records ?? {}).filter(([id, record]) => /^ses_[a-zA-Z0-9]+$/.test(id) && record.app === "opencode");
  const report = terminal.report ?? (typeof terminal.status === "object" ? terminal.status : null);
  const matches = records.filter(([, record]) => report?.title && record.title === report.title);
  return matches.length === 1 ? matches[0][0] : null;
}

export function inspectOpenCode(session, models, messages) {
  const ref = session.model;
  const model = models.find((item) => item.id === ref?.id && item.providerID === ref?.providerID);
  const sample = messages.find((item) => item.type === "assistant" && item.time?.completed && item.tokens
    && item.model?.id === ref?.id && item.model?.providerID === ref?.providerID);
  const usage = sample?.tokens;
  const fields = usage && [usage.input, usage.output, usage.cache?.read, usage.cache?.write];
  const used = fields?.every((value) => Number.isFinite(value) && value >= 0) ? fields.reduce((sum, value) => sum + value, 0) : null;
  return {
    sessionID: session.id, mode: session.agent ?? null,
    model: model?.name ?? ref?.id ?? null, provider: ref?.providerID ?? null, variant: ref?.variant ?? null,
    used, window: model?.limit?.context ?? null, inputLimit: model?.limit?.input ?? null,
    sampledAt: sample?.time?.completed ?? null, updatedAt: Date.now(),
  };
}

export function compactTokens(value) {
  if (!Number.isFinite(value)) return "?";
  if (value >= 1000000) return `${(value / 1000000).toFixed(1).replace(/\.0$/, "")}m`;
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(value);
}

const capitalize = (text) => text.replace(/^./, (letter) => letter.toUpperCase());

// Share of the context window, preferring the harness's own figure.
export function contextPercent(metadata) {
  if (Number.isFinite(metadata?.percent)) return Math.round(metadata.percent);
  if (Number.isFinite(metadata?.used) && metadata.window > 0) return Math.round(metadata.used / metadata.window * 100);
  return null;
}

// What sits beside the send button: model, then mode/effort, kept short.
export function metadataLabel(metadata) {
  if (!metadata?.model) return null;
  const extras = [metadata.mode, metadata.variant].filter(Boolean).map(capitalize);
  return [metadata.model, ...extras].join(" · ");
}

export function metadataText(metadata) {
  if (!metadata) return "Model not reported · Mode not reported · Context not reported";
  const percent = contextPercent(metadata);
  const context = metadata.used == null ? `? / ${compactTokens(metadata.window)}`
    : `~${compactTokens(metadata.used)} / ${compactTokens(metadata.window)}${percent != null ? ` · ${percent}%` : ""}`;
  // Claude doesn't report a mode at all; only call it missing where one exists.
  const mode = metadata.mode ? capitalize(metadata.mode) : metadata.agent === "claude" ? null : "Mode not reported";
  return [mode, metadata.model ?? "Model not reported", metadata.variant, context].filter(Boolean).join(" · ");
}
