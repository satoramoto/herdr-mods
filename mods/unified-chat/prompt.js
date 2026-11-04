import { compactTokens, contextPercent, reportedMetadata } from "./metadata.js";
import { modeLabel } from "./claude-control.js";

export function bridgeFor(target) {
  if (!target?.sessionID || target.address.includes("/")) return null;
  const report = reportedMetadata(target.terminal);
  const bridge = report?.bridge;
  return report?.sessionID === target.sessionID && bridge?.version === 1 &&
    typeof bridge.path === "string" && bridge.path.startsWith("/") && bridge.path.endsWith("/control.sock") ? bridge : null;
}

// A Claude Code terminal that reports through the statusLine: no socket, but herdr-core
// can type its slash commands and press its keys.
export function claudeFor(target) {
  const report = target ? reportedMetadata(target.terminal) : null;
  return report?.agent === "claude" ? report : null;
}

export function promptLabels(metadata, controls) {
  const sampled = controls?.metadata;
  const data = sampled && (!metadata || sampled.updatedAt > (metadata.updatedAt ?? 0)) ? sampled : metadata ?? sampled;
  const mode = data?.agent === "claude" ? modeLabel(data.mode) ?? "Claude"
    : data?.mode?.replace(/^./, (letter) => letter.toUpperCase()) ?? "Mode not reported";
  const percent = contextPercent(data);
  const context = data?.used == null ? "Context not reported"
    : `~${compactTokens(data.used)}${percent != null ? ` (${percent}%)` : ""}`;
  return {
    mode, model: data?.model ?? "Model not reported", provider: controls?.providerName ?? data?.provider ?? "",
    variant: data?.variant ?? "default", context, contextPercent: data?.used == null ? null : percent,
    directory: controls?.directory ?? "Location not reported",
  };
}

export function commandOptions(commands, search = "", slashOnly = false) {
  const query = search.replace(/^\//, "").toLowerCase();
  return commands.flatMap((command) => {
    const names = command.slash ? [command.slash.name, ...(command.slash.aliases ?? [])] : [];
    if (slashOnly && !names.length) return [];
    return (names.length ? names : [null]).map((name) => ({
      ...command, name, label: name ? `/${name}` : command.title,
      key: `${command.kind}:${command.id}:${name ?? "palette"}`,
    }));
  }).filter((item) => !query || `${item.label} ${item.description}`.toLowerCase().includes(query))
    .sort((a, b) => a.label.localeCompare(b.label));
}
