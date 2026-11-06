// What the Commons looks at: the research repo and the pain stack. Side effects live here;
// the shapes it returns are what world.js reads and the tests feed it.
import { exec, readTextFile } from "herdr";
import { parseStatus, parseDocker, parseModels, parseLabRuns, parseRecent } from "./parse.js";

const quiet = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };

export async function observeRepo(repo) {
  const index = await quiet(() => readTextFile(`${repo}/swarms/SWARM_INDEX.md`), null);
  const st = await quiet(() => exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1"], { cwd: repo }), { code: 1, stdout: "" });
  const rec = await quiet(() => exec("sh", ["-c", 'git ls-files -m -o --exclude-standard -z | xargs -0 -r stat -c "%Y %n" 2>/dev/null | sort -rn | head -20'], { cwd: repo }), { stdout: "" });
  const counts = await quiet(() => exec("sh", ["-c", "find swarms/reports -name '*.png' 2>/dev/null | wc -l; find swarms/reports -maxdepth 1 -name '*.md' 2>/dev/null | wc -l"], { cwd: repo }), { stdout: "0\n0" });
  const [plots, reports] = counts.stdout.trim().split("\n").map((n) => parseInt(n, 10) || 0);
  return { index, status: st.code === 0 ? parseStatus(st.stdout) : [], recent: parseRecent(rec.stdout), plots, reports, at: Date.now() };
}

// llama-server answers on localhost; curl bounds the wait (it loads models for a while) and
// needs no network capability. `within` bounds the fetch fallback the same way.
async function get(url, within) {
  const r = await quiet(() => exec("curl", ["-s", "-m", "3", url]), { code: 127, stdout: "" });
  if (r.code === 0) return { ok: true, text: r.stdout };
  if (r.code !== 127) return null;
  const f = await quiet(() => within(fetch(url)), null);
  return f ? { ok: f.ok, text: await quiet(() => f.text(), "") } : null;
}

// `within`: bounds a request that may hang.
export async function observePain({ root, port }, within = (p) => p) {
  const ps = await quiet(() => exec("docker", ["ps", "-a", "--format", "{{json .}}"]), { stdout: "" });
  const { engine, labRunning } = parseDocker(ps.stdout);
  if (!engine.backend) engine.backend = ((await quiet(() => readTextFile(`${root}/.state/backend`), null)) ?? "").trim() || null;
  let models = [];
  if (engine.up) {
    const health = await get(`http://127.0.0.1:${port}/health`, within);
    if (health) engine.healthy = health.ok && /"ok"/.test(health.text);
    const list = await get(`http://127.0.0.1:${port}/models`, within);
    if (list?.ok) models = parseModels(await quiet(async () => JSON.parse(list.text), null));
  }
  const gpu = await quiet(() => exec("sh", ["-c", "cat /sys/class/drm/card*/device/gpu_busy_percent 2>/dev/null | head -1"]), { stdout: "" });
  const runs = await quiet(() => exec("tail", ["-n", "8", `${root}/experiments/lab_runs.jsonl`]), { stdout: "" });
  const busy = parseInt(gpu.stdout.trim(), 10);
  return { engine, models, gpu: Number.isFinite(busy) ? busy : null, labRunning, labRuns: parseLabRuns(runs.stdout) };
}
