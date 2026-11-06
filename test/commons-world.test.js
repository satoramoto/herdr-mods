import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIndex, district, relative, scene, simName, order, seeded, phase, kids } from "../mods/commons/world.js";
import { parseStatus, parseDocker, parseModels, parseLabRuns, parseRecent } from "../mods/commons/parse.js";

const INDEX = `
## Swarm 001 — Track A First Job
- **Label:** Track A — Spectral Audit
- **APU:** required
- **Status:** complete
- **Erratum:** the extractor reshaped the tensor.

## Swarm 002 — Track A Hedged Run
- **Label:** Track A — Multi-Hypothesis Spectral Audit
- **APU:** required
- **Status:** planned (revised after swarm 003)

## Swarm 007 — Track B Native Spectral Training
- **Label:** Track B — Interval Positions + Spectral Init
- **APU:** not required
- **Status:** planned
`;

test("the swarm index parses into numbered swarms with track, status, APU and erratum", () => {
  const s = parseIndex(INDEX);
  assert.deepEqual(s.map((x) => [x.number, x.track, x.status, x.apu, x.erratum]), [[1, "A", "complete", true, true], [2, "A", "planned", true, false], [7, "B", "planned", false, false]]);
  assert.equal(s[2].title, "Track B Native Spectral Training");
});

test("repo paths belong to districts", () => {
  assert.equal(district("swarms/swarm_007_agent_prompt.md"), "swarm-7");
  assert.equal(district("swarms/track_b_tools/"), "track-B");
  assert.equal(district("swarms/reports/plots/x.png"), "gallery");
  assert.equal(district("swarms/SWARM_INDEX.md"), "board");
  assert.equal(district("archive/scalespace/Lean/x.lean"), "observatory");
  assert.equal(district("MARA.md"), "mara");
  assert.equal(district("_layouts/default.html"), "press");
  assert.equal(district("construction.md"), "hall");
  assert.equal(relative("/r/scalespace/swarms", "/r/scalespace"), "swarms");
  assert.equal(relative("/r/scalespace", "/r/scalespace/"), "");
  assert.equal(relative("/elsewhere", "/r/scalespace"), null);
});

test("the scene stands sims where they work, raises clouds, and runs cables to the APU", () => {
  const now = 1_700_000_000_000;
  const obs = {
    index: INDEX,
    status: [{ code: " M", path: "swarms/swarm_002_agent_prompt.md" }, { code: "??", path: "MARA.md" }, { code: " M", path: "construction.md" }],
    recent: [{ at: now / 1000 - 30, path: "swarms/swarm_002_agent_prompt.md" }],
    plots: 4, reports: 2,
    pain: { engine: { present: true, up: true, healthy: true, backend: "llamacpp-vulkan" }, models: [{ id: "a", loaded: true }, { id: "b", loaded: false }], gpu: 57, labRunning: 0, labRuns: [{ exit: 127 }] },
  };
  const live = { now, agents: [{ address: "t1", pane: "p1", status: "working", app: "claude-code" }, { address: "t2", pane: "p2", status: "idle", app: "opencode" }, { address: "t3", pane: "p3", status: "blocked", app: "codex" }],
    where: { t1: "swarm-2", t3: "gate" }, names: { t1: "Fix swarm 2" } };
  const sc = scene(obs, live);
  const site2 = sc.things.find((t) => t.id === "swarm-2");
  assert.equal(site2.state, "running", "a planned site touched a moment ago is under construction");
  assert.equal(sc.things.find((t) => t.id === "swarm-1").state, "complete");
  assert.equal(sc.things.find((t) => t.id === "swarm-7").state, "planned");
  const agentsOnly = sc.sims.filter((s) => s.kind === "agent");
  assert.deepEqual(agentsOnly.map((s) => [s.address, s.district]).sort(), [["t1", "swarm-2"], ["t2", "bandstand"], ["t3", "gate"]]);
  const t1 = agentsOnly.find((s) => s.address === "t1");
  assert.ok(t1.route && t1.route.period > 3000, "a working agent shuttles to the hall");
  const idle = agentsOnly.find((s) => s.address === "t2");
  assert.ok(idle.sway || idle.wander, "an idle one sways at the bandstand or forages around it");
  assert.deepEqual(sc.sims.filter((s) => s.kind === "carrier").map((s) => s.district), ["swarm-2"], "one carrier brings the recently edited brief in");
  assert.ok(sc.sims.some((s) => s.kind === "truck"), "a truck runs while a model is loaded");
  assert.ok(!sc.sims.some((s) => s.kind === "tech"), "no lab tech without a lab job");
  assert.ok(sc.sims.some((s) => s.kind === "duck") && sc.sims.filter((s) => s.kind === "crow").length === 2);
  assert.ok(sc.trails.some((t) => t.key === "swarm-2>hall") && sc.trails.some((t) => t.key === "hall>swarm-2") && sc.trails.some((t) => t.key === "depot>plant"));
  assert.deepEqual(sc.flashes.map((f) => f.district), ["swarm-2"], "a ring where the file changed moments ago");
  assert.equal(sc.stats.ants, sc.sims.length);
  assert.equal(sc.sims.find((s) => s.address === "t1").name, "Fix swarm 2");
  assert.deepEqual(sc.clouds.map((c) => [c.district, c.count]).sort(), [["hall", 1], ["swarm-2", 1]]);
  assert.ok(sc.things.some((t) => t.id === "new-mara"), "a pop-up tent beside the chalkboard for the untracked MARA.md");
  assert.equal(sc.cables.length, 1, "only the planned APU swarm is cabled; the complete one is not");
  assert.equal(sc.things.filter((t) => t.id.startsWith("crate-")).length, 2);
  assert.equal(sc.things.filter((t) => t.id.startsWith("frame-")).length, 4);
  assert.deepEqual(sc.stats.loaded, ["a"]);
  assert.ok(sc.ticker.some((l) => l.includes("GPU 57%")));
  assert.ok(sc.ticker.some((l) => l.startsWith("Weather: 2 modified, 1 new")));
  assert.ok(sc.ticker.some((l) => l.includes("exit 127")));
});

test("an empty observation still draws the campsite", () => {
  const sc = scene({}, { agents: [] });
  assert.ok(sc.things.some((t) => t.id === "hall") && sc.things.some((t) => t.id === "track-E"));
  assert.equal(sc.sims.filter((s) => s.kind === "agent").length, 0);
  assert.equal(sc.sims.length, 3, "the duck and the crows are always about");
  assert.deepEqual(sc.trails, []);
  assert.ok(sc.ticker.some((l) => l.includes("not running")));
  const sorted = sc.things.slice().sort(order);
  assert.ok(sorted.indexOf(sorted.find((t) => t.id === "track-A")) < sorted.indexOf(sorted.find((t) => t.id === "observatory")), "the ridge paints before the front");
});

test("names come from a named tab, else the title without its glyph, else the program", () => {
  const tabs = [{ id: "tb1", named: true, name: "review" }, { id: "tb2", named: false, name: "2" }];
  assert.equal(simName({ tab: "tb1", pane: "p1" }, tabs, []), "review");
  assert.equal(simName({ tab: "tb2", pane: "p2", title: "✳ Fix login" }, tabs, []), "Fix login");
  assert.equal(simName({ tab: "tb2", pane: "p3", title: "", program: { name: "Codex" } }, tabs, []), "Codex");
});

test("parsers read git status, docker ps, llama-server models, lab runs and stat lines", () => {
  assert.deepEqual(parseStatus(" M a.md\n?? b/\nR  old -> new\n"), [{ code: " M", path: "a.md" }, { code: "??", path: "b/" }, { code: "R ", path: "new" }]);
  const docker = [
    JSON.stringify({ Names: "pain-engine", Image: "ghcr.io/ggml-org/llama.cpp:server-vulkan", Status: "Up About an hour (unhealthy)", Labels: "ai.pain.backend=llamacpp-vulkan,com.docker.compose.project=pain" }),
    JSON.stringify({ Names: "lab1", Image: "pain-lab", Status: "Up 3 seconds" }),
    JSON.stringify({ Names: "lab0", Image: "pain-lab", Status: "Exited (0) 2 hours ago" }),
  ].join("\n");
  assert.deepEqual(parseDocker(docker), { engine: { present: true, up: true, healthy: false, backend: "llamacpp-vulkan", image: "ghcr.io/ggml-org/llama.cpp:server-vulkan" }, labRunning: 1 });
  assert.deepEqual(parseDocker(""), { engine: { present: false, up: false, healthy: null, backend: null, image: null }, labRunning: 0 });
  assert.deepEqual(parseModels({ data: [{ id: "x", status: { value: "loaded" } }, { id: "y", status: { value: "unloaded" } }] }), [{ id: "x", loaded: true }, { id: "y", loaded: false }]);
  const runs = parseLabRuns('{"utc":"a","command":["docker","run","--","python","train.py"],"exit_code":0}\n{"utc":"b","command":["docker","--","python","-c","x"],"exit_code":127}\n');
  assert.deepEqual(runs.map((r) => [r.exit, r.command]), [[127, "python -c x"], [0, "python train.py"]]);
  assert.deepEqual(parseRecent("10 a\n30 b c\n"), [{ at: 30, path: "b c" }, { at: 10, path: "a" }]);
});

test("sub-agents orbit their parent, worn trails come back, the clock sets the phase", () => {
  const live = { now: 1_700_000_000_000, agents: [{ address: "t1", pane: "p1", status: "working", app: "codex" }], where: { t1: "hall" },
    terminals: [{ address: "t1", state: "live", parent: null }, { address: "t2", state: "live", parent: "t1", status: "working", name: "explore" }, { address: "t3", state: "done", parent: "t1" }],
    trails: { "gate>observatory": 7 }, hour: 22 };
  const sc = scene({ index: "", status: [], recent: [] }, live);
  const subs = sc.sims.filter((s) => s.kind === "sub");
  assert.deepEqual(subs.map((s) => [s.parent, s.name, s.district]), [["t1", "explore", "hall"]]);
  assert.ok(subs[0].orbit.period > 0);
  assert.deepEqual(kids(live.terminals, "t1").map((k) => k.address), ["t2"]);
  assert.equal(sc.trails.find((t) => t.key === "gate>observatory").weight, 7);
  assert.equal(sc.phase, "night");
  assert.equal(phase(12), "day"); assert.equal(phase(18), "dusk"); assert.equal(phase(3), "night");
  assert.equal(seeded("t1"), seeded("t1"));
  assert.ok(seeded("t1") >= 0 && seeded("t1") < 1 && seeded("t1") !== seeded("t2"));
});
