// What Previews looks at: the projects under the roots and the processes on this machine.
// Side effects live here; the shapes it returns are what parse.js reads and the tests feed.
import { exec, readTextFile } from "herdr";
import { KINDS, parsePs, parseSs, instances, project, nearestLock, url } from "./parse.js";

const quiet = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };
const PRUNE = ["node_modules", ".git", "dist", "build", ".next", ".cache", "storybook-static", ".pnpm-store"];
const LOCKS = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "package-lock.json"];

// One `find` over the roots for every `.storybook` folder and every lockfile, pruning the
// trees that are never projects; then each project's package.json.
export async function scanProjects(roots, depth) {
  const or = (names, test) => names.flatMap((n, i) => [...(i ? ["-o"] : []), ...test(n)]);
  const args = [...roots, "-maxdepth", String(depth), "(", ...or(PRUNE, (n) => ["-name", n]), ")", "-prune", "-o",
    "(", "(", "-type", "d", "-name", ".storybook", ")", "-o", "(", "-type", "f", "(", ...or(LOCKS, (n) => ["-name", n]), ")", ")", ")", "-print"];
  const r = await quiet(() => exec("find", args), { stdout: "" });
  const dirs = [], lockDirs = {};
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const i = line.lastIndexOf("/");
    const parent = line.slice(0, i), name = line.slice(i + 1);
    if (name === ".storybook") dirs.push(parent);
    else (lockDirs[parent] ??= []).push(name);
  }
  const out = [];
  for (const dir of dirs.sort()) {
    const pkg = await quiet(async () => JSON.parse((await readTextFile(`${dir}/package.json`)) ?? "null"), null);
    out.push(project({ dir, pkg, lockfiles: nearestLock(dir, lockDirs), roots }));
  }
  return out;
}

// Every preview server running now, with its working directory from /proc, and every
// listening socket (for the ports stopped projects would want).
export async function observeRunning() {
  const ps = await quiet(() => exec("ps", ["-eo", "pid=,ppid=,etimes=,args="]), { stdout: "" });
  const ss = await quiet(() => exec("ss", ["-ltnpH"]), { stdout: "" });
  const processes = parsePs(ps.stdout), sockets = parseSs(ss.stdout);
  const found = instances(processes, sockets);
  const cwds = {};
  if (found.length) {
    const r = await quiet(() => exec("sh", ["-c", 'for p in "$@"; do printf "%s %s\\n" "$p" "$(readlink /proc/$p/cwd 2>/dev/null)"; done', "sh", ...found.map((i) => String(i.pid))]), { stdout: "" });
    for (const line of r.stdout.split("\n")) { const m = /^(\d+) (.+)$/.exec(line); if (m) cwds[+m[1]] = m[2]; }
  }
  return { instances: instances(processes, sockets, cwds), sockets, at: Date.now() };
}

// Is it serving yet: Storybook's index (and how many stories it lists), any page for the
// rest. curl bounds the wait and needs no network capability; `within` bounds the rest.
export async function probe(inst, within = (p) => p) {
  const target = `${url(inst.host, inst.port)}${KINDS[inst.kind].path.slice(1)}`;
  const r = await quiet(() => within(exec("curl", ["-s", "-m", "2", "-o", "-", "-w", "\n%{http_code}", target])), null);
  if (!r || r.code !== 0) return { ready: false, stories: null };
  const i = r.stdout.lastIndexOf("\n");
  const code = parseInt(r.stdout.slice(i + 1), 10), body = r.stdout.slice(0, i);
  let stories = null;
  if (inst.kind === "storybook" && code === 200) {
    const j = await quiet(async () => JSON.parse(body), null);
    const entries = j?.entries ?? j?.stories;
    if (entries) stories = Object.values(entries).filter((e) => e?.type !== "docs").length;
  }
  return { ready: code === 200, stories };
}
