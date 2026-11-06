// Pure: from what was observed (the swarm index, git status, pain, the live agents) to a
// scene in tile coordinates. main.js draws it; the tests read it.

export const GRID = { gx: 18, gy: 14, hmax: 4.5 };
export const TRACKS = {
  A: { name: "Transcoding", x: 0 },
  B: { name: "Native spectral training", x: 3 },
  C: { name: "Residual stream coding", x: 6 },
  D: { name: "Contraction analysis", x: 9 },
  E: { name: "Noise-shaped re-quantization", x: 12 },
};
const BACKDROP = {
  hall: { x: 4, y: 8, w: 3, d: 2, h: 2.4, label: "Manuscript Hall", tip: "construction.md, validation.md, reading.md" },
  press: { x: 0.5, y: 8, w: 2, d: 1.5, h: 1.6, label: "Press Tent", tip: "The Jekyll site: layouts, includes, assets" },
  gallery: { x: 8, y: 8.5, w: 2, d: 1, h: 1.2, label: "Gallery", tip: "swarms/reports" },
  bandstand: { x: 6, y: 11, w: 2, d: 2, h: 0.5, label: "Bandstand", tip: "Where idle agents jam" },
  mara: { x: 9, y: 11.5, w: 1, d: 0.3, h: 1, label: "Mara's chalkboard", tip: "MARA.md" },
  observatory: { x: 0.5, y: 11, w: 2, d: 2, h: 2.8, label: "Old Observatory", tip: "archive/scalespace: the Lean library and the earlier site" },
  board: { x: 14.5, y: 0.5, w: 1, d: 0.4, h: 1.2, label: "Festival board", tip: "swarms/SWARM_INDEX.md and the swarm instructions" },
  gate: { x: 14, y: 13, w: 1, d: 0.3, h: 1, label: "Gate", tip: "Agents working outside the repo wait here" },
  plant: { x: 15, y: 2, w: 2, d: 2, h: 2.5, label: "Power Plant", tip: "pain-engine" },
  reactor: { x: 12.5, y: 7, w: 2, d: 2, h: 1.4, label: "APU", tip: "Swarms that need activation capture run a cable here" },
  barn: { x: 15, y: 7, w: 2, d: 2, h: 1.8, label: "Lab Barn", tip: "pain-lab: the pinned CPU PyTorch image" },
  reservoir: { x: 15, y: 10.5, w: 2.5, d: 2.5, h: 0.15, label: "Reservoir", tip: "pain-lab-data: the dataset cache volume" },
};

// ── the swarm index ─────────────────────────────────────────────────────────

const normalStatus = (s) => {
  const t = (s ?? "").toLowerCase();
  if (t.startsWith("complete") || t.startsWith("done")) return "complete";
  if (/^(running|active|in progress|executing)/.test(t)) return "running";
  return "planned";
};

// `## Swarm 003 — Track A Phase and Octave Audit` sections with their bullet fields.
export function parseIndex(text) {
  const swarms = [];
  let current = null;
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.trim();
    const head = line.match(/^## Swarm (\d+)\s*[—–-]\s*(.*)$/);
    if (head) { current = { number: parseInt(head[1], 10), title: head[2].trim(), label: "", track: null, status: "planned", apu: false, erratum: false }; swarms.push(current); continue; }
    if (!current || !line.startsWith("- **")) continue;
    const field = line.match(/^- \*\*([^*]+):\*\*\s*(.*)$/);
    if (!field) continue;
    const [, key, value] = field;
    if (key === "Label") { current.label = value; current.track = (value.match(/Track ([A-E])/) ?? [])[1] ?? null; }
    else if (key === "Status") current.status = normalStatus(value);
    else if (key === "APU") current.apu = /^required/i.test(value);
    else if (key === "Erratum") current.erratum = true;
  }
  return swarms;
}

// ── where a path belongs ────────────────────────────────────────────────────

export function district(path) {
  const p = String(path ?? "").replace(/^\.\//, "");
  let m;
  if ((m = p.match(/^swarms\/swarm_(\d+)_/))) return `swarm-${parseInt(m[1], 10)}`;
  if (/^swarms\/reports\//.test(p)) return "gallery";
  if ((m = p.match(/^swarms\/track_([a-eA-E])_/))) return `track-${m[1].toUpperCase()}`;
  if (/^swarms\//.test(p)) return "board";
  if (/^archive\//.test(p)) return "observatory";
  if (/^MARA\.md$/.test(p)) return "mara";
  if (/^(_layouts|_includes|_site|assets|_config\.yml|Gemfile|scripts|listening-room\.html|design-system\.md|STYLE\.md)/.test(p)) return "press";
  return "hall";
}

// An agent's folder relative to the repo, or null when it works elsewhere.
export function relative(cwd, repo) {
  if (!cwd || !repo) return null;
  const base = repo.replace(/\/+$/, "");
  if (cwd === base) return "";
  return cwd.startsWith(base + "/") ? cwd.slice(base.length + 1) : null;
}

// ── sims ────────────────────────────────────────────────────────────────────

export const HARNESS = { "claude-code": "ansi3", opencode: "ansi4", codex: "ansi2", pi: "ansi5" };

// A stable number in [0, 1) for an id, so a creature keeps its gait between renders.
export function seeded(id) {
  let h = 2166136261;
  for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return (h % 10007) / 10007;
}

// Where a district's ants gather: the middle of the building's front.
const front = (a, dx = 0, dy = 0) => ({ x: a.x + a.w / 2 + dx, y: a.y + a.d + 0.45 + dy });

// Live sub-agents of an address, as hc lists terminals.
export const kids = (all, address) => (all ?? []).filter((k) => k.parent === address && k.state === "live");

// The time of day the Commons is drawn in.
export const phase = (hour) => (hour < 6 || hour >= 20 ? "night" : hour < 8 || hour >= 18 ? "dusk" : "day");

export function simName(a, tabs, ps) {
  const tab = tabs.find((c) => c.id === a.tab);
  if (tab?.named) return tab.name;
  const title = (ps.find((p) => p.pane === a.pane)?.title ?? a.title ?? "").replace(/^[^\w(]+/, "").trim();
  return title || a.program?.name || a.app || a.address;
}

// ── the scene ───────────────────────────────────────────────────────────────

const RECENT = 10 * 60; // seconds: a file touched this recently counts as work in progress

export function scene(obs, live) {
  const now = live?.now ?? Date.now();
  const swarms = parseIndex(obs?.index);
  const status = obs?.status ?? [];
  const recent = obs?.recent ?? [];
  const pain = obs?.pain ?? {};
  const things = [];
  const anchors = {}; // district -> the tile rect sims gather at

  // The ridge: one tent per track, its swarm sites in a column below.
  for (const [letter, t] of Object.entries(TRACKS)) {
    const id = `track-${letter}`;
    things.push({ kind: "tent", id, district: id, role: id, x: t.x, y: 0, w: 2, d: 2, h: 2, label: `Track ${letter}`, tip: `Track ${letter} — ${t.name}` });
    anchors[id] = { x: t.x, y: 0, w: 2, d: 2 };
    swarms.filter((s) => s.track === letter).sort((a, b) => a.number - b.number).forEach((s, i) => {
      const sid = `swarm-${s.number}`;
      const y = 2.6 + i * 1.5;
      const touched = recent.some((r) => district(r.path) === sid && now / 1000 - r.at < RECENT);
      const working = (live?.agents ?? []).some((a) => a.status === "working" && live.where?.[a.address] === sid);
      const state = s.status === "complete" ? "complete" : (s.status === "running" || touched || working) ? "running" : "planned";
      const h = state === "complete" ? 2.2 : state === "running" ? 1.2 : 0.3;
      things.push({ kind: "box", id: sid, district: sid, role: id, x: t.x + 0.5, y, w: 1, d: 1, h, state, apu: s.apu, erratum: s.erratum,
        label: `Swarm ${String(s.number).padStart(3, "0")}`, tip: `Swarm ${String(s.number).padStart(3, "0")} — ${s.title}\n${s.label}\n${state}${s.apu ? " · APU required" : ""}${s.erratum ? " · erratum" : ""}` });
      anchors[sid] = { x: t.x + 0.5, y, w: 1, d: 1 };
    });
  }
  for (const [id, b] of Object.entries(BACKDROP)) {
    things.push({ kind: id === "reservoir" ? "water" : "box", id, district: id, role: id, ...b });
    anchors[id] = { x: b.x, y: b.y, w: b.w, d: b.d };
  }
  // The plant's chimney, and crates in the depot for every model the engine knows.
  const engine = pain.engine ?? {};
  anchors.depot = { x: 15, y: 5.2, w: 2.5, d: 0.7 };
  things.push({ kind: "box", id: "chimney", district: "plant", role: "chimney", x: 16.4, y: 2.2, w: 0.45, d: 0.45, h: 4.3, label: "", tip: "" });
  (pain.models ?? []).slice(0, 3).forEach((m, i) => things.push({ kind: "box", id: `crate-${m.id}`, district: "depot", role: m.loaded ? "crate-hot" : "crate", x: 15 + i * 0.9, y: 5.2, w: 0.7, d: 0.7, h: 0.7, label: "", tip: `${m.id}\n${m.loaded ? "loaded" : "on the shelf"}` }));
  (pain.labRuns ?? []).slice(0, 5).forEach((r, i) => things.push({ kind: "box", id: `jar-${i}`, district: "barn", role: r.exit === 0 ? "jar-ok" : "jar-bad", x: 15 + i * 0.42, y: 9.3, w: 0.3, d: 0.3, h: 0.4, label: "", tip: `lab run · exit ${r.exit}\n${r.command ?? ""}` }));
  // Frames on the gallery fence, one per plot (up to six).
  for (let i = 0; i < Math.min(obs?.plots ?? 0, 6); i++) things.push({ kind: "box", id: `frame-${i}`, district: "gallery", role: "frame", x: 8.1 + i * 0.32, y: 8.4, w: 0.22, d: 0.1, h: 0.5, label: "", tip: `${obs.plots} plots in swarms/reports/plots` });

  // Weather: a cloud over every district with modified files, a pop-up tent where files are new.
  const modified = {}, untracked = {};
  for (const s of status) {
    const d = district(s.path);
    if (s.code.includes("?")) untracked[d] = (untracked[d] ?? 0) + 1;
    else modified[d] = (modified[d] ?? 0) + 1;
  }
  const clouds = Object.entries(modified).filter(([d]) => anchors[d]).map(([d, n]) => ({ district: d, count: n, over: anchors[d] }));
  const tents = Object.entries(untracked).filter(([d]) => anchors[d]).map(([d, n]) => { const a = anchors[d]; return { kind: "tent", id: `new-${d}`, district: d, role: "popup", x: a.x + a.w + 0.15, y: a.y + a.d - 0.7, w: 0.6, d: 0.6, h: 0.8, label: "", tip: `${n} new file${n === 1 ? "" : "s"} near ${d}` }; });
  things.push(...tents);

  // Sims: each agent stands in front of its district; idle ones drift to the bandstand.
  // A working one shuttles between its site and the hall (the manuscripts) like an ant
  // on a trail; its sub-agents circle it. Carrier ants bring every freshly changed file
  // in from the gate (new) or the hall (edited) to where it belongs.
  const byDistrict = {};
  const sims = [];
  const routes = [];
  // Errands are short, like an ant's: a site's supplies come from the hall, the hall's from
  // the gallery, the chalkboard's from the bandstand, the board's from the gate.
  const SUPPLY = { hall: "gallery", gallery: "hall", mara: "bandstand", press: "hall", board: "track-E", observatory: "press", gate: "reservoir" };
  const supplyOf = (d) => SUPPLY[d] ?? (d.startsWith("swarm-") || d.startsWith("track-") ? "hall" : "gate");
  for (const a of live?.agents ?? []) {
    const where = live.where?.[a.address] ?? "gate";
    const d = a.status === "idle" || a.status === "done" ? "bandstand" : anchors[where] ? where : "gate";
    byDistrict[d] = (byDistrict[d] ?? []).concat(a);
  }
  for (const [d, list] of Object.entries(byDistrict)) {
    const a = anchors[d];
    const cols = Math.min(4, list.length);
    list.forEach((ag, i) => {
      const r = seeded(ag.address);
      const at = front(a, ((i % cols) - (cols - 1) / 2) * 0.6, Math.floor(i / cols) * 0.55);
      const sim = { kind: "agent", id: ag.address, address: ag.address, pane: ag.pane, status: ag.status, app: ag.app, name: live.names?.[ag.address] ?? ag.address, district: d, x: at.x, y: at.y };
      if (ag.status === "working" && anchors[supplyOf(d)] && d !== "bandstand") {
        const to = front(anchors[supplyOf(d)], (r - 0.5) * 0.8);
        sim.route = { to, period: 3200 + r * 2400 };
        routes.push({ from: d, to: supplyOf(d) });
      } else if (d === "bandstand" && r > 0.55) sim.wander = { rx: 0.8 + r * 1.2, ry: 0.5 + r * 0.6, px: 7000 + r * 6000, py: 9000 + r * 5000 }; // foragers
      else if (d === "bandstand") sim.sway = { dx: 0.12 + r * 0.1, period: 1400 + r * 1800 };
      sims.push(sim);
      kids(live.terminals, ag.address).forEach((k, j) => {
        const kr = seeded(k.address);
        sims.push({ kind: "sub", id: k.address, address: k.address, parent: ag.address, status: k.status === "error" ? "blocked" : k.status, app: ag.app, name: k.name || k.template || k.address, district: d,
          x: at.x + (kr - 0.5) * 0.9, y: at.y + 0.25 + (j % 3) * 0.2, orbit: { rx: 0.35 + kr * 0.3, ry: 0.2 + kr * 0.15, period: 1800 + kr * 1600 } });
      });
    });
  }
  const recentFiles = recent.filter((r) => now / 1000 - r.at < RECENT).slice(0, 8);
  recentFiles.forEach((r, i) => {
    const d = district(r.path);
    if (!anchors[d]) return;
    const fresh = status.find((s) => s.path === r.path || r.path.startsWith(s.path));
    const from = fresh?.code.includes("?") ? "gate" : "hall";
    if (from === d || !anchors[from]) return;
    const sr = seeded(r.path);
    sims.push({ kind: "carrier", id: `carry-${i}`, name: r.path, district: d, load: d.startsWith("track-") ? d : things.find((t) => t.id === d)?.role ?? "hall",
      x: front(anchors[from], (sr - 0.5) * 0.6).x, y: front(anchors[from]).y, route: { to: front(anchors[d], (sr - 0.5) * 0.6, 0.1), period: 2600 + sr * 2600 } });
    routes.push({ from, to: d });
  });
  // The yard: a truck between the depot and the plant while a model is loaded, a tech
  // hauling water from the reservoir while a lab job runs.
  if ((pain.models ?? []).some((m) => m.loaded) && engine.up) {
    sims.push({ kind: "truck", id: "truck", name: "A crate on its way to the plant", district: "plant", x: 16.1, y: 6.2, route: { to: { x: 16.1, y: 4.4 }, period: 2200 } });
    routes.push({ from: "depot", to: "plant" });
  }
  if (pain.labRunning) {
    sims.push({ kind: "tech", id: "tech", name: `Lab tech · ${pain.labRunning} job${pain.labRunning === 1 ? "" : "s"} running`, district: "barn", x: 16, y: 9.6, route: { to: { x: 16, y: 10.9 }, period: 1900 } });
    routes.push({ from: "barn", to: "reservoir" });
  }
  // The regulars: the duck wanders the meadow, two crows circle the observatory.
  sims.push({ kind: "duck", id: "duck", name: "The duck. It does nothing.", district: "bandstand", x: 7.5, y: 10.2, wander: { rx: 1.6, ry: 0.9, px: 9000, py: 13000 } });
  sims.push({ kind: "crow", id: "crow-1", name: "A crow", district: "observatory", x: 1.5, y: 12, z: 4.2, wander: { rx: 1.4, ry: 0.8, px: 5200, py: 3700 } });
  sims.push({ kind: "crow", id: "crow-2", name: "Another crow", district: "observatory", x: 1.8, y: 11.6, z: 4.8, wander: { rx: 1.1, ry: 0.7, px: 4300, py: 6100 } });

  // Trails: the routes walked now and the ones worn in before (counts from the caller).
  const worn = live?.trails ?? {};
  const trails = Object.entries(worn).map(([key, n]) => ({ key, weight: n })).concat(routes.map((r) => ({ key: `${r.from}>${r.to}`, weight: 1 })))
    .reduce((acc, t) => { const hit = acc.find((x) => x.key === t.key); if (hit) hit.weight = Math.max(hit.weight, t.weight); else acc.push(t); return acc; }, [])
    .map((t) => { const [a, b] = t.key.split(">"); return anchors[a] && anchors[b] ? { key: t.key, from: front(anchors[a]), to: front(anchors[b]), weight: t.weight } : null; }).filter(Boolean);

  // Flashes: a ring where a file changed in the last minute and a half.
  const flashes = recent.filter((r) => now / 1000 - r.at < 90).map((r) => district(r.path)).filter((d, i, all) => anchors[d] && all.indexOf(d) === i)
    .map((d) => ({ district: d, at: anchors[d] }));

  // Cables from the APU to every swarm that needs it.
  const cables = things.filter((t) => t.apu && t.state !== "complete").map((t) => ({ from: { x: t.x + t.w / 2, y: t.y + t.d / 2 }, to: { x: 13.5, y: 8 } }));

  const working = (live?.agents ?? []).filter((a) => a.status === "working").length;
  const blocked = (live?.agents ?? []).filter((a) => a.status === "blocked").length;
  const loaded = (pain.models ?? []).filter((m) => m.loaded).map((m) => m.id);
  const ticker = [];
  for (const s of swarms.slice().reverse().slice(0, 3)) ticker.push(`Swarm ${String(s.number).padStart(3, "0")} ${s.status}: ${s.title}`);
  if (!engine.present) ticker.push("Power plant: pain-engine is not running (./ai up llamacpp-vulkan)");
  else ticker.push(`Power plant: ${engine.backend ?? "?"}${engine.up ? "" : ", stopped"}${engine.healthy === false ? ", unhealthy" : ""} · ${loaded.length ? `${loaded.join(", ")} loaded` : "no model loaded"}${pain.gpu != null ? ` · GPU ${pain.gpu}%` : ""}`);
  if (pain.labRunning) ticker.push(`Lab Barn: ${pain.labRunning} job${pain.labRunning === 1 ? "" : "s"} running`);
  else if (pain.labRuns?.length) ticker.push(`Lab Barn: last run exit ${pain.labRuns[0].exit}`);
  const m = Object.values(modified).reduce((a, b) => a + b, 0), u = Object.values(untracked).reduce((a, b) => a + b, 0);
  ticker.push(m || u ? `Weather: ${m} modified, ${u} new, clouds over ${Object.keys(modified).join(", ") || "nowhere"}` : "Weather: clear skies, nothing uncommitted");
  if (working) ticker.push(`${working} agent${working === 1 ? "" : "s"} building${blocked ? `, ${blocked} waiting for you` : ""}`);
  if (obs?.plots) ticker.push(`Gallery: ${obs.plots} plots hung, ${obs.reports ?? 0} reports written`);

  const hour = live?.hour ?? new Date(now).getHours();
  if (recentFiles.length) ticker.push(`${recentFiles.length} file${recentFiles.length === 1 ? "" : "s"} carried in: ${recentFiles.slice(0, 3).map((r) => r.path.split("/").pop()).join(", ")}`);
  return { grid: GRID, things, clouds, cables, sims, routes, trails, flashes, ticker, phase: phase(hour),
    stats: { working, blocked, modified: m, untracked: u, swarms: swarms.length, engine, gpu: pain.gpu ?? null, loaded, ants: sims.length } };
}

// Painter's order: back to front, low before tall on the same tile.
export const order = (a, b) => (a.x + a.w + a.y + a.d) - (b.x + b.w + b.y + b.d) || a.h - b.h;
