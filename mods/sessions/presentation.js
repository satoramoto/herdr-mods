export const FILTERS = [
  { id: "all", label: "All sessions" },
  { id: "live", label: "Live sessions" },
  { id: "disconnected", label: "Disconnected sessions" },
];
export const agentLabel = (agent) => ({ opencode: "OpenCode", claude: "Claude Code", codex: "Codex", pi: "Pi", omp: "OMP", gemini: "Gemini", copilot: "Copilot", cursor: "Cursor" }[agent] ?? agent);
export function groupsFor(rows, filter = "all") {
  const visible = rows.filter((row) => !row.aliasOf && (filter === "all" || (filter === "live" ? row.connected || row.active : !row.connected)));
  const groups = [
    { id: "connected", label: "Connected", rows: [] },
    { id: "background", label: "Background", rows: [] },
    { id: "disconnected", label: "Disconnected", rows: [] },
  ];
  for (const row of visible) groups[row.connected ? 0 : row.active ? 1 : 2].rows.push(row);
  for (const group of groups) group.rows.sort((a, b) => (b.updatedAt ?? b.lastSeen ?? 0) - (a.updatedAt ?? a.lastSeen ?? 0));
  return groups.filter((group) => group.rows.length);
}
export function ageLabel(at, now = Date.now()) {
  if (!Number.isFinite(at) || at <= 0) return "";
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  return minutes < 1 ? "<1m" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}
