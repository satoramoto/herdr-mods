// Pure parsers for what the observer reads: git status, docker ps, llama-server /models,
// the lab's provenance log.

// `git status --porcelain=v1` lines → [{ code, path }], renames by their new name.
export function parseStatus(text) {
  const out = [];
  for (const line of (text ?? "").split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2), rest = line.slice(3);
    const path = rest.includes(" -> ") ? rest.split(" -> ").pop() : rest;
    out.push({ code, path: path.replace(/^"|"$/g, "") });
  }
  return out;
}

// `docker ps -a --format {{json .}}` lines → the pain engine and running lab jobs.
export function parseDocker(text, labImage = "pain-lab") {
  let engine = { present: false, up: false, healthy: null, backend: null, image: null };
  let labRunning = 0;
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let c;
    try { c = JSON.parse(line); } catch { continue; }
    const up = /^Up\b/.test(c.Status ?? "");
    if (c.Names === "pain-engine") {
      const labels = Object.fromEntries((c.Labels ?? "").split(",").map((kv) => kv.split("=")).filter(([k]) => k));
      engine = { present: true, up, healthy: up ? !/\(unhealthy\)/.test(c.Status) : null, backend: labels["ai.pain.backend"] ?? null, image: c.Image ?? null };
    } else if (up && (c.Image === labImage || c.Image?.startsWith(`${labImage}:`))) labRunning++;
  }
  return { engine, labRunning };
}

// llama-server's router `/models` → [{ id, loaded }] (Ollama's /api/tags gives names only).
export function parseModels(json) {
  const list = json?.data ?? json?.models ?? [];
  return list.map((m) => ({ id: m.id ?? m.name ?? m.model ?? "?", loaded: m.status?.value === "loaded" || m.status?.value === "loading" })).filter((m) => m.id !== "?");
}

// experiments/lab_runs.jsonl, newest first → [{ exit, at, command }].
export function parseLabRuns(text) {
  const runs = [];
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const cmd = Array.isArray(r.command) ? r.command.slice(r.command.lastIndexOf("--") + 1).join(" ") : "";
      runs.push({ exit: r.exit_code ?? null, at: r.utc ?? null, command: cmd.length > 60 ? cmd.slice(0, 57) + "…" : cmd });
    } catch {}
  }
  return runs.reverse();
}

// `stat -c "%Y %n"` lines, newest first → [{ at, path }].
export function parseRecent(text) {
  return (text ?? "").split("\n").filter(Boolean).map((l) => {
    const i = l.indexOf(" ");
    return { at: parseInt(l.slice(0, i), 10), path: l.slice(i + 1) };
  }).filter((r) => Number.isFinite(r.at)).sort((a, b) => b.at - a.at);
}
